//go:build !windows

package hooksock

import (
	"os"
	"syscall"
)

// flockExclusive and flockUnlock back startLock (see server.go). presenced
// only ships for linux, darwin and windows (see build-go-release.sh); this
// file covers the first two with the native syscall.Flock, which every unix
// presenced actually runs on has. See lock_windows.go for the third.
func flockExclusive(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
}

func flockUnlock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
