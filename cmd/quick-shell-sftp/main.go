package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/pkg/sftp"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "quick-shell-sftp: unavailable")
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 3 {
		return usageError("expected SSH config and device")
	}
	timeout := 15
	if raw := os.Getenv("QUICK_SHELL_SFTP_CONNECT_TIMEOUT_SECONDS"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 && value <= 120 {
			timeout = value
		}
	}
	args := []string{"-F", os.Args[1], "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "-o", fmt.Sprintf("ConnectTimeout=%d", timeout), "-s", os.Args[2], "sftp"}
	cmd := exec.Command("ssh", args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	client, err := sftp.NewClientPipe(stdout, stdin, sftp.UseConcurrentReads(true), sftp.UseConcurrentWrites(true))
	if err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	err = serve(client, os.Stdin, os.Stdout)
	_ = client.Close()
	_ = stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
	return err
}
