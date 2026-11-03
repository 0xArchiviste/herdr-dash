package main

import "os/exec"

// killGroupOnCancel: Windows has no process groups to signal; the default
// cancel kills the command itself. (On Windows the desktop app connects to
// a Dash running where herdr runs, usually WSL.)
func killGroupOnCancel(cmd *exec.Cmd) {}
