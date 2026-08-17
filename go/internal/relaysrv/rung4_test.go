package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Ported from python/tests/test_rung4.py's core cases — rung 4 is a
// straight port (task instructions: port it as-is, off by default,
// advisory; a separate track owns improving the scorer).

const jwtIntent = "add JWT refresh to auth"
const tokenIntent = "implement token refresh in the login flow"
const unrelatedIntent = "fix the CSS grid on the settings page"

func declaringEvent(intent, agent, path string) (AgentEvent, string) {
	return AgentEvent{Room: "r1", Human: "dev", Agent: agent, Kind: "claim",
		Source: SourceMCP, Verb: "edit", Region: Region{Path: path}, Ts: 1000.0}, intent
}

func declaredActivity(intent, agent, path string) Activity {
	return Activity{Agent: agent, Human: "sara", Verb: "edit", Region: Region{Path: path}, Intent: intent, Source: SourceMCP}
}

func TestRung4TruePositiveFires(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	got := Classify(event, []Activity{declaredActivity(tokenIntent, "a1", "src/login/session.py")}, intent)
	if got != 4 {
		t.Fatalf("got rung %d, want 4", got)
	}
}

func TestRung4TrueNegativeStaysSilent(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	got := Classify(event, []Activity{declaredActivity(unrelatedIntent, "a1", "src/login/session.py")}, intent)
	if got != 0 {
		t.Fatalf("got rung %d, want 0", got)
	}
}

func TestRung4ANearMissStaysBelowTheBar(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent("add retry with backoff to the S3 uploader", "a2", "src/auth/jwt.py")
	peer := declaredActivity("add retry with backoff to the GCS uploader", "a1", "src/login/session.py")
	if got := Classify(event, []Activity{peer}, intent); got != 0 {
		t.Fatalf("got rung %d, want 0 (a near miss must not fire)", got)
	}
}

func TestRung4MatchCarriesWhoAndWhat(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	red := redundantPeer(event, []Activity{declaredActivity(tokenIntent, "a1", "src/login/session.py")}, intent)
	if red == nil {
		t.Fatal("expected a match")
	}
	if red.Agent != "a1" || red.Human != "sara" || red.Intent != tokenIntent {
		t.Fatalf("got %+v", red)
	}
	if red.Region.Path != "src/login/session.py" {
		t.Fatalf("got region path %q", red.Region.Path)
	}
	if red.Score < defaultRung4Threshold {
		t.Fatalf("got score %f, want >= %f", red.Score, defaultRung4Threshold)
	}
}

func TestRung4StrongestMatchWinsNotFirst(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	peers := []Activity{
		declaredActivity(unrelatedIntent, "a1", "src/x.py"),
		declaredActivity(tokenIntent, "a3", "src/login/session.py"),
	}
	red := redundantPeer(event, peers, intent)
	if red == nil || red.Agent != "a3" {
		t.Fatalf("expected the strongest match (a3), got %+v", red)
	}
}

func TestRung4OffByDefault(t *testing.T) {
	// No AGENT_PRESENCE_RUNG4 set: rung4Enabled must read false, and
	// Classify must never reach 4 no matter how strong the text match.
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	got := Classify(event, []Activity{declaredActivity(tokenIntent, "a1", "src/login/session.py")}, intent)
	if got == 4 {
		t.Fatalf("rung 4 fired with the flag unset")
	}
}

func TestRung4RequiresBothSidesMCPDeclared(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	hookOnly := Activity{Agent: "a1", Human: "sara", Verb: "edit", Region: Region{Path: "src/login/session.py"}, Intent: "", Source: SourceHook}
	if got := Classify(event, []Activity{hookOnly}, intent); got == 4 {
		t.Fatalf("rung 4 fired against a hook-only (no intent) peer")
	}
}

func TestRung4SamePathIsNotRung4(t *testing.T) {
	// Same-path contention is rungs 0-3's business, decided on facts, not
	// a text guess.
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	event, intent := declaringEvent(jwtIntent, "a2", "src/auth/jwt.py")
	peer := declaredActivity(tokenIntent, "a1", "src/auth/jwt.py")
	if got := redundantPeer(event, []Activity{peer}, intent); got != nil {
		t.Fatalf("expected no rung-4 match on the same path, got %+v", got)
	}
}

// -- wired into the relay: claim_result carries a redundant hit ------------

func TestClaimGrantCarriesRung4RedundantWork(t *testing.T) {
	t.Setenv("AGENT_PRESENCE_RUNG4", "1")
	clock := NewVirtualClock(1000.0)
	relay := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	relay.Join("r1", a)
	relay.Join("r1", b)

	relay.Handle(a, map[string]any{"type": "claim",
		"region": goldenRegion("src/login/session.py", ""), "intent": tokenIntent})
	reply := relay.Handle(b, map[string]any{"type": "claim",
		"region": goldenRegion("src/auth/jwt.py", ""), "intent": jwtIntent})

	if reply["granted"] != true {
		t.Fatalf("expected the disjoint-region claim to be granted, got %+v", reply)
	}
	if reply["rung"] != 4 {
		t.Fatalf("expected rung 4 on the redundant claim, got %+v", reply)
	}
	redundant, ok := reply["redundant"].(Frame)
	if !ok || redundant["agent"] != "a1" {
		t.Fatalf("expected a redundant payload naming a1, got %+v", reply["redundant"])
	}
}
