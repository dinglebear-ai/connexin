package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

const protocolVersion = 1
const maxControlLine = 256 * 1024

// Bounded so a writer that stopped early cannot hang the helper.
const drainTimeout = 5 * time.Second

type request struct {
	Version int             `json:"version"`
	ID      uint64          `json:"id"`
	Action  string          `json:"action"`
	Params  json.RawMessage `json:"params"`
}

type response struct {
	Version int    `json:"version"`
	ID      uint64 `json:"id"`
	Data    any    `json:"data,omitempty"`
	Code    string `json:"code,omitempty"`
}

type fileEntry struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	Mode     uint32 `json:"mode"`
}

type handler struct {
	client *sftp.Client
	root   string
	// Bulk payload pipes. Nil means the fds inherited from the parent (3 for
	// upload, 4 for download); tests substitute their own so the transfer paths
	// are reachable without inheriting real descriptors.
	uploadPipe   *os.File
	downloadPipe *os.File
}

func (h *handler) upload() *os.File {
	if h.uploadPipe != nil {
		return h.uploadPipe
	}
	return os.NewFile(3, "upload")
}

func (h *handler) download() *os.File {
	if h.downloadPipe != nil {
		return h.downloadPipe
	}
	return os.NewFile(4, "download")
}

func decodeRequest(line []byte) (request, error) {
	var req request
	if len(line) == 0 || len(line) > maxControlLine {
		return req, errors.New("invalid_request")
	}
	if err := json.Unmarshal(line, &req); err != nil || req.Version != protocolVersion || req.ID == 0 || req.Action == "" {
		return request{}, errors.New("invalid_request")
	}
	return req, nil
}

func stableCode(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, os.ErrNotExist) {
		return "not_found"
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission_denied"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "operation_failed"
}

func decodeParams[T any](raw json.RawMessage) (T, error) {
	var value T
	if len(raw) == 0 {
		raw = []byte(`{}`)
	}
	err := json.Unmarshal(raw, &value)
	return value, err
}

func kind(info os.FileInfo) string {
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	if info.IsDir() {
		return "directory"
	}
	if info.Mode().IsRegular() {
		return "file"
	}
	return "other"
}

func (h *handler) handle(ctx context.Context, req request) (any, error) {
	switch req.Action {
	case "hello":
		return map[string]any{"protocol": protocolVersion}, nil
	case "root":
		return map[string]string{"path": h.root}, nil
	case "list":
		params, err := decodeParams[struct {
			Path  string `json:"path"`
			Limit int    `json:"limit"`
		}](req.Params)
		if err != nil || params.Limit < 1 || params.Limit > 10000 {
			return nil, errors.New("invalid_request")
		}
		entries, err := h.client.ReadDirContext(ctx, params.Path)
		if err != nil {
			return nil, err
		}
		if len(entries) > params.Limit {
			entries = entries[:params.Limit]
		}
		out := make([]fileEntry, 0, len(entries))
		for _, entry := range entries {
			out = append(out, fileEntry{Name: entry.Name(), Kind: kind(entry), Size: entry.Size(), Modified: entry.ModTime().UnixMilli(), Mode: uint32(entry.Mode())})
		}
		return map[string]any{"entries": out}, nil
	case "lstat":
		params, err := decodeParams[struct {
			Path string `json:"path"`
		}](req.Params)
		if err != nil {
			return nil, errors.New("invalid_request")
		}
		entry, err := h.client.Lstat(params.Path)
		if err != nil {
			return nil, err
		}
		return fileEntry{Name: path.Base(params.Path), Kind: kind(entry), Size: entry.Size(), Modified: entry.ModTime().UnixMilli(), Mode: uint32(entry.Mode())}, nil
	case "realpath":
		params, err := decodeParams[struct {
			Path string `json:"path"`
		}](req.Params)
		if err != nil {
			return nil, errors.New("invalid_request")
		}
		value, err := h.client.RealPath(params.Path)
		if err != nil {
			return nil, err
		}
		return map[string]string{"path": value}, nil
	case "mkdir":
		params, err := decodeParams[struct {
			Path string `json:"path"`
		}](req.Params)
		if err != nil {
			return nil, errors.New("invalid_request")
		}
		if err := h.client.Mkdir(params.Path); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	case "rename":
		params, err := decodeParams[struct {
			From      string `json:"from"`
			To        string `json:"to"`
			Overwrite bool   `json:"overwrite"`
		}](req.Params)
		if err != nil {
			return nil, errors.New("invalid_request")
		}
		if params.Overwrite {
			err = h.client.PosixRename(params.From, params.To)
		} else {
			err = h.client.Rename(params.From, params.To)
		}
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	case "remove":
		params, err := decodeParams[struct {
			Path      string `json:"path"`
			Directory bool   `json:"directory"`
		}](req.Params)
		if err != nil {
			return nil, errors.New("invalid_request")
		}
		if params.Directory {
			err = h.client.RemoveDirectory(params.Path)
		} else {
			err = h.client.Remove(params.Path)
		}
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	case "upload":
		params, err := decodeParams[struct {
			Path      string `json:"path"`
			Bytes     int64  `json:"bytes"`
			Overwrite bool   `json:"overwrite"`
		}](req.Params)
		if err != nil || params.Bytes < 0 {
			return nil, errors.New("invalid_request")
		}
		fd := h.upload()
		if fd == nil {
			return nil, errors.New("transfer_unavailable")
		}
		// Every early return below leaves the declared payload sitting in the
		// shared upload pipe. The TypeScript side now recycles the helper after
		// any unclean transfer, so those bytes cannot reach the next one, but
		// drain anyway as defense in depth. The deadline matters: the writer
		// may have stopped early, so an unbounded drain would hang the helper.
		consumed := int64(0)
		defer func() {
			remaining := params.Bytes - consumed
			if remaining <= 0 {
				return
			}
			if err := fd.SetReadDeadline(time.Now().Add(drainTimeout)); err != nil {
				return
			}
			_, _ = io.CopyN(io.Discard, fd, remaining)
			_ = fd.SetReadDeadline(time.Time{})
		}()
		if info, statErr := h.client.Lstat(params.Path); statErr == nil {
			if !params.Overwrite || info.Mode()&os.ModeSymlink != 0 || info.IsDir() {
				return nil, errors.New("already_exists")
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return nil, statErr
		}
		tempPath, err := siblingTempPath(params.Path)
		if err != nil {
			return nil, err
		}
		file, err := h.client.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
		if err != nil {
			return nil, err
		}
		committed := false
		defer func() {
			if !committed {
				_ = h.client.Remove(tempPath)
			}
		}()
		if err := file.Chmod(0o600); err != nil {
			_ = file.Close()
			return nil, err
		}
		n, err := io.CopyN(file, fd, params.Bytes)
		consumed = n
		if err != nil {
			_ = file.Close()
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		if params.Overwrite {
			err = h.client.PosixRename(tempPath, params.Path)
		} else {
			err = h.client.Rename(tempPath, params.Path)
		}
		if err != nil {
			return nil, err
		}
		committed = true
		return map[string]int64{"bytes": n}, nil
	case "download":
		params, err := decodeParams[struct {
			Path     string `json:"path"`
			MaxBytes int64  `json:"maxBytes"`
		}](req.Params)
		if err != nil || params.MaxBytes < 0 {
			return nil, errors.New("invalid_request")
		}
		fd := h.download()
		if fd == nil {
			return nil, errors.New("transfer_unavailable")
		}
		file, err := h.client.Open(params.Path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		n, err := io.Copy(fd, io.LimitReader(file, params.MaxBytes+1))
		if err != nil {
			return nil, err
		}
		if n > params.MaxBytes {
			return nil, errors.New("too_large")
		}
		return map[string]int64{"bytes": n}, nil
	default:
		return nil, errors.New("unsupported_action")
	}
}

func serve(client *sftp.Client, input io.Reader, output io.Writer) error {
	root, err := client.RealPath(".")
	if err != nil {
		return err
	}
	return serveWithHandler(&handler{client: client, root: root}, input, output)
}

// serveWithHandler is the request loop, split out so tests can drive it with a
// handler bound to an in-process sftp server.
func serveWithHandler(h *handler, input io.Reader, output io.Writer) error {
	reader := bufio.NewReaderSize(input, 4096)
	encoder := json.NewEncoder(output)
	for {
		line, err := readControlLine(reader)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			if !errors.Is(err, errLineTooLong) {
				return err
			}
			// An overlong frame is rejected on its own; the rest of the line was
			// discarded, so the session continues with the next one. Using a
			// bufio.Scanner here meant one bad frame killed the helper outright,
			// because a Scanner cannot resume after ErrTooLong.
			_ = encoder.Encode(response{Version: protocolVersion, Code: "invalid_request"})
			continue
		}
		req, decodeErr := decodeRequest(line)
		if decodeErr != nil {
			_ = encoder.Encode(response{Version: protocolVersion, Code: "invalid_request"})
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		data, callErr := h.handle(ctx, req)
		cancel()
		res := response{Version: protocolVersion, ID: req.ID, Data: data}
		if callErr != nil {
			res.Data = nil
			res.Code = stableCode(callErr)
			if strings.Contains(callErr.Error(), "unsupported_action") {
				res.Code = "unsupported_action"
			}
			if strings.Contains(callErr.Error(), "invalid_request") {
				res.Code = "invalid_request"
			}
			if strings.Contains(callErr.Error(), "too_large") {
				res.Code = "too_large"
			}
			if strings.Contains(callErr.Error(), "already_exists") {
				res.Code = "already_exists"
			}
		}
		if err := encoder.Encode(res); err != nil {
			return err
		}
	}
}

var errLineTooLong = errors.New("control line too long")

// readControlLine returns one newline-delimited frame, capped at
// maxControlLine. On an overlong frame it discards the remainder of the line so
// the caller can reject just that frame and keep serving.
func readControlLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		if len(line)+len(chunk) > maxControlLine {
			// Drain the rest of this line before handing control back.
			for isPrefix {
				_, isPrefix, err = reader.ReadLine()
				if err != nil {
					return nil, err
				}
			}
			return nil, errLineTooLong
		}
		line = append(line, chunk...)
		if !isPrefix {
			return line, nil
		}
	}
}

func usageError(message string) error { return fmt.Errorf("quick-shell-sftp: %s", message) }

func siblingTempPath(target string) (string, error) {
	var suffix [12]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	return path.Join(path.Dir(target), fmt.Sprintf(".%s.quick-shell-%x", path.Base(target), suffix[:])), nil
}
