package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

// A dropped SSH connection makes pkg/sftp fail in-flight requests with io.EOF.
// The mutation handlers used to return {"ok": true} alongside that error, and
// serve() treated any io.EOF as a graceful close and encoded the payload with
// no error code -- so a delete that never happened was reported as completed,
// including in the audit log.
func TestMutationsReportConnectionDropAsError(t *testing.T) {
	for _, testCase := range []struct {
		action string
		params string
		setup  func(root string)
	}{
		{action: "mkdir", params: `{"path":"newdir"}`},
		{
			action: "remove",
			params: `{"path":"doomed.txt","directory":false}`,
			setup:  func(root string) {},
		},
		{
			action: "rename",
			params: `{"from":"a.txt","to":"b.txt","overwrite":false}`,
		},
	} {
		t.Run(testCase.action, func(t *testing.T) {
			h, root, closeConn := newTestHandler(t)
			writeFile(t, root+"/doomed.txt", "still here")
			writeFile(t, root+"/a.txt", "content")

			// Drop the connection before issuing the mutation.
			closeConn()

			data, err := h.handle(context.Background(), request{
				Version: 1, ID: 1, Action: testCase.action,
				Params: json.RawMessage(testCase.params),
			})

			if err == nil {
				t.Fatalf("%s reported success against a dropped connection", testCase.action)
			}
			if data != nil {
				t.Fatalf("%s returned a payload alongside an error: %#v", testCase.action, data)
			}

			// The response the operator and the audit log see must carry a code.
			res := encodeThrough(t, h, request{
				Version: 1, ID: 1, Action: testCase.action,
				Params: json.RawMessage(testCase.params),
			})
			if res.Code == "" {
				t.Fatalf("%s encoded no error code: %#v", testCase.action, res)
			}
			if res.Data != nil {
				t.Fatalf("%s encoded data with an error: %#v", testCase.action, res)
			}
		})
	}
}

// io.EOF must no longer be special-cased. The "close" action that relied on it
// was dead code with no callers, and the branch serving it swallowed the code.
func TestServeEncodesEofAsAnError(t *testing.T) {
	h, _, closeConn := newTestHandler(t)
	closeConn()

	input := strings.NewReader(`{"version":1,"id":1,"action":"remove","params":{"path":"x","directory":false}}` + "\n")
	var output bytes.Buffer
	if err := serveWithHandler(h, input, &output); err != nil {
		t.Fatalf("serve returned: %v", err)
	}

	var res response
	if err := json.Unmarshal(output.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v (%q)", err, output.String())
	}
	if res.Code == "" {
		t.Fatalf("expected an error code, got %#v", res)
	}
	if res.Data != nil {
		t.Fatalf("expected no data payload, got %#v", res.Data)
	}
}

func TestUnsupportedActionIsRejected(t *testing.T) {
	h, _, _ := newTestHandler(t)
	_, err := h.handle(context.Background(), request{
		Version: 1, ID: 1, Action: "close", Params: json.RawMessage(`{}`),
	})
	// "close" was removed; it must now be rejected like any other unknown verb
	// rather than returning a success payload with io.EOF.
	if err == nil || !strings.Contains(err.Error(), "unsupported_action") {
		t.Fatalf("expected unsupported_action, got %v", err)
	}
	if errors.Is(err, io.EOF) {
		t.Fatalf("close must not resolve to io.EOF any more")
	}
}

// encodeThrough runs one request through the same encoding serve() applies, so
// tests assert on the bytes the TypeScript side actually receives.
func encodeThrough(t *testing.T, h *handler, req request) response {
	t.Helper()
	line, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	var output bytes.Buffer
	if err := serveWithHandler(h, bytes.NewReader(append(line, '\n')), &output); err != nil {
		t.Fatalf("serve: %v", err)
	}
	var res response
	if err := json.Unmarshal(output.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v (%q)", err, output.String())
	}
	return res
}

// An oversize control line must be rejected as invalid_request without killing
// the loop: one bad frame cannot be allowed to take the helper down mid-session.
func TestServeRejectsOversizeLineAndKeepsGoing(t *testing.T) {
	h, root, _ := newTestHandler(t)
	writeFile(t, root+"/after.txt", "ok")

	oversize := `{"version":1,"id":1,"action":"list","params":{"path":"` +
		strings.Repeat("A", maxControlLine) + `","limit":10}}`
	input := strings.NewReader(
		oversize + "\n" +
			`{"version":1,"id":2,"action":"lstat","params":{"path":"after.txt"}}` + "\n",
	)

	var output bytes.Buffer
	if err := serveWithHandler(h, input, &output); err != nil {
		t.Fatalf("serve aborted: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 responses, got %d: %q", len(lines), output.String())
	}

	var first response
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Code != "invalid_request" {
		t.Fatalf("first response = %#v", first)
	}

	// The request after the bad frame must still be served.
	var second response
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if second.Code != "" || second.ID != 2 {
		t.Fatalf("second response = %#v", second)
	}
}

func TestServeRejectsMalformedEnvelope(t *testing.T) {
	h, _, _ := newTestHandler(t)
	input := strings.NewReader("{not json\n")
	var output bytes.Buffer
	if err := serveWithHandler(h, input, &output); err != nil {
		t.Fatalf("serve aborted: %v", err)
	}
	var res response
	if err := json.Unmarshal(output.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Code != "invalid_request" {
		t.Fatalf("res = %#v", res)
	}
}
