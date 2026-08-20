package relaysrv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// issue #173: session end only released a room-scoped claim while the
// agent index it depends on is cleared globally. authConn is a settable
// stand-in that (unlike golden_test.go's recorder) carries a real
// principal/token, so Join can grant it a non-default tier the way the
// scenarios below need.
type authConn struct {
	agent, human, room string
	principal, token   string
	unattended         bool
	sent               []Frame
}

func (c *authConn) Agent() string     { return c.agent }
func (c *authConn) SetAgent(a string) { c.agent = a }
func (c *authConn) Human() string     { return c.human }
func (c *authConn) SetHuman(h string) { c.human = h }
func (c *authConn) Room() string      { return c.room }
func (c *authConn) SetRoom(r string)  { c.room = r }
func (c *authConn) Principal() string { return c.principal }
func (c *authConn) Token() string     { return c.token }
func (c *authConn) Unattended() bool  { return c.unattended }
func (c *authConn) Send(b []byte) {
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		panic(err)
	}
	c.sent = append(c.sent, f)
}

// criticalRoster grants "alice" critical on both attended and unattended
// paths, so a claim taken under it reads as a stranded critical lease
// rather than getting lost in the normal/critical distinction.
func criticalRoster() Roster {
	sum := sha256.Sum256([]byte("s3cret"))
	text := fmt.Sprintf(`version = 1
default_tier = "normal"

[[principal]]
id = "alice"
token_sha256 = "%s"
attended = "critical"
unattended = "critical"
`, hex.EncodeToString(sum[:]))
	return ParseRoster(text, "<test>")
}

func scopeRegion(path string) map[string]any {
	return map[string]any{"path": path, "symbol": "", "lines": nil}
}

// -- fix (a): Join releases the old room's claims before switching -------

func TestRoomSwitchReleasesOldRoomsClaims(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, criticalRoster(), metrics.New())

	conn := &authConn{agent: "dev", human: "Alice", principal: "alice", token: "s3cret"}
	if !rel.Join("roomA", conn) {
		t.Fatal("join roomA refused")
	}
	rel.Handle(conn, map[string]any{"type": "claim", "region": scopeRegion("src/a.go"), "intent": "refactor"})
	if h := rel.registry.HolderOf("roomA", Region{Path: "src/a.go"}, nil); h == nil {
		t.Fatal("expected a claim in roomA before the switch")
	}

	if !rel.Join("roomB", conn) {
		t.Fatal("join roomB refused")
	}

	if h := rel.registry.HolderOf("roomA", Region{Path: "src/a.go"}, nil); h != nil {
		t.Fatalf("room switch should release roomA's claim, still held: %+v", h)
	}
	// The switch didn't end the session, so the agent's tier is still
	// live in the index (it holds nothing yet in roomB, but the
	// connection itself is still authenticated critical).
	if got := rel.priorityOf(conn); got != PriorityCritical {
		t.Fatalf("expected the switched connection to still be critical, got %d", got)
	}
}

// Control: joining the same room twice (no actual switch) must not touch
// the claim it already holds there.
func TestRejoiningTheSameRoomDoesNotReleaseItsOwnClaim(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, criticalRoster(), metrics.New())

	conn := &authConn{agent: "dev", human: "Alice", principal: "alice", token: "s3cret"}
	rel.Join("roomA", conn)
	rel.Handle(conn, map[string]any{"type": "claim", "region": scopeRegion("src/a.go"), "intent": "refactor"})

	if !rel.Join("roomA", conn) {
		t.Fatal("rejoin refused")
	}
	if h := rel.registry.HolderOf("roomA", Region{Path: "src/a.go"}, nil); h == nil {
		t.Fatal("rejoining the same room should not release its own claim")
	}
}
