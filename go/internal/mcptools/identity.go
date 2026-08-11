// Room, agent and human are derived, not configured — cloning the repo is
// the setup. This file is the Go mirror of mcp_server.py's identity
// section: room_for, agent_id, human_id and local_identity, byte-for-byte
// the same rules so a Go MCP server and the C++/Go daemon on one machine
// land in the same room and present the same principal.
package mcptools

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/mohsensc/sync/go/internal/mcprelay"
	"github.com/mohsensc/sync/go/internal/repo"
)

const (
	AgentEnv = "AGENT_PRESENCE_AGENT"
	HumanEnv = "AGENT_PRESENCE_HUMAN"
	RoomEnv  = "AGENT_PRESENCE_ROOM"

	principalEnv  = "AGENT_PRESENCE_PRINCIPAL"
	tokenEnv      = "AGENT_PRESENCE_TOKEN"
	unattendedEnv = "AGENT_PRESENCE_UNATTENDED"
	tokenRelpath  = "agent-presence/token"

	// maxTokenBytes: secrets.token_urlsafe(32) is 43 characters; this is
	// orders of magnitude above that and still small enough that being
	// pointed at the wrong file costs a read, not a process. Matches
	// principals.py's implicit ceiling (a whole-file read) and
	// presenced/main.go's kMaxTokenBytes.
	maxTokenBytes = 4096
)

// gitQuery runs one git command and returns its trimmed stdout, or "" on
// any failure — no repo, no git, no remote all look the same to a caller
// that just wants to fall back to local-only mode. Mirrors mcp_server.py's
// _git.
func gitQuery(cwd string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// RepoRoot is the checkout `cwd` belongs to, or `cwd` itself when git
// doesn't know of one — repo_root().
func RepoRoot(cwd string) string {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		abs = cwd
	}
	if root := gitQuery(abs, "rev-parse", "--show-toplevel"); root != "" {
		return root
	}
	return abs
}

// GitRemote is the remote this repo pushes to, if there is one — origin
// first, then whichever remote git lists first, so a fork with no origin
// still keys a room. Mirrors mcp_server.py's git_remote.
func GitRemote(cwd string) string {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		abs = cwd
	}
	if remote := gitQuery(abs, "remote", "get-url", "origin"); remote != "" {
		return remote
	}
	names := gitQuery(abs, "remote")
	if names == "" {
		return ""
	}
	first := strings.TrimSpace(strings.SplitN(names, "\n", 2)[0])
	if first == "" {
		return ""
	}
	return gitQuery(abs, "remote", "get-url", first)
}

// RoomFor is the room id for a working directory: the env override, else
// the hash of the git remote, else a hash of the checkout's own path in
// local-only mode — a room that is real but nobody else can ever be in.
// Mirrors mcp_server.py's room_for.
func RoomFor(cwd string) string {
	if override := strings.TrimSpace(os.Getenv(RoomEnv)); override != "" {
		return override
	}
	if remote := GitRemote(cwd); remote != "" {
		return repo.RoomIDFromRemote(remote)
	}
	root := RepoRoot(cwd)
	sum := sha256.Sum256([]byte(root))
	return "local-" + hex.EncodeToString(sum[:])[:16]
}

// AgentID is one MCP server process's id: Claude Code's session id when
// it's in the environment (so the hook channel and this one agree on who's
// talking), else a fresh random one. Mirrors mcp_server.py's agent_id.
func AgentID() string {
	for _, env := range []string{AgentEnv, "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"} {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			return v
		}
	}
	b := make([]byte, 6) // 12 hex chars, same width as uuid4().hex[:12]
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is a machine problem, not a reason to hang
		// the tool surface on it — fall back to something merely unique.
		return "sess_" + hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))[:12]
	}
	return "sess_" + hex.EncodeToString(b)
}

// HumanID is the person, from `git config user.email` — only the local
// part travels, since the domain identifies the employer, not the person,
// and is one more thing to leak. Mirrors mcp_server.py's human_id.
func HumanID(cwd string) string {
	if override := strings.TrimSpace(os.Getenv(HumanEnv)); override != "" {
		return override
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		abs = cwd
	}
	if email := gitQuery(abs, "config", "user.email"); email != "" {
		return strings.SplitN(email, "@", 2)[0]
	}
	if user := strings.TrimSpace(os.Getenv("USER")); user != "" {
		return user
	}
	return "someone"
}

// LocalIdentity is which principal this machine presents itself as, if
// any: the counterpart to principals.py's roster, on the client side.
// Mirrors mcp_server.py's LocalIdentity/local_identity.
type LocalIdentity struct {
	Principal  string // "" means unauthenticated
	Token      string
	Unattended bool
}

func tokenPath() string {
	if base := os.Getenv("XDG_CONFIG_HOME"); base != "" {
		return filepath.Join(base, tokenRelpath)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".config", tokenRelpath)
}

// ReadToken is this machine's bearer token, or "" — never an error. No
// token is not a failure: the relay grants such a connection the default
// tier, same as a room with no roster. The first non-blank line, so a file
// with a note under the secret still works. Mirrors principals.py's
// read_token.
func ReadToken() string {
	if direct := strings.TrimSpace(os.Getenv(tokenEnv)); direct != "" {
		return direct
	}
	path := tokenPath()
	if path == "" {
		return ""
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() > maxTokenBytes {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			return line
		}
	}
	return ""
}

func unattendedFlag() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(unattendedEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// LocalIdentityFromEnv reads the same three env vars local_identity() does.
func LocalIdentityFromEnv() LocalIdentity {
	return LocalIdentity{
		Principal:  strings.TrimSpace(os.Getenv(principalEnv)),
		Token:      ReadToken(),
		Unattended: unattendedFlag(),
	}
}

// RelayEnv and DefaultRelayURL are relay_client.py's RELAY_ENV and
// DEFAULT_RELAY_URL — one name for "where the relay is" across the whole
// system, not an MCP-specific one; cpp/daemon and presenced read the same
// var.
const RelayEnv = "AGENT_PRESENCE_RELAY"

const DefaultRelayURL = "ws://127.0.0.1:8799"

// RelayURL is the env override, or the default.
func RelayURL() string {
	if v := strings.TrimSpace(os.Getenv(RelayEnv)); v != "" {
		return v
	}
	return DefaultRelayURL
}

// BuildTools assembles the tool surface for a working directory: derives
// room/agent/human, reads this machine's local identity, and wires a
// connection to url (RelayURL() if empty). The connection doesn't dial out
// until the first tool call — see mcprelay.Conn's doc comment — so this
// never blocks on a relay that isn't running yet. Mirrors mcp_server.py's
// build_tools.
func BuildTools(cwd, url string) *Tools {
	room, agent, human := RoomFor(cwd), AgentID(), HumanID(cwd)
	if url == "" {
		url = RelayURL()
	}
	who := LocalIdentityFromEnv()
	conn := mcprelay.New(mcprelay.Config{
		URL: url, Room: room, Agent: agent, Human: human,
		Principal: who.Principal, Token: who.Token, Unattended: who.Unattended,
	})
	return NewTools(conn, room, agent, human)
}
