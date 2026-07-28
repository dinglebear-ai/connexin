package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func call(t *testing.T, h *handler, action, params string) (any, error) {
	t.Helper()
	return h.handle(context.Background(), request{
		Version: 1, ID: 1, Action: action, Params: json.RawMessage(params),
	})
}

func mustCall(t *testing.T, h *handler, action, params string) any {
	t.Helper()
	data, err := call(t, h, action, params)
	if err != nil {
		t.Fatalf("%s: %v", action, err)
	}
	return data
}

func TestHelloAndRoot(t *testing.T) {
	h, root, _ := newTestHandler(t)

	hello := mustCall(t, h, "hello", `{}`).(map[string]any)
	if hello["protocol"] != protocolVersion {
		t.Fatalf("protocol = %v", hello["protocol"])
	}
	if got := mustCall(t, h, "root", `{}`).(map[string]string)["path"]; got != root {
		t.Fatalf("root = %q want %q", got, root)
	}
}

func TestListClassifiesEntriesAndHonoursLimit(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root+"/regular.txt", "abc")
	if err := os.Mkdir(root+"/sub", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root+"/regular.txt", root+"/link"); err != nil {
		t.Fatal(err)
	}

	out := mustCall(t, h, "list", `{"path":".","limit":100}`).(map[string]any)
	byName := map[string]fileEntry{}
	for _, entry := range out["entries"].([]fileEntry) {
		byName[entry.Name] = entry
	}
	if byName["regular.txt"].Kind != "file" || byName["regular.txt"].Size != 3 {
		t.Fatalf("regular.txt = %+v", byName["regular.txt"])
	}
	if byName["sub"].Kind != "directory" {
		t.Fatalf("sub = %+v", byName["sub"])
	}
	// Listing must not follow the link; a symlink is reported as a symlink.
	if byName["link"].Kind != "symlink" {
		t.Fatalf("link = %+v", byName["link"])
	}

	limited := mustCall(t, h, "list", `{"path":".","limit":1}`).(map[string]any)
	if got := len(limited["entries"].([]fileEntry)); got != 1 {
		t.Fatalf("limit ignored: %d entries", got)
	}

	for _, bad := range []string{`{"path":".","limit":0}`, `{"path":".","limit":10001}`} {
		if _, err := call(t, h, "list", bad); err == nil {
			t.Fatalf("accepted out-of-range limit %s", bad)
		}
	}
}

func TestLstatAndRealpath(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root+"/a.txt", "hello")

	entry := mustCall(t, h, "lstat", `{"path":"a.txt"}`).(fileEntry)
	if entry.Kind != "file" || entry.Size != 5 || entry.Name != "a.txt" {
		t.Fatalf("lstat = %+v", entry)
	}
	if _, err := call(t, h, "lstat", `{"path":"missing.txt"}`); err == nil {
		t.Fatal("lstat accepted a missing path")
	}
	if got := mustCall(t, h, "realpath", `{"path":"."}`).(map[string]string)["path"]; got != root {
		t.Fatalf("realpath = %q want %q", got, root)
	}
}

func TestMkdirRenameRemove(t *testing.T) {
	h, root, _ := newTestHandler(t)

	mustCall(t, h, "mkdir", `{"path":"fresh"}`)
	if info, err := os.Stat(root + "/fresh"); err != nil || !info.IsDir() {
		t.Fatalf("mkdir did not create a directory: %v", err)
	}

	writeFile(t, root+"/from.txt", "payload")
	mustCall(t, h, "rename", `{"from":"from.txt","to":"to.txt","overwrite":false}`)
	if readFile(t, root+"/to.txt") != "payload" {
		t.Fatal("rename lost content")
	}

	mustCall(t, h, "remove", `{"path":"to.txt","directory":false}`)
	if _, err := os.Lstat(root + "/to.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remove left the file: %v", err)
	}

	mustCall(t, h, "remove", `{"path":"fresh","directory":true}`)
	if _, err := os.Lstat(root + "/fresh"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remove left the directory: %v", err)
	}
}

// The atomic-commit defer is the only thing preventing a stray
// .<name>.quick-shell-<hex> file in the parent directory after a failed upload.
func TestFailedUploadLeavesNoTempFile(t *testing.T) {
	h, root, _ := newTestHandler(t)

	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	h.uploadPipe = reader
	// Declare more bytes than we ever write, then close: CopyN fails short.
	go func() {
		_, _ = writer.WriteString("short")
		_ = writer.Close()
	}()

	if _, err := call(t, h, "upload", `{"path":"target.bin","bytes":4096,"overwrite":false}`); err == nil {
		t.Fatal("short upload reported success")
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "quick-shell-") {
			t.Fatalf("failed upload left a temp file: %s", entry.Name())
		}
	}
	if _, err := os.Lstat(root + "/target.bin"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed upload created the target")
	}
}

// Uploading onto a symlink or a directory must be refused outright: following
// the link would let a remote-controlled path clobber a file outside the tree.
func TestUploadRefusesSymlinkAndDirectoryTargets(t *testing.T) {
	for _, testCase := range []struct{ name, params string }{
		{name: "symlink", params: `{"path":"link","bytes":5,"overwrite":true}`},
		{name: "directory", params: `{"path":"dir","bytes":5,"overwrite":true}`},
		{name: "existing file without overwrite", params: `{"path":"existing.txt","bytes":5,"overwrite":false}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h, root, _ := newTestHandler(t)
			writeFile(t, root+"/secret.txt", "ORIGINAL")
			writeFile(t, root+"/existing.txt", "ORIGINAL")
			if err := os.Symlink(root+"/secret.txt", root+"/link"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(root+"/dir", 0o755); err != nil {
				t.Fatal(err)
			}

			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			h.uploadPipe = reader
			go func() {
				_, _ = writer.WriteString("XXXXX")
				_ = writer.Close()
			}()

			_, callErr := call(t, h, "upload", testCase.params)
			if callErr == nil {
				t.Fatal("upload was allowed")
			}
			if !strings.Contains(callErr.Error(), "already_exists") {
				t.Fatalf("unexpected error: %v", callErr)
			}
			// The symlink target must be untouched, byte for byte.
			if got := readFile(t, root+"/secret.txt"); got != "ORIGINAL" {
				t.Fatalf("symlink target was written through: %q", got)
			}
			if got := readFile(t, root+"/existing.txt"); got != "ORIGINAL" {
				t.Fatalf("existing file was overwritten: %q", got)
			}
		})
	}
}

func TestUploadCommitsAtomically(t *testing.T) {
	h, root, _ := newTestHandler(t)
	payload := "committed-content"

	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	h.uploadPipe = reader
	go func() {
		_, _ = writer.WriteString(payload)
		_ = writer.Close()
	}()

	data := mustCall(t, h, "upload",
		`{"path":"out.bin","bytes":`+strconv.Itoa(len(payload))+`,"overwrite":false}`)
	if got := data.(map[string]int64)["bytes"]; got != int64(len(payload)) {
		t.Fatalf("bytes = %d", got)
	}
	if got := readFile(t, root+"/out.bin"); got != payload {
		t.Fatalf("content = %q", got)
	}
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "quick-shell-") {
			t.Fatalf("temp file survived a successful upload: %s", entry.Name())
		}
	}
}

// The `+1` in io.LimitReader(file, MaxBytes+1) IS the size cap: without it an
// oversize file would be silently truncated instead of rejected.
func TestDownloadSizeCapBoundary(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		contents string
		maxBytes int
		wantErr  bool
	}{
		{name: "exactly at the cap", contents: "12345", maxBytes: 5},
		{name: "one byte over", contents: "123456", maxBytes: 5, wantErr: true},
		{name: "under the cap", contents: "123", maxBytes: 5},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h, root, _ := newTestHandler(t)
			writeFile(t, root+"/payload.bin", testCase.contents)

			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			h.downloadPipe = writer
			done := make(chan string, 1)
			go func() {
				buf := make([]byte, 64)
				n, _ := reader.Read(buf)
				done <- string(buf[:n])
			}()

			data, callErr := call(t, h, "download",
				`{"path":"payload.bin","maxBytes":`+strconv.Itoa(testCase.maxBytes)+`}`)
			_ = writer.Close()

			if testCase.wantErr {
				if callErr == nil || !strings.Contains(callErr.Error(), "too_large") {
					t.Fatalf("expected too_large, got %v", callErr)
				}
				return
			}
			if callErr != nil {
				t.Fatalf("download failed: %v", callErr)
			}
			if got := data.(map[string]int64)["bytes"]; got != int64(len(testCase.contents)) {
				t.Fatalf("bytes = %d want %d", got, len(testCase.contents))
			}
			if got := <-done; got != testCase.contents {
				t.Fatalf("payload = %q want %q", got, testCase.contents)
			}
		})
	}
}

func TestStableCodeMapsErrorsWithoutLeakingPaths(t *testing.T) {
	if got := stableCode(nil); got != "" {
		t.Fatalf("nil = %q", got)
	}
	for _, testCase := range []struct {
		err  error
		want string
	}{
		{err: os.ErrNotExist, want: "not_found"},
		{err: os.ErrPermission, want: "permission_denied"},
		{err: context.DeadlineExceeded, want: "timeout"},
		{err: errors.New("some remote detail"), want: "operation_failed"},
	} {
		if got := stableCode(testCase.err); got != testCase.want {
			t.Fatalf("stableCode(%v) = %q want %q", testCase.err, got, testCase.want)
		}
	}

	// A real remote failure must not surface the absolute path or username.
	h, root, _ := newTestHandler(t)
	secret := filepath.Join(root, "does-not-exist-"+"deadbeef")
	_, err := call(t, h, "lstat", `{"path":"`+filepath.Base(secret)+`"}`)
	if err == nil {
		t.Fatal("expected an error")
	}
	if code := stableCode(err); strings.Contains(code, root) || strings.Contains(code, "/") {
		t.Fatalf("code leaked a path: %q", code)
	}
}

func TestKindClassification(t *testing.T) {
	_, root, _ := newTestHandler(t)
	writeFile(t, root+"/f", "x")
	if err := os.Mkdir(root+"/d", 0o755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(root + "/f")
	if err != nil {
		t.Fatal(err)
	}
	if kind(info) != "file" {
		t.Fatalf("file = %q", kind(info))
	}
	dirInfo, err := os.Lstat(root + "/d")
	if err != nil {
		t.Fatal(err)
	}
	if kind(dirInfo) != "directory" {
		t.Fatalf("dir = %q", kind(dirInfo))
	}
}

func TestSiblingTempPathStaysInParentAndIsUnique(t *testing.T) {
	first, err := siblingTempPath("/srv/data/report.csv")
	if err != nil {
		t.Fatal(err)
	}
	second, err := siblingTempPath("/srv/data/report.csv")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(first) != "/srv/data" {
		t.Fatalf("temp escaped the parent directory: %s", first)
	}
	if !strings.Contains(filepath.Base(first), ".quick-shell-") {
		t.Fatalf("unexpected temp name: %s", first)
	}
	if first == second {
		t.Fatal("temp paths collide; concurrent uploads would race")
	}
}
