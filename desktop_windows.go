//go:build desktop && windows

package main

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// WebView2 grants permissions itself (Wails sets them to allow).
func enableMic(string) {}

// startWSLService starts the herdr-dash user service in the default WSL
// distribution, where herdr runs; WSL forwards its loopback port.
func startWSLService() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wsl.exe", "-e", "systemctl", "--user", "start", "herdr-dash.service")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return cmd.Run()
}
