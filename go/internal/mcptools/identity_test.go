package mcptools

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mohsensc/sync/go/internal/repo"
)

// Port of python/tests/test_mcp_identity.py: room, agent and human are
// derived, not configured, so this is tested against real `git` repos on
// disk rather than mocks — same as the Python suite.

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func newRepo(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "work", "api")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, root, "init", "-q")
	git(t, root, "config", "user.email", "sara@acme.example")
	git(t, root, "config", "user.name", "Sara")
	git(t, root, "remote", "add", "origin", "git@github.com:acme/api.git")
	return root
}

func bareRepo(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "solo")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, root, "init", "-q")
	git(t, root, "config", "user.email", "dev@acme.example")
	return root
}

func clearIdentityEnv(t *testing.T) {
	t.Helper()
	for _, v := range []string{RoomEnv, AgentEnv, HumanEnv, "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"} {
		old, had := os.LookupEnv(v)
		os.Unsetenv(v)
		t.Cleanup(func() {
			if had {
				os.Setenv(v, old)
			}
		})
	}
}

func TestRoomIsTheHashOfTheGitRemote(t *testing.T) {
	clearIdentityEnv(t)
	root := newRepo(t)
	want := repo.RoomIDFromRemote("git@github.com:acme/api.git")
	if got := RoomFor(root); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestTwoClonesOfOneRepoLandInTheSameRoom(t *testing.T) {
	clearIdentityEnv(t)
	repo := newRepo(t)
	other := filepath.Join(t.TempDir(), "elsewhere", "api")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, other, "init", "-q")
	git(t, other, "remote", "add", "origin", "https://github.com/acme/api")

	if RoomFor(other) != RoomFor(repo) {
		t.Fatalf("two clones of one repo landed in different rooms")
	}
}

func TestASubdirectoryOfTheRepoGetsTheSameRoom(t *testing.T) {
	clearIdentityEnv(t)
	repo := newRepo(t)
	sub := filepath.Join(repo, "src", "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if RoomFor(sub) != RoomFor(repo) {
		t.Fatal("subdirectory landed in a different room")
	}
}

func TestARepoWithNoRemoteFallsBackToALocalRoom(t *testing.T) {
	clearIdentityEnv(t)
	repo := bareRepo(t)
	room := RoomFor(repo)
	if len(room) < 6 || room[:6] != "local-" {
		t.Fatalf("got %q, want a local- room", room)
	}
	if room == RoomFor(filepath.Dir(repo)) {
		t.Fatal("a different directory got the same local room")
	}
}

func TestARemoteThatIsNotOriginStillKeysTheRoom(t *testing.T) {
	clearIdentityEnv(t)
	root := filepath.Join(t.TempDir(), "forked")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, root, "init", "-q")
	git(t, root, "remote", "add", "upstream", "https://github.com/acme/api.git")

	want := repo.RoomIDFromRemote("https://github.com/acme/api")
	if got := RoomFor(root); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestTheRoomEnvVarOverridesTheGitRemote(t *testing.T) {
	clearIdentityEnv(t)
	repo := newRepo(t)
	os.Setenv(RoomEnv, "r1")
	if got := RoomFor(repo); got != "r1" {
		t.Fatalf("got %q, want r1", got)
	}
}

func TestADirectoryOutsideAnyRepoStillGetsARoom(t *testing.T) {
	clearIdentityEnv(t)
	outside := filepath.Join(t.TempDir(), "not-a-repo")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	room := RoomFor(outside)
	if len(room) < 6 || room[:6] != "local-" {
		t.Fatalf("got %q, want a local- room", room)
	}
}

func TestGitRemoteIsEmptyWhenThereIsNoRemote(t *testing.T) {
	clearIdentityEnv(t)
	if got := GitRemote(bareRepo(t)); got != "" {
		t.Fatalf("got %q, want \"\"", got)
	}
}

func TestHumanComesFromGitConfigUserEmail(t *testing.T) {
	clearIdentityEnv(t)
	if got := HumanID(newRepo(t)); got != "sara" {
		t.Fatalf("got %q, want sara", got)
	}
}

func TestTheDomainNeverLeavesTheMachine(t *testing.T) {
	clearIdentityEnv(t)
	human := HumanID(newRepo(t))
	if containsAny(human, "acme.example", "@") {
		t.Fatalf("human id %q leaked the domain", human)
	}
}

func TestTheHumanEnvVarWins(t *testing.T) {
	clearIdentityEnv(t)
	os.Setenv(HumanEnv, "pinned")
	if got := HumanID(newRepo(t)); got != "pinned" {
		t.Fatalf("got %q, want pinned", got)
	}
}

func TestAgentUsesTheClaudeCodeSessionID(t *testing.T) {
	clearIdentityEnv(t)
	os.Setenv("CLAUDE_CODE_SESSION_ID", "sess_abc")
	if got := AgentID(); got != "sess_abc" {
		t.Fatalf("got %q, want sess_abc", got)
	}
}

func TestAgentEnvVarBeatsTheSessionID(t *testing.T) {
	clearIdentityEnv(t)
	os.Setenv("CLAUDE_CODE_SESSION_ID", "sess_abc")
	os.Setenv(AgentEnv, "pinned")
	if got := AgentID(); got != "pinned" {
		t.Fatalf("got %q, want pinned", got)
	}
}

func TestAgentIsGeneratedAndUniqueWhenNothingDeclaresOne(t *testing.T) {
	clearIdentityEnv(t)
	a, b := AgentID(), AgentID()
	if a == b {
		t.Fatal("two calls with nothing pinned produced the same agent id")
	}
	if len(a) < 5 || a[:5] != "sess_" {
		t.Fatalf("got %q, want a sess_ prefix", a)
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if len(sub) > 0 && contains(s, sub) {
			return true
		}
	}
	return false
}

func TestLocalIdentityReadsPrincipalTokenAndUnattendedFromEnv(t *testing.T) {
	clearIdentityEnv(t)
	os.Setenv("AGENT_PRESENCE_PRINCIPAL", "sara")
	os.Setenv("AGENT_PRESENCE_TOKEN", "s3cret")
	os.Setenv("AGENT_PRESENCE_UNATTENDED", "true")
	t.Cleanup(func() {
		os.Unsetenv("AGENT_PRESENCE_PRINCIPAL")
		os.Unsetenv("AGENT_PRESENCE_TOKEN")
		os.Unsetenv("AGENT_PRESENCE_UNATTENDED")
	})

	who := LocalIdentityFromEnv()
	if who.Principal != "sara" || who.Token != "s3cret" || !who.Unattended {
		t.Fatalf("got %+v", who)
	}
}

func TestReadTokenFallsBackToTheConfigFile(t *testing.T) {
	os.Unsetenv("AGENT_PRESENCE_TOKEN")
	dir := t.TempDir()
	os.Setenv("XDG_CONFIG_HOME", dir)
	t.Cleanup(func() { os.Unsetenv("XDG_CONFIG_HOME") })

	path := filepath.Join(dir, "agent-presence", "token")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("\n  \nabc123\nminted 2026-01-01\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ReadToken(); got != "abc123" {
		t.Fatalf("got %q, want abc123 (the first non-blank line)", got)
	}
}

func TestReadTokenIsEmptyWithNothingConfigured(t *testing.T) {
	os.Unsetenv("AGENT_PRESENCE_TOKEN")
	os.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Cleanup(func() { os.Unsetenv("XDG_CONFIG_HOME") })
	if got := ReadToken(); got != "" {
		t.Fatalf("got %q, want \"\"", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
