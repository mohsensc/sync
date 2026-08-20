// presenced is the daemon: coalesces hook events, forwards them to the
// Python relay, and answers PreToolUse decisions from a local lease cache.
// This is the Go port of cpp/daemon — see docs/go-daemon.md for what wave 1
// shipped and issue #18 for the rest. It is the default and only daemon;
// cpp/daemon has been deleted. cpp/hook stays C++ — see
// docs/gohook-spike.md for why — and this binary speaks the exact same
// unix-socket protocol to it that the C++ daemon did.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/mohsensc/sync/go/internal/daemon"
	"github.com/mohsensc/sync/go/internal/envflag"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/repo"
)

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

// envTruthy is the one place presenced reads a boolean env var — see
// envflag.Truthy's doc comment. presenced used to parse these with its own
// hand-rolled switch, matching a fixed list of literals and rejecting
// padding or "YES" in caps, and presenced is the one binary where being
// wrong here actually gates a tool call.
func envTruthy(key string) bool {
	return envflag.Truthy(os.Getenv(key))
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown-host"
	}
	return h
}

func trimASCII(s string) string {
	return strings.Trim(s, " \t\r\n\v\f")
}

// maxTokenBytes: secrets.token_urlsafe(32) is 43 characters; this is orders
// of magnitude above that and still small enough that being pointed at the
// wrong file costs a read and not a process. Matches main.cpp's
// kMaxTokenBytes.
const maxTokenBytes = 4096

// discoverToken is main.cpp's discover_token: $AGENT_PRESENCE_TOKEN first,
// then the file `ap principals add` tells people to write. Every failure is
// empty: no token means the relay grants the default tier, same as no
// roster at all.
func discoverToken(envToken, configHome, home string) string {
	if envToken != "" {
		return trimASCII(envToken)
	}
	base := configHome
	if base == "" {
		if home == "" {
			return ""
		}
		base = home + "/.config"
	}
	path := base + "/agent-presence/token"

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
		if line := trimASCII(sc.Text()); line != "" {
			return line // the first non-blank line, so a note under the secret still works
		}
	}
	return ""
}

func main() {
	flag.Parse()

	runtime := envOr("XDG_RUNTIME_DIR", envOr("TMPDIR", "/tmp"))
	sock := envOr("AGENT_PRESENCE_SOCK", runtime+"/agent-presence.sock")

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "presenced: cannot read cwd:", err)
		os.Exit(1)
	}

	room := repo.DiscoverRoom(os.Getenv("AGENT_PRESENCE_ROOM"), cwd)

	// Resolved here, next to the room, because both answer the same question
	// about the same checkout and a daemon that found one but not the other
	// is in a state nothing downstream can report. daemon.New() would fall
	// back to this same lookup, but only from its own cwd — and a daemon
	// started by launchd or systemd runs from wherever the unit says, which
	// is usually not the repo. Region keys would then silently stay absolute
	// with nothing to point at.
	root, _ := repo.FindRepoRoot(cwd)
	if room != "" && root == "" {
		fmt.Fprintln(os.Stderr, "presenced: joined a room but found no repo root under", cwd,
			"— regions will be shared under absolute paths and will not match a teammate's")
	}

	opts := daemon.Options{
		Sock:       sock,
		Root:       root,
		RelayURL:   envOr("AGENT_PRESENCE_RELAY", "ws://127.0.0.1:8799"),
		Room:       room,
		Agent:      envOr("AGENT_PRESENCE_AGENT", "presenced@"+hostname()),
		Human:      envOr("AGENT_PRESENCE_HUMAN", envOr("USER", hostname())),
		Principal:  trimASCII(os.Getenv("AGENT_PRESENCE_PRINCIPAL")),
		Token:      discoverToken(os.Getenv("AGENT_PRESENCE_TOKEN"), os.Getenv("XDG_CONFIG_HOME"), os.Getenv("HOME")),
		Unattended: envTruthy("AGENT_PRESENCE_UNATTENDED"),

		// Only consulted when AGENT_PRESENCE_RELAY is wss:// — see
		// docs/tls-dev-cert.md. RelayTLSCAFile trusts one extra PEM on
		// top of the system pool; the skip-verify env var is deliberately
		// not named anything an operator could set by accident.
		RelayTLSCAFile:             trimASCII(os.Getenv("AGENT_PRESENCE_RELAY_CA")),
		RelayTLSInsecureSkipVerify: envTruthy("AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY"),

		Snapshot:    envOr("AGENT_PRESENCE_SNAPSHOT", siblingPath(sock, "json")),
		PolicyCache: envOr("AGENT_PRESENCE_POLICY_CACHE", siblingPath(sock, "policy.json")),
		Journal:     discoverJournalPath(os.Getenv("AGENT_PRESENCE_JOURNAL"), sock),

		// presenced serves nothing itself — a laptop behind NAT can't be
		// scraped, so there is no metrics flag here and never will be (see
		// internal/metrics's package comment). The registry still gets
		// built: it's what daemon.tick pushes to the relay as periodic
		// stats frames, the only route these numbers have off this
		// machine.
		Metrics: metrics.New(),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d, err := daemon.New(ctx, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "presenced: failed to start:", err)
		os.Exit(1)
	}
	defer d.Close()

	<-ctx.Done()
}

// Sibling paths default off the socket's own name, not off a fixed filename
// in the runtime dir.
//
// Two daemons sharing an XDG_RUNTIME_DIR — the normal way to run one per
// repo — need their sockets kept apart. hooksock.Start probes the path
// before binding and takes a flock on a sidecar lockfile around that probe,
// so a second Start against the same path can't unlink a live one out from
// under it (see #88); that part is covered at the socket layer. What's left
// is everything derived from the socket path, which used to fall back to
// one fixed filename regardless of which daemon it belonged to and
// silently shared one journal, one snapshot and one policy cache. 1,200
// decisions from each landed as 2,400 interleaved lines in one file, past
// the trim.
//
// The socket is the knob an operator already turns to run a second daemon,
// so deriving the rest from it needs no new derivation and no new agreement
// between languages. The default socket name yields exactly the filenames
// this always used, so `ap why`, `ap doctor` and statusline-presence.sh keep
// reading what they read today. Point a second daemon at ap2.sock and its
// journal is ap2.decisions.jsonl, beside it.
//
// Scoping by room was the other candidate and is worse twice over: two
// daemons on one repo share a room, so it doesn't fix them, and the python
// and shell readers would each need their own copy of the room derivation —
// a fresh cross-language contract, which is the class of bug this whole
// change is paying off.
func siblingPath(sock, suffix string) string {
	dir := filepath.Dir(sock)
	stem := strings.TrimSuffix(filepath.Base(sock), filepath.Ext(sock))
	if stem == "" {
		stem = "agent-presence"
	}
	return filepath.Join(dir, stem+"."+suffix)
}

// discoverJournalPath is main.cpp's discover_journal: two daemons sharing
// an XDG_RUNTIME_DIR — the normal way to run one per repo — need their own
// journal, same as they already need their own socket and snapshot. An
// explicit override still wins outright — an operator naming a path means
// it, room or no room.
func discoverJournalPath(configured, sock string) string {
	if configured != "" {
		return configured
	}
	return siblingPath(sock, "decisions.jsonl")
}
