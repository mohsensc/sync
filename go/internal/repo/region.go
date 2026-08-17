// Region keys: what two agents have to say the same way to be talking
// about the same file.
//
// A room is a hash of the checkout's origin remote, so two teammates on
// two clones of one repo are in one room by design. The region key inside
// that room was the raw absolute filesystem path, which no two checkouts
// ever share — so the room brought a team together and the region key kept
// them apart. Two agents editing the same symbol of the same file, in the
// same room, never collided unless they happened to share a filesystem.
//
// The fix is here rather than on the relay: the relay has no idea where
// anybody's checkout lives, and asking it to guess would be worse than the
// bug. Every client that puts a path on the wire runs it through
// RegionKey first, against the repo root it already discovered to derive
// its own room.

package repo

import (
	"path/filepath"
	"strings"
)

// RegionKey is the shared name for a file: its path relative to the repo
// root, forward-slashed, so the same file in two checkouts is one key.
//
// A path outside the root — /etc/hosts, a scratch file in /tmp — has no
// shared name and keeps its cleaned absolute form. Two agents on two
// machines editing "the same" /tmp/notes.md are not, in fact, editing the
// same file, and pretending otherwise would invent collisions instead of
// finding them.
//
// Empty root (no checkout found) means nothing can be made relative, so
// the path is cleaned and returned. Cleaning still matters on its own:
// `src/../src/orders.py` and `src/orders.py` were two different regions
// before this, on one machine, in one checkout.
func RegionKey(root, path string) string {
	if path == "" {
		return ""
	}
	p := filepath.Clean(path)
	if root == "" {
		return filepath.ToSlash(p)
	}
	r := filepath.Clean(root)
	if !filepath.IsAbs(p) {
		// A relative path is already a region key, or close enough — a
		// hook that sent one meant it against the same checkout. Clean
		// and slash it, don't join it onto the root and back out again.
		return filepath.ToSlash(p)
	}
	rel, err := filepath.Rel(r, p)
	if err != nil {
		return filepath.ToSlash(p)
	}
	rel = filepath.ToSlash(rel)
	// Rel answers "../.." happily for a path outside the root. That is
	// not a shared name; it is a name relative to a directory the other
	// side has never heard of.
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return filepath.ToSlash(p)
	}
	return rel
}

// RegionKeyResolved is RegionKey with one retry through symlinks.
//
// The two sides of this comparison are discovered independently and can end
// up in different namespaces for the same directory. A daemon finds its root
// from os.Getwd(), which resolves symlinks when $PWD is not set; the hook
// sends whatever absolute path Claude Code's tool call carried, which
// generally does not. On macOS /tmp is a symlink to /private/tmp, so a
// checkout under /tmp lands the two spellings on opposite sides and Rel
// answers "../../.." — RegionKey correctly refuses to call that a shared
// name, and the region silently stays absolute, which is the bug this whole
// change exists to fix. A symlinked checkout anywhere does the same thing.
//
// The retry costs nothing in the ordinary case: a path inside the root is
// answered by RegionKey's string comparison and never reaches EvalSymlinks.
// It is only paid when the fast answer came back absolute, which is either a
// genuinely out-of-repo path (rare, and one lstat chain is not the problem
// there) or exactly the symlink case this is for.
//
// EvalSymlinks needs its argument to exist, and a hook fires on files that
// do not: a Write to a new path, in a directory the agent is creating as it
// goes. So the longest existing prefix is what gets resolved, with the rest
// joined back on — see resolveExisting.
func RegionKeyResolved(root, path string) string {
	k := RegionKey(root, path)
	if root == "" || path == "" || !filepath.IsAbs(k) {
		return k
	}
	rr, err := filepath.EvalSymlinks(root)
	if err != nil {
		return k
	}
	if rk := RegionKey(rr, resolveExisting(path)); !filepath.IsAbs(rk) {
		return rk
	}
	return k
}

// resolveExisting resolves symlinks over as much of an absolute path as
// actually exists, and rejoins the part that doesn't.
//
// Resolving only the immediate parent directory was not enough: an agent
// writing src/newpkg/thing.py creates several levels at once, and until they
// exist the whole path resolves to nothing and the region silently keeps its
// absolute name — which is the bug, back again, for exactly the new files a
// pair of agents is most likely to collide on.
//
// Walks up at most once per path segment, and only ever on the slow path
// RegionKeyResolved already decided to take.
func resolveExisting(path string) string {
	p := filepath.Clean(path)
	rest := ""
	for {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			if rest == "" {
				return r
			}
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return path // walked to the filesystem root resolving nothing
		}
		rest = filepath.Join(filepath.Base(p), rest)
		p = parent
	}
}
