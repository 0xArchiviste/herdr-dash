//go:build !windows

package routing

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

// lockFile takes an exclusive flock on path (made 0600 if missing), waiting
// up to timeout. It serializes cooperating writers across processes.
func lockFile(path string, timeout time.Duration) (func(), error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("routing lock: %w", err)
	}
	deadline := time.Now().Add(timeout)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			f.Close()
			return nil, fmt.Errorf("routing lock: %w", err)
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, errors.New("routing lock: another save is still running; try again")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func ownedByMe(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// privateDir: nobody else may write it. Group write is allowed only when
// the group is this user's own primary group.
func privateDir(fi os.FileInfo) bool {
	perm := fi.Mode().Perm()
	if perm&0o002 != 0 {
		return false
	}
	if perm&0o020 != 0 {
		st, ok := fi.Sys().(*syscall.Stat_t)
		return ok && int(st.Gid) == os.Getgid()
	}
	return true
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}
