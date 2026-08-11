package relaysrv

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFindRosterResolvesSymlinks is issue #48: filepath.Abs alone (what
// FindRoster used to call) makes a path absolute without touching the
// filesystem, so it never follows a symlink. Python's find_roster calls
// Path.resolve(), which does. A checkout reached through a symlinked
// directory — including plain macOS, where /tmp -> /private/tmp — could
// walk a different chain and load a different (or no) principals.toml on
// the two relays, silently changing which tier an agent got.
func TestFindRosterResolvesSymlinks(t *testing.T) {
	real := t.TempDir()
	rosterDir := filepath.Join(real, ".agent-presence")
	if err := os.MkdirAll(rosterDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rosterPath := filepath.Join(rosterDir, "principals.toml")
	if err := os.WriteFile(rosterPath, []byte("version = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(real, "worktree", "repo")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("cannot create symlink on this filesystem: %s", err)
	}

	// Starting from *inside* the symlinked chain: the roster lives above
	// this directory, reachable only by resolving the symlink first.
	start := filepath.Join(link, "worktree", "repo")

	got := FindRoster(start)
	wantReal, err := filepath.EvalSymlinks(rosterPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != wantReal {
		t.Fatalf("FindRoster(%q) = %q, want %q (the symlink-resolved path)", start, got, wantReal)
	}
}

// TestFindRosterStillWorksWithNoSymlinksInvolved is the plain case: no
// symlink anywhere, so resolving one changes nothing.
func TestFindRosterStillWorksWithNoSymlinksInvolved(t *testing.T) {
	real := t.TempDir()
	rosterDir := filepath.Join(real, ".agent-presence")
	if err := os.MkdirAll(rosterDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rosterPath := filepath.Join(rosterDir, "principals.toml")
	if err := os.WriteFile(rosterPath, []byte("version = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(real, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	got := FindRoster(sub)
	wantReal, err := filepath.EvalSymlinks(rosterPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != wantReal {
		t.Fatalf("FindRoster(%q) = %q, want %q", sub, got, wantReal)
	}
}
