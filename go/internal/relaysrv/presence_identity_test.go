package relaysrv

import (
	"fmt"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// A daemon relays hook events for every Claude Code session on the machine
// down one websocket connection, joined once under its own identity. Each
// event frame carries the session's own agent/human — issue #1 of the
// system-seams audit: the relay used to discard that and stamp every
// presence broadcast with the connection's joined identity instead, so the
// office rendered every session on a box as the same one character. These
// pin the fix: the presence broadcast (and everything that feeds off the
// same presence buffer — Classify's collision detection, the redundant-peer
// check) prefers the event's own agent/human, falling back to the
// connection's when the event doesn't supply one. Arbitration itself
// (claims, leases, negotiation) is untouched — see
// TestClaimFrameCannotForgeItsAgentIdentity below.

func TestPresenceBroadcastPrefersEventIdentity(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	watcher := &recorder{agent: "watcher", human: "dev"}
	rel.Join("r1", daemon)
	rel.Join("r1", watcher)
	watcher.sent = nil

	rel.Handle(daemon, map[string]any{
		"type": "event", "agent": "sess-alpha", "human": "Alice",
		"verb": "edit", "region": goldenRegion("src/a.py", ""),
	})
	rel.Handle(daemon, map[string]any{
		"type": "event", "agent": "sess-beta", "human": "Bob",
		"verb": "edit", "region": goldenRegion("src/b.py", ""),
	})

	var presence []Frame
	for _, f := range watcher.sent {
		if f["type"] == "presence" {
			presence = append(presence, f)
		}
	}
	if len(presence) != 2 {
		t.Fatalf("expected 2 distinct presence broadcasts, got %d: %+v", len(presence), watcher.sent)
	}
	if presence[0]["agent"] != "sess-alpha" || presence[0]["human"] != "Alice" {
		t.Fatalf("first broadcast should carry the event's own identity, got %+v", presence[0])
	}
	if presence[1]["agent"] != "sess-beta" || presence[1]["human"] != "Bob" {
		t.Fatalf("second broadcast should carry the event's own identity, got %+v", presence[1])
	}
}

func TestPresenceBroadcastFallsBackToConnectionIdentity(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	watcher := &recorder{agent: "watcher", human: "dev"}
	rel.Join("r1", daemon)
	rel.Join("r1", watcher)
	watcher.sent = nil

	// No agent/human on the event itself — a hook-sourced touch, the common
	// case, never carries one.
	rel.Handle(daemon, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/a.py", "")})

	if len(watcher.sent) != 1 || watcher.sent[0]["agent"] != "presenced@host" || watcher.sent[0]["human"] != "mohsen-agentai" {
		t.Fatalf("expected the connection's own identity when the event carries none, got %+v", watcher.sent)
	}
}

// Same session, two touches: must not collide with its own recent history.
// Passes before and after the fix (the connection carries one identity
// throughout) — a regression guard, not the failing-before case.
func TestSameSessionEventsDoNotSelfCollide(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	rel.Join("r1", daemon)

	rel.Handle(daemon, map[string]any{"type": "event", "agent": "sess-alpha", "human": "Alice",
		"verb": "edit", "region": goldenRegion("src/a.py", "")})
	reply := rel.Handle(daemon, map[string]any{"type": "event", "agent": "sess-alpha", "human": "Alice",
		"verb": "edit", "region": goldenRegion("src/a.py", "")})

	if reply["rung"] != 0 {
		t.Fatalf("one session editing its own last touch should not collide with itself, got rung %v: %+v", reply["rung"], reply)
	}
}

// Two different sessions relayed down the SAME connection, editing the same
// region: this is the case the bug hid. Before the fix, both events carry
// the connection's identity, so Classify's self-skip (o.Agent ==
// incoming.Agent) fires on every comparison and two real agents colliding
// on the same file are reported as rung 0 — no collision at all.
func TestDifferentSessionsOnOneConnectionDoCollide(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	rel.Join("r1", daemon)

	rel.Handle(daemon, map[string]any{"type": "event", "agent": "sess-alpha", "human": "Alice",
		"verb": "edit", "region": goldenRegion("src/a.py", "")})
	reply := rel.Handle(daemon, map[string]any{"type": "event", "agent": "sess-beta", "human": "Bob",
		"verb": "edit", "region": goldenRegion("src/a.py", "")})

	if reply["rung"] != 3 {
		t.Fatalf("two different sessions writing the same region should collide at rung 3, got %v: %+v", reply["rung"], reply)
	}
}

// The security half of the decision: an event frame's agent/human is a
// display-layer hint, never a credential. A claim frame is arbitration, not
// display, and the relay must go on taking it under the connection's own
// latched identity no matter what a forged "agent" field in the frame says.
func TestClaimFrameCannotForgeItsAgentIdentity(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", a)

	reply := rel.Handle(a, map[string]any{
		"type": "claim", "agent": "someone-else", "human": "nobody",
		"region": goldenRegion("src/pay.py", ""), "intent": "x",
	})
	if reply["granted"] != true || reply["agent"] != "a1" {
		t.Fatalf("claim must be granted under the connection's real identity, got %+v", reply)
	}
	held := rel.registry.HolderOf("r1", Region{Path: "src/pay.py"}, nil)
	if held == nil || held.Agent != "a1" {
		t.Fatalf("lease table must record the connection's real agent, got %+v", held)
	}
}

// -- presence cap -------------------------------------------------------

// presenceHumans pulls the distinct agent ids for one human out of a
// "leases" join reply's presence array — the actual "who else is here"
// roster a joiner sees, per PresenceAgentCap's doc comment in relay.go.
func presenceAgentsFor(t *testing.T, leasesFrame Frame, human string) []string {
	t.Helper()
	raw, ok := leasesFrame["presence"].([]any)
	if !ok {
		t.Fatalf("leases frame carried no presence array: %+v", leasesFrame)
	}
	var agents []string
	for _, e := range raw {
		entry, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("presence entry wasn't an object: %+v", e)
		}
		if entry["human"] == human {
			agents = append(agents, entry["agent"].(string))
		}
	}
	return agents
}

// A human gets at most PresenceAgentCap distinct agents in the tracked
// presence roster — the join-snapshot path a newly connecting client
// actually reads, not just the live broadcast. First 5 seen for Alice keep
// their slots; the 6th never gets one.
func TestPresenceCapLimitsDistinctAgentsPerHuman(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	watcher := &recorder{agent: "watcher", human: "dev"}
	rel.Join("r1", daemon)
	rel.Join("r1", watcher)
	watcher.sent = nil

	for i := 1; i <= 6; i++ {
		rel.Handle(daemon, map[string]any{
			"type": "event", "agent": fmt.Sprintf("sess-%d", i), "human": "Alice",
			"verb": "edit", "region": goldenRegion(fmt.Sprintf("src/%d.py", i), ""),
		})
	}

	// The live broadcast to an already-joined watcher must skip the 6th too
	// — LiveDirector on the web side spawns one character per distinct
	// agent id straight off this frame, with no cap of its own.
	var broadcastAgents []string
	for _, f := range watcher.sent {
		if f["type"] == "presence" {
			broadcastAgents = append(broadcastAgents, f["agent"].(string))
		}
	}
	if len(broadcastAgents) != PresenceAgentCap {
		t.Fatalf("expected %d live presence broadcasts, got %d: %+v", PresenceAgentCap, len(broadcastAgents), broadcastAgents)
	}
	for _, a := range broadcastAgents {
		if a == "sess-6" {
			t.Fatalf("6th distinct agent for a human should never reach the live broadcast, got %+v", broadcastAgents)
		}
	}

	// The actual deliverable: a client joining now sees at most 5 of
	// Alice's agents in its own join snapshot, and never sess-6.
	latecomer := &recorder{agent: "latecomer", human: "dev"}
	rel.Join("r1", latecomer)
	var leasesFrame Frame
	for _, f := range latecomer.sent {
		if f["type"] == "leases" {
			leasesFrame = f
		}
	}
	if leasesFrame == nil {
		t.Fatalf("latecomer never got a leases/join reply: %+v", latecomer.sent)
	}
	aliceAgents := presenceAgentsFor(t, leasesFrame, "Alice")
	if len(aliceAgents) > PresenceAgentCap {
		t.Fatalf("expected at most %d tracked agents for Alice, got %d: %+v", PresenceAgentCap, len(aliceAgents), aliceAgents)
	}
	for _, a := range aliceAgents {
		if a == "sess-6" {
			t.Fatalf("6th distinct agent for a human should not get a presence slot, got %+v", aliceAgents)
		}
	}
}

// The cap limits how many distinct agents a human occupies, not how often
// an already-tracked one is heard from: once the cap is full, one of the
// five originals must still broadcast normally.
func TestPresenceCapKeepsTrackedAgentsUpdating(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	watcher := &recorder{agent: "watcher", human: "dev"}
	rel.Join("r1", daemon)
	rel.Join("r1", watcher)

	for i := 1; i <= 5; i++ {
		rel.Handle(daemon, map[string]any{
			"type": "event", "agent": fmt.Sprintf("sess-%d", i), "human": "Alice",
			"verb": "edit", "region": goldenRegion(fmt.Sprintf("src/%d.py", i), ""),
		})
	}
	watcher.sent = nil

	rel.Handle(daemon, map[string]any{
		"type": "event", "agent": "sess-1", "human": "Alice",
		"verb": "edit", "region": goldenRegion("src/1-again.py", ""),
	})

	if len(watcher.sent) != 1 || watcher.sent[0]["type"] != "presence" || watcher.sent[0]["agent"] != "sess-1" {
		t.Fatalf("an already-tracked agent must keep broadcasting once the cap is full, got %+v", watcher.sent)
	}
}

// The fail-open half of the deliverable: a 6th session's own claim is
// arbitrated on the connection's latched identity (conn.Agent()/Human()),
// never on the presence buffer, so it must be granted exactly as normally
// as any other claim regardless of whether its human is already at the
// presence cap.
func TestPresenceCapDoesNotBlockClaimForCappedAgent(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	rel.Join("r1", daemon)

	for i := 1; i <= 5; i++ {
		rel.Handle(daemon, map[string]any{
			"type": "event", "agent": fmt.Sprintf("sess-%d", i), "human": "Alice",
			"verb": "edit", "region": goldenRegion(fmt.Sprintf("src/%d.py", i), ""),
		})
	}

	sixth := &recorder{agent: "sess-6", human: "Alice"}
	rel.Join("r1", sixth)
	reply := rel.Handle(sixth, map[string]any{
		"type": "claim", "region": goldenRegion("src/6.py", ""), "intent": "work",
	})
	if reply["granted"] != true || reply["agent"] != "sess-6" {
		t.Fatalf("a capped-out agent's own claim must still be granted normally, got %+v", reply)
	}
	held := rel.registry.HolderOf("r1", Region{Path: "src/6.py"}, nil)
	if held == nil || held.Agent != "sess-6" {
		t.Fatalf("lease table must record the 6th agent's claim despite the presence cap, got %+v", held)
	}
}

// One human's full cap must not spill over onto another human's agents.
func TestPresenceCapIsPerHuman(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	daemon := &recorder{agent: "presenced@host", human: "mohsen-agentai"}
	watcher := &recorder{agent: "watcher", human: "dev"}
	rel.Join("r1", daemon)
	rel.Join("r1", watcher)

	for i := 1; i <= 5; i++ {
		rel.Handle(daemon, map[string]any{
			"type": "event", "agent": fmt.Sprintf("sess-%d", i), "human": "Alice",
			"verb": "edit", "region": goldenRegion(fmt.Sprintf("src/%d.py", i), ""),
		})
	}
	watcher.sent = nil

	rel.Handle(daemon, map[string]any{
		"type": "event", "agent": "bob-1", "human": "Bob",
		"verb": "edit", "region": goldenRegion("src/bob.py", ""),
	})

	if len(watcher.sent) != 1 || watcher.sent[0]["agent"] != "bob-1" || watcher.sent[0]["human"] != "Bob" {
		t.Fatalf("a different human's first agent must not be capped by another human's tracked agents, got %+v", watcher.sent)
	}
}
