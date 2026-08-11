package repo

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// vectors mirrors python/tests/test_room_key_ascii_contract.py's VECTORS —
// url -> (normalized, room id). A cross-language contract: if either side's
// idea of "lowercase" or "whitespace" drifts, a team silently splits into
// two rooms.
var vectors = map[string][2]string{
	"git@github.com:acme/api.git":          {"github.com/acme/api", "e1dcaa3496b93562"},
	"https://github.com/acme/api":          {"github.com/acme/api", "e1dcaa3496b93562"},
	"https://github.com/acme/api.git":      {"github.com/acme/api", "e1dcaa3496b93562"},
	"ssh://git@github.com/acme/api.git":    {"github.com/acme/api", "e1dcaa3496b93562"},
	"HTTPS://GitHub.com/Acme/API.git":      {"github.com/acme/api", "e1dcaa3496b93562"},
	"https://github.com/acme/api/":         {"github.com/acme/api", "e1dcaa3496b93562"},
	"  https://github.com/acme/api.git \n": {"github.com/acme/api", "e1dcaa3496b93562"},
	"https://github.com/acme/api.git\x1d":  {"github.com/acme/api", "e1dcaa3496b93562"},
	"https://github.com/acme/Ünicode-Repo.git": {
		"github.com/acme/Ünicode-repo", "2707d06139ada0c0",
	},
	"git@gitlab.com:ÉQUIPE/Projet.git": {
		"gitlab.com/Équipe/projet", "fbcc8d6b93e2a37f",
	},
	" https://github.com/acme/api.git ": {
		" https://github.com/acme/api.git ", "a2204ca2a2dbc8dc",
	},
	"git@host:pa\rth":             {"host/pa\rth", "cab7f1fc89970e3a"},
	"git@github.com:acme/web.git": {"github.com/acme/web", "6622211c92d781b7"},
	"git@gitlab.com:acme/api.git": {"gitlab.com/acme/api", "1055cc0317804d28"},
}

func TestVectorsMatchThePythonAndCppSides(t *testing.T) {
	for url, want := range vectors {
		gotNorm := NormalizeRemote(url)
		gotID := RoomIDFromRemote(url)
		if gotNorm != want[0] || gotID != want[1] {
			t.Errorf("NormalizeRemote(%q) = %q, RoomIDFromRemote = %q; want %q, %q",
				url, gotNorm, gotID, want[0], want[1])
		}
	}
}

func TestCaseFoldingAndTrimmingAreASCIIOnly(t *testing.T) {
	if NormalizeRemote("Ü") != "Ü" {
		t.Fatal("non-ascii must not be case-folded")
	}
	if NormalizeRemote("İ") != "İ" {
		t.Fatal("non-ascii must not be case-folded")
	}
	if NormalizeRemote(" x ") != " x " {
		t.Fatal("U+00A0 is not ascii whitespace and must survive")
	}
	if NormalizeRemote(" x ") != " x " {
		t.Fatal("U+2028 is not ascii whitespace and must survive")
	}
	for _, ch := range "\t\n\v\f\r\x1c\x1d\x1e\x1f " {
		got := NormalizeRemote(string(ch) + "x" + string(ch))
		if got != "x" {
			t.Fatalf("ascii space %q must be stripped, got %q", ch, got)
		}
	}
}

func TestEveryURLFormOfOneRepoCollapsesToOneKey(t *testing.T) {
	equivalent := []string{
		"git@github.com:acme/api",
		"git@github.com:acme/api/",
		"git@github.com:acme/api.git",
		"git@github.com:acme/api.git/",
		"ssh://git@github.com/acme/api",
		"ssh://git@github.com/acme/api/",
		"ssh://git@github.com/acme/api.git",
		"ssh://git@github.com/acme/api.git/",
		"https://github.com/acme/api",
		"https://github.com/acme/api/",
		"https://github.com/acme/api.git",
		"https://github.com/acme/api.git/",
		"http://github.com/acme/api.git/",
		"git://github.com/acme/api.git/",
		"https://token@github.com/acme/api.git/",
		"HTTPS://GitHub.com/Acme/API.git",
		"HTTPS://GitHub.com/Acme/API.GIT/",
		"GIT@GITHUB.COM:ACME/API.GIT/",
		"  https://github.com/acme/api.git/ \n",
	}
	ids := map[string]bool{}
	for _, url := range equivalent {
		if got := NormalizeRemote(url); got != "github.com/acme/api" {
			t.Errorf("NormalizeRemote(%q) = %q, want github.com/acme/api", url, got)
		}
		ids[RoomIDFromRemote(url)] = true
	}
	if len(ids) != 1 {
		t.Fatalf("expected the whole matrix to be one room, got %d distinct ids", len(ids))
	}
}

func TestDistinctReposStayDistinct(t *testing.T) {
	pairs := [][2]string{
		{"git@github.com:acme/api.git", "git@github.com:acme/web.git"},
		{"git@github.com:acme/api.git", "git@gitlab.com:acme/api.git"},
		{"https://github.com/acme/api.git/", "https://github.com/acme/apigit"},
		{"https://github.com/acme/api.git/", "https://github.com/acme/api.github"},
	}
	for _, p := range pairs {
		if NormalizeRemote(p[0]) == NormalizeRemote(p[1]) {
			t.Errorf("%q and %q must stay distinct", p[0], p[1])
		}
	}
}

func TestRepoNameEndingInGitKeepsItsName(t *testing.T) {
	if got := NormalizeRemote("https://github.com/acme/gitgit/"); got != "github.com/acme/gitgit" {
		t.Fatalf("got %q", got)
	}
}

func TestRoomIDIsStable16CharHex(t *testing.T) {
	rid := RoomIDFromRemote("git@github.com:acme/api.git")
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(rid) {
		t.Fatalf("not 16 hex chars: %q", rid)
	}
	if RoomIDFromRemote("https://github.com/acme/api") != rid {
		t.Fatal("equivalent urls must hash to the same room")
	}
}

func TestFindRepoRootWalksUpToDotGit(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	got, ok := FindRepoRoot(nested)
	if !ok {
		t.Fatal("expected to find the repo root")
	}
	// Resolve both sides through EvalSymlinks so a macOS /tmp -> /private/tmp
	// symlink doesn't fail a string comparison that isn't the point of this test.
	wantAbs, _ := filepath.EvalSymlinks(root)
	gotAbs, _ := filepath.EvalSymlinks(got)
	if gotAbs != wantAbs {
		t.Fatalf("got %q, want %q", got, root)
	}
}

func TestFindRepoRootWorktreeFileCounts(t *testing.T) {
	// A worktree's .git is a file, not a directory — must still count.
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /elsewhere"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := FindRepoRoot(root); !ok {
		t.Fatal("a .git file (worktree) must count as a repo root")
	}
}

func TestFindRepoRootNoneFound(t *testing.T) {
	// A directory tree with no .git anywhere up to filesystem root: this
	// test can only assert it terminates rather than hangs, since the real
	// filesystem root may or may not have a .git depending on the machine.
	if _, ok := FindRepoRoot("/nonexistent-path-xyz-123"); ok {
		t.Fatal("a nonexistent path must not report a repo root")
	}
}
