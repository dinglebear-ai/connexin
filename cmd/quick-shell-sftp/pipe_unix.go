//go:build !windows

package main

import "syscall"

// setNonblock puts an inherited descriptor into non-blocking mode so os.NewFile
// registers it with the runtime poller. Without this the returned *os.File does
// not support deadlines. See inheritedFile in protocol.go for why that matters.
func setNonblock(fd int) error { return syscall.SetNonblock(fd, true) }
