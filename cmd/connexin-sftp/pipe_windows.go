//go:build windows

package main

import "errors"

// setNonblock has no Windows equivalent for an inherited anonymous pipe handle:
// there is no O_NONBLOCK to set, and os.NewFile cannot put such a handle on the
// runtime poller. Reporting the failure keeps the caller honest -- a bounded
// drain is impossible here, so an aborted transfer ends the session and the
// client reconnects on a clean pair of pipes rather than splicing leftover
// bytes onto the next payload.
func setNonblock(int) error { return errors.New("non-blocking mode unsupported") }
