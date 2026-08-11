package mcptools

import "testing"

// Unit coverage for claimReply's reshaping — python's _claim_reply, ported
// field for field. The wire round trip itself (these maps actually arrive
// over a websocket) is covered by tools_test.go and conn_test.go; this
// pins the shape claimReply produces for each branch relay.py's _on_claim
// can send, including the wait-die instruction on a refusal — the case
// test_claim_path_wait_die.py used to cover for the Python tool path.

func TestClaimReplyGranted(t *testing.T) {
	got := claimReply(map[string]any{"granted": true}, "a2")
	want := map[string]any{"granted": true}
	if len(got) != len(want) || got["granted"] != true {
		t.Fatalf("got %+v", got)
	}
}

func TestClaimReplyGrantedWithRung4Redundancy(t *testing.T) {
	redundant := map[string]any{"agent": "a9", "score": 0.9}
	got := claimReply(map[string]any{
		"granted": true, "rung": float64(4), "redundant": redundant,
	}, "a2")
	if got["granted"] != true || got["rung"] != 4 {
		t.Fatalf("got %+v", got)
	}
	if r, ok := got["redundant"].(map[string]any); !ok || r["agent"] != "a9" {
		t.Fatalf("got %+v", got["redundant"])
	}
}

func TestClaimReplyRefusedCarriesTheWaitDieDecision(t *testing.T) {
	got := claimReply(map[string]any{
		"granted": false, "held_by": "a1", "human": "sara",
		"intent": "refactor", "decision": "wait",
	}, "a2")
	if got["granted"] != false || got["held_by"] != "a1" ||
		got["held_by_human"] != "sara" || got["intent"] != "refactor" ||
		got["decision"] != "wait" {
		t.Fatalf("got %+v", got)
	}
}

func TestClaimReplyRefusedDefaultsDecisionToAbort(t *testing.T) {
	got := claimReply(map[string]any{"granted": false, "held_by": "a1"}, "a2")
	if got["decision"] != "abort" {
		t.Fatalf("got %+v, want decision=abort", got)
	}
}

func TestClaimReplyReservationGivesASecondsRetry(t *testing.T) {
	got := claimReply(map[string]any{
		"granted": false, "held_by": "a1", "reserved": true, "retry_in_ms": 2500.0,
	}, "a2")
	if got["reserved"] != true {
		t.Fatalf("got %+v", got)
	}
	if got["retry_in_s"] != 2.5 {
		t.Fatalf("got retry_in_s=%v, want 2.5", got["retry_in_s"])
	}
	moves, _ := got["moves"].([]string)
	if len(moves) != 1 || moves[0] != "DEFER" {
		t.Fatalf("got moves=%v, want [DEFER]", got["moves"])
	}
}

func TestClaimReplyHandoverNamesTheAgentAtTheFrontOfTheQueue(t *testing.T) {
	// This agent (a2) is the handover winner: retry_in_s is filled in and
	// handover_to is omitted, matching mcp_server.py's "DEFER with a
	// number on it" case.
	got := claimReply(map[string]any{
		"granted": false, "held_by": "a1", "handover_in_ms": 9000.0,
		"handover_to": "a2", "waiting": float64(1),
	}, "a2")
	if got["handover_in_s"] != 9.0 || got["retry_in_s"] != 9.0 {
		t.Fatalf("got %+v", got)
	}
	if _, has := got["handover_to"]; has {
		t.Fatalf("got %+v, handover_to should be omitted for the winner", got)
	}
	if got["waiting"] != 1 {
		t.Fatalf("got waiting=%v, want 1", got["waiting"])
	}
}

func TestClaimReplyHandoverNamesSomebodyElseWhenThisAgentIsNotTheWinner(t *testing.T) {
	got := claimReply(map[string]any{
		"granted": false, "held_by": "a1", "handover_in_ms": 9000.0,
		"handover_to": "a3", "waiting": float64(2),
	}, "a2")
	if _, has := got["retry_in_s"]; has {
		t.Fatalf("got %+v, retry_in_s should be absent when a2 isn't the winner", got)
	}
	if got["handover_to"] != "a3" {
		t.Fatalf("got %+v", got)
	}
	moves, _ := got["moves"].([]string)
	if len(moves) != 4 {
		t.Fatalf("got moves=%v, want all four", got["moves"])
	}
}
