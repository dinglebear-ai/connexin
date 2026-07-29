package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
)

// pipeConn adapts a read half and a write half into the io.ReadWriteCloser
// sftp.NewServer expects.
type pipeConn struct {
	io.Reader
	io.WriteCloser
}

// newTestHandler stands up an in-process sftp server rooted at a fresh temp
// directory and returns a handler wired to a client for it, mirroring how the
// real helper talks to a remote host. `closeConn` drops the connection so tests
// can exercise the error paths that a dropped SSH link produces.
func newTestHandler(t *testing.T) (h *handler, root string, closeConn func()) {
	t.Helper()

	root = t.TempDir()
	// macOS temp dirs are symlinked via /var; resolve so RealPath comparisons
	// in the handler line up with the paths tests build.
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}

	clientRead, serverWrite := io.Pipe()
	serverRead, clientWrite := io.Pipe()

	server, err := sftp.NewServer(
		pipeConn{Reader: serverRead, WriteCloser: serverWrite},
		sftp.WithServerWorkingDirectory(root),
	)
	if err != nil {
		t.Fatalf("sftp.NewServer: %v", err)
	}
	served := make(chan struct{})
	go func() {
		defer close(served)
		_ = server.Serve()
	}()

	client, err := sftp.NewClientPipe(clientRead, clientWrite)
	if err != nil {
		t.Fatalf("sftp.NewClientPipe: %v", err)
	}

	realRoot, err := client.RealPath(".")
	if err != nil {
		t.Fatalf("RealPath: %v", err)
	}

	h = &handler{client: client, root: realRoot}

	var closed bool
	closeConn = func() {
		if closed {
			return
		}
		closed = true
		// Closing the client's write half tears down the server, which makes
		// pkg/sftp broadcast io.EOF to every in-flight and subsequent request.
		_ = clientWrite.Close()
		_ = server.Close()
		<-served
	}
	t.Cleanup(func() {
		closeConn()
		_ = client.Close()
	})

	return h, realRoot, closeConn
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
