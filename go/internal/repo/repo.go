// Package repo derives which room a checkout belongs to — the Go mirror of
// cpp/daemon/repo.{hpp,cpp}. Must stay byte-identical to
// python/src/agent_presence/room_key.py and to the C++ side it replaces: a
// divergence here silently splits a team into two rooms.
//
// crypto/sha256 replaces the OpenSSL dependency repo.cpp needed solely for
// this hash — see #21.
package repo

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// asciiSpace is exactly the set python's str.strip() removes: 0x09-0x0d,
// 0x1c-0x1f, 0x20.
func asciiSpace(c byte) bool {
	return c == 0x20 || (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x1f)
}

func trimASCIISpace(s string) string {
	i, j := 0, len(s)
	for i < j && asciiSpace(s[i]) {
		i++
	}
	for j > i && asciiSpace(s[j-1]) {
		j--
	}
	return s[i:j]
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c - 'A' + 'a'
		}
	}
	return string(b)
}

func isLowerAlpha(c byte) bool { return c >= 'a' && c <= 'z' }

// stripProto mirrors `re.sub(r"^[a-z+]+://", "", s)`.
func stripProto(s string) string {
	i := 0
	for i < len(s) && (isLowerAlpha(s[i]) || s[i] == '+') {
		i++
	}
	if i == 0 || !strings.HasPrefix(s[i:], "://") {
		return s
	}
	return s[i+3:]
}

// stripUserinfo mirrors `re.sub(r"^[^/@]+@", "", s)`.
func stripUserinfo(s string) string {
	at := strings.IndexByte(s, '@')
	if at <= 0 {
		return s
	}
	if slash := strings.IndexByte(s, '/'); slash >= 0 && slash < at {
		return s
	}
	return s[at+1:]
}

// scpRewrite mirrors `re.match(r"^[^/@]+@([^:]+):(.+)$", s)` rewritten as
// `group(1) + "/" + group(2)`.
func scpRewrite(s string) (string, bool) {
	at := strings.IndexByte(s, '@')
	if at <= 0 {
		return s, false
	}
	if slash := strings.IndexByte(s, '/'); slash >= 0 && slash < at {
		return s, false
	}
	rest := s[at+1:]
	colon := strings.IndexByte(rest, ':')
	if colon <= 0 {
		return s, false
	}
	tail := rest[colon+1:]
	if tail == "" {
		return s, false // (.+) is non-empty
	}
	if strings.IndexByte(tail, '\n') >= 0 {
		return s, false // `.` is not \n
	}
	return rest[:colon] + "/" + tail, true
}

// NormalizeRemote collapses any git remote URL form to canonical
// host/owner/repo. Total by construction: unparseable input returns its
// trimmed, lowercased self, so two machines with an odd remote still agree
// on a room. ASCII-only trim and case fold, on purpose — see room_key.py.
func NormalizeRemote(url string) string {
	s := asciiLower(trimASCIISpace(url))

	if rewritten, ok := scpRewrite(s); ok {
		s = rewritten
	} else {
		s = stripUserinfo(stripProto(s))
	}

	s = strings.TrimRight(s, "/")
	s = strings.TrimSuffix(s, ".git")
	return strings.TrimRight(s, "/")
}

// RoomIDFromRemote is the truncated sha256 of the normalized remote — the
// relay never learns the URL itself.
func RoomIDFromRemote(url string) string {
	sum := sha256.Sum256([]byte(NormalizeRemote(url)))
	return hex.EncodeToString(sum[:8])
}

// FindRepoRoot walks up from startPath looking for a `.git` entry (a
// directory for a normal clone, a file for a worktree — exists() is the
// right test either way).
func FindRepoRoot(startPath string) (string, bool) {
	p, err := filepath.Abs(startPath)
	if err != nil {
		return "", false
	}
	for {
		if _, err := os.Stat(filepath.Join(p, ".git")); err == nil {
			return p, true
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", false
		}
		p = parent
	}
}

// GitOriginURL runs `git remote get-url origin` once, at startup — never
// from the event loop, which the 5ms budget cannot absorb a fork inside.
func GitOriginURL(root string) string {
	out, err := exec.Command("git", "-C", root, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\r\n")
}

// DiscoverRoom is main.cpp's discover_room: AGENT_PRESENCE_ROOM overrides
// everything; otherwise the room is derived from the checkout's origin
// remote. Empty means no relay connection — joining a made-up room would
// put every unkeyed machine on the planet in the same one.
func DiscoverRoom(forced string, cwd string) string {
	if forced != "" {
		return forced
	}
	root, ok := FindRepoRoot(cwd)
	if !ok {
		return ""
	}
	remote := GitOriginURL(root)
	if remote == "" {
		return ""
	}
	return RoomIDFromRemote(remote)
}
