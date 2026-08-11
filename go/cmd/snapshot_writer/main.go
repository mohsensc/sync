// snapshot_writer is a test-only shim: it drives the daemon's real
// WriteSnapshot from the command line so python/tests/test_statusline_presence.py
// can test the bash reader (scripts/statusline-presence.sh) against the
// actual writer, the Go mirror of what
// python/tests/helpers/snapshot_writer.cpp did for cpp/daemon/snapshot.cpp
// before the daemon moved to Go (#18).
//
//	snapshot_writer <path> [human verb path]...
package main

import (
	"fmt"
	"os"

	"github.com/mohsensc/sync/go/internal/presence"
)

func main() {
	if len(os.Args) < 2 || (len(os.Args)-2)%3 != 0 {
		fmt.Fprintf(os.Stderr, "usage: %s <path> [human verb path]...\n", os.Args[0])
		os.Exit(2)
	}
	var peers []presence.Peer
	for i := 2; i < len(os.Args); i += 3 {
		peers = append(peers, presence.Peer{Human: os.Args[i], Verb: os.Args[i+1], Path: os.Args[i+2]})
	}
	if err := presence.WriteSnapshot(os.Args[1], peers, ""); err != nil {
		fmt.Fprintln(os.Stderr, "snapshot_writer:", err)
		os.Exit(1)
	}
}
