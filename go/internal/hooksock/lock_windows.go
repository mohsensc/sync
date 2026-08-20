//go:build windows

package hooksock

import (
	"os"

	"golang.org/x/sys/windows"
)

// flockExclusive and flockUnlock back startLock (see server.go), using
// LockFileEx as the Windows equivalent of flock(2) — presenced is
// cross-compiled for windows (see build-go-release.sh) even though AF_UNIX
// sockets there are a newer, less-exercised path than linux/darwin. Without
// LOCKFILE_FAIL_IMMEDIATELY the call blocks until the lock is free, matching
// the blocking semantics lock_unix.go gets from syscall.Flock.
func flockExclusive(f *os.File) error {
	ol := new(windows.Overlapped)
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, ol)
}

func flockUnlock(f *os.File) error {
	ol := new(windows.Overlapped)
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, ol)
}
