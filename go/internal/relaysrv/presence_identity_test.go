package relaysrv

import (
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
