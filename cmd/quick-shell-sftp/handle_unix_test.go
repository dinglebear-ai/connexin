//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// The bulk lanes carry no framing, so a rejected upload must not leave its
// payload where the next upload will read it as its own body.
//
// This test deliberately wires the upload lane the way production does -- a raw
// blocking descriptor wrapped by inheritedFile -- instead of the os.Pipe halves
// the other tests inject. That distinction is the whole point: os.Pipe returns a
// pollable file, so SetReadDeadline succeeds and the drain runs, while an
// inherited blocking descriptor is unpollable, which made the drain skip itself
// and return as though it had worked. The suite stayed green against the more
// capable double while real transfers spliced a rejected payload onto the head
// of the next upload.
func TestRejectedUploadDoesNotCorruptTheNextUpload(t *testing.T) {
	h, root, _ := newTestHandler(t)

	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	reader := inheritedFile(fds[0], "upload")
	writer := os.NewFile(uintptr(fds[1]), "upload-write")
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	h.uploadPipe = reader

	if err := reader.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("inherited upload lane is not pollable, so no drain can be bounded: %v", err)
	}
	_ = reader.SetReadDeadline(time.Time{})

	writeFile(t, filepath.Join(root, "target.bin"), "original")

	// A rejected overwrite. The client streams the body as soon as it sends the
	// request, so these bytes are already in the lane when the handler says no.
	rejected := "REJECTED-PAYLOAD-SHOULD-NEVER-LAND-xxxxx"
	go func() { _, _ = writer.WriteString(rejected) }()
	params := fmt.Sprintf(`{"path":"target.bin","bytes":%d,"overwrite":false}`, len(rejected))
	if _, err := call(t, h, "upload", params); err == nil {
		t.Fatal("upload onto an existing path was accepted without overwrite")
	}
	if h.desynced {
		t.Fatal("drain did not resync the lane after a rejected upload")
	}

	// The next upload must see its own bytes, not the tail of the rejected one.
	accepted := "atomic-overwrite-marker"
	go func() { _, _ = writer.WriteString(accepted) }()
	params = fmt.Sprintf(`{"path":"target.bin","bytes":%d,"overwrite":true}`, len(accepted))
	if _, err := call(t, h, "upload", params); err != nil {
		t.Fatalf("overwrite upload: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "target.bin")); got != accepted {
		t.Fatalf("next upload read stale bytes from the lane: got %q, want %q", got, accepted)
	}
}

// A download that exceeds maxBytes must reject before putting anything on the
// lane; otherwise the oversized payload becomes the head of the next download.
func TestOversizedDownloadWritesNothingToTheLane(t *testing.T) {
	h, root, _ := newTestHandler(t)

	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	reader := os.NewFile(uintptr(fds[0]), "download-read")
	writer := inheritedFile(fds[1], "download")
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	h.downloadPipe = writer

	writeFile(t, filepath.Join(root, "big.bin"), "0123456789")
	if _, err := call(t, h, "download", `{"path":"big.bin","maxBytes":4}`); err == nil {
		t.Fatal("oversized download reported success")
	}
	if h.desynced {
		t.Fatal("oversized download should be rejected before touching the lane")
	}

	// Nothing should be readable: a lane with bytes on it would satisfy this read.
	if err := reader.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Skipf("cannot bound the read: %v", err)
	}
	buf := make([]byte, 1)
	if n, err := reader.Read(buf); n > 0 || err == nil {
		t.Fatalf("oversized download left %d byte(s) on the lane (err=%v)", n, err)
	}
}
