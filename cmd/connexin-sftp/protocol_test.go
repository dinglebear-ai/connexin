package main

import "testing"

func TestDecodeRequest(t *testing.T) {
	req, err := decodeRequest([]byte(`{"version":1,"id":7,"action":"hello","params":{}}`))
	if err != nil || req.ID != 7 || req.Action != "hello" {
		t.Fatalf("unexpected request: %#v %v", req, err)
	}
}

func TestDecodeRequestRejectsInvalidEnvelope(t *testing.T) {
	for _, input := range []string{`{`, `{"version":2,"id":1,"action":"hello"}`, `{"version":1,"id":0,"action":"hello"}`, `{"version":1,"id":1}`} {
		if _, err := decodeRequest([]byte(input)); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}
