package repo

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegionKeyGivesTwoCheckoutsOneName(t *testing.T) {
	// The whole point. Two clones of one repo, one file.
	a := RegionKey("/Users/carol/work/repo", "/Users/carol/work/repo/src/orders.py")
	b := RegionKey("/Users/dan/dev/repo", "/Users/dan/dev/repo/src/orders.py")
	if a != b {
		t.Fatalf("two checkouts of one repo disagree: %q vs %q", a, b)
	}
	if a != "src/orders.py" {
		t.Fatalf("want src/orders.py, got %q", a)
	}
}

func TestRegionKey(t *testing.T) {
	for _, tc := range []struct {
		name, root, path, want string
	}{
		{"plain", "/r", "/r/src/a.py", "src/a.py"},
		{"root itself", "/r", "/r", "."},
		{"nested", "/r", "/r/a/b/c.go", "a/b/c.go"},
		{"detour", "/r", "/r/./src/../src/a.py", "src/a.py"},
		{"trailing slash on root", "/r/", "/r/src/a.py", "src/a.py"},
		{"outside the repo stays absolute", "/r", "/etc/hosts", "/etc/hosts"},
		{"sibling dir is not inside", "/r", "/rr/a.py", "/rr/a.py"},
		{"no root at all", "", "/r/src/a.py", "/r/src/a.py"},
		{"no root, still cleaned", "", "/r/./src/../src/a.py", "/r/src/a.py"},
		{"already relative", "/r", "src/a.py", "src/a.py"},
		{"empty path", "/r", "", ""},
		{"unicode", "/r", "/r/src/café.py", "src/café.py"},
		{"space in name", "/r", "/r/src/my file.py", "src/my file.py"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := RegionKey(tc.root, tc.path); got != tc.want {
				t.Fatalf("RegionKey(%q, %q) = %q, want %q", tc.root, tc.path, got, tc.want)
			}
		})
	}
}

func TestRegionKeyIsIdempotent(t *testing.T) {
	// A key that has already been made relative must survive a second
	// pass unchanged — frames get normalized at more than one hop and a
	// key that drifts on re-normalization is worse than one that never
	// normalized at all.
	once := RegionKey("/r", "/r/src/a.py")
	twice := RegionKey("/r", once)
	if once != twice {
		t.Fatalf("not idempotent: %q then %q", once, twice)
	}
}

func TestRegionKeyEscapeAttempt(t *testing.T) {
	// A path that climbs out of the root is not a shared name, however
	// it was spelled.
	got := RegionKey("/r", "/r/../etc/hosts")
	if got != "/etc/hosts" {
		t.Fatalf("want the cleaned absolute path, got %q", got)
	}
}

func TestRegionKeyResolvedCrossesASymlinkedRoot(t *testing.T) {
	// The case that made the whole fix inert in practice: the daemon found
	// its root through one spelling of a directory and the hook sent a path
	// through another. Plain RegionKey is right to refuse — it has no way to
	// know the two name one place — so the retry is what closes it.
	real := t.TempDir()
	if err := os.MkdirAll(filepath.Join(real, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "src", "orders.py"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "checkout")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	viaLink := filepath.Join(link, "src", "orders.py")

	if got := RegionKey(real, viaLink); got != filepath.ToSlash(filepath.Clean(viaLink)) {
		t.Fatalf("plain RegionKey should decline across the symlink, got %q", got)
	}
	if got := RegionKeyResolved(real, viaLink); got != "src/orders.py" {
		t.Fatalf("RegionKeyResolved(%q, %q) = %q, want src/orders.py", real, viaLink, got)
	}
}

func TestRegionKeyResolvedHandlesAFileThatDoesNotExistYet(t *testing.T) {
	// A hook fires on Write before the file is there. Resolving the path
	// itself would fail; resolving its directory does not.
	real := t.TempDir()
	if err := os.MkdirAll(filepath.Join(real, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "checkout")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	got := RegionKeyResolved(real, filepath.Join(link, "src", "brand-new.py"))
	if got != "src/brand-new.py" {
		t.Fatalf("got %q, want src/brand-new.py", got)
	}
}

func TestRegionKeyResolvedStillDeclinesAGenuineOutsider(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "elsewhere.py")
	if err := os.WriteFile(outside, []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := RegionKeyResolved(root, outside)
	if !filepath.IsAbs(got) {
		t.Fatalf("a path outside the repo must keep an absolute key, got %q", got)
	}
}

func TestRegionKeyResolvedHandlesADirectoryThatDoesNotExistYet(t *testing.T) {
	// An agent writing src/newpkg/thing.py creates several levels at once.
	// Resolving only the immediate parent left the whole path unresolved and
	// the region absolute — the original bug, for exactly the new files two
	// agents are most likely to race on.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "checkout")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	got := RegionKeyResolved(real, filepath.Join(link, "src", "newpkg", "deep", "thing.py"))
	if got != "src/newpkg/deep/thing.py" {
		t.Fatalf("got %q, want src/newpkg/deep/thing.py", got)
	}
}
