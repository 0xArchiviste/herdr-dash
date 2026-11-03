//go:build windows

package routing

import (
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// lockFile takes an exclusive LockFileEx lock on path, waiting up to timeout.
func lockFile(path string, timeout time.Duration) (func(), error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("routing lock: %w", err)
	}
	h := windows.Handle(f.Fd())
	deadline := time.Now().Add(timeout)
	for {
		ol := new(windows.Overlapped)
		err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
		if err == nil {
			return func() { windows.UnlockFileEx(h, 0, 1, 0, new(windows.Overlapped)); f.Close() }, nil
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, errors.New("routing lock: another save is still running; try again")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Windows ACLs are not checked here; the profile directory is per user.
func ownedByMe(os.FileInfo) bool { return true }

func privateDir(os.FileInfo) bool { return true }

func syncDir(string) {}
