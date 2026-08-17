package main

import (
	"testing"
)

func TestSiblingPathKeepsTheDefaultFilenamesThisAlwaysUsed(t *testing.T) {
	// The readers on the other side of these files — python's `ap why` and
	// `ap doctor`, and scripts/statusline-presence.sh — hardcode these
	// names. Deriving them from the socket has to leave the default spelling
	// untouched or the daemon and its readers part company on upgrade.
	sock := "/run/user/501/agent-presence.sock"
	for _, tc := range []struct{ suffix, want string }{
		{"json", "/run/user/501/agent-presence.json"},
		{"policy.json", "/run/user/501/agent-presence.policy.json"},
		{"decisions.jsonl", "/run/user/501/agent-presence.decisions.jsonl"},
	} {
		if got := siblingPath(sock, tc.suffix); got != tc.want {
			t.Errorf("siblingPath(%q, %q) = %q, want %q", sock, tc.suffix, got, tc.want)
		}
	}
}

// TestTwoDaemonsInOneRuntimeDirGetDistinctDefaultPaths is the regression
// case the audit verified: two presenced processes sharing XDG_RUNTIME_DIR
// (the normal way to run one per repo) with distinct AGENT_PRESENCE_SOCK
// values still shared one journal, because only the socket path was ever
// forced unique — 1,200 decisions written by each daemon landed as 2,400
// interleaved lines in a single file.
//
// Keyed off the socket rather than the room because two daemons on one repo
// share a room and would still have collided, and because every reader would
// have needed its own copy of the room derivation.
func TestTwoDaemonsInOneRuntimeDirGetDistinctDefaultPaths(t *testing.T) {
	sockA := "/run/user/501/agent-presence.sock"
	sockB := "/run/user/501/ap2.sock"

	for _, tc := range []struct {
		name       string
		defaultFor func(sock string) string
	}{
		{"snapshot", func(sock string) string { return siblingPath(sock, "json") }},
		{"policy cache", func(sock string) string { return siblingPath(sock, "policy.json") }},
		{"journal", func(sock string) string { return discoverJournalPath("", sock) }},
	} {
		if a, b := tc.defaultFor(sockA), tc.defaultFor(sockB); a == b {
			t.Errorf("%s: two daemons in one runtime dir got the same default path %q", tc.name, a)
		}
	}
}

func TestSiblingPathOfASocketWithNoExtension(t *testing.T) {
	if got := siblingPath("/run/user/501/apd", "json"); got != "/run/user/501/apd.json" {
		t.Fatalf("got %q", got)
	}
}

func TestDiscoverJournalPathExplicitOverrideWins(t *testing.T) {
	got := discoverJournalPath("/custom/path.jsonl", "/run/user/501/agent-presence.sock")
	if got != "/custom/path.jsonl" {
		t.Fatalf("got %q, want the explicit override untouched", got)
	}
}

// TestEnvTruthyAcceptsPaddingAndCase exercises envTruthy itself — the
// function main() actually calls for AGENT_PRESENCE_UNATTENDED and
// AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY — not just envflag.Truthy in
// isolation. presenced used to parse these with its own hand-rolled
// switch, matching only a fixed list of literals and rejecting a
// leading/trailing space or "YES" in caps, and presenced is the one
// binary where being wrong here actually gates a tool call. Reverting
// envTruthy to that old switch fails this test; calling envflag.Truthy
// directly instead of through envTruthy would not have.
func TestEnvTruthyAcceptsPaddingAndCase(t *testing.T) {
	const key = "AGENT_PRESENCE_UNATTENDED_TEST"
	cases := []string{" true ", "TRUE", "YES", "\ton\n"}
	for _, v := range cases {
		t.Setenv(key, v)
		if !envTruthy(key) {
			t.Errorf("envTruthy(%q=%q) = false, want true — presenced's old envIsTrue rejected this", key, v)
		}
	}
}
