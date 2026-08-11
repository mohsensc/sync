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
	"strings"
	"syscall"

	"github.com/mohsensc/sync/go/internal/daemon"
	"github.com/mohsensc/sync/go/internal/repo"
)

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envIsTrue(v string) bool {
	switch v {
	case "1", "true", "TRUE", "True", "yes", "on":
		return true
	}
	return false
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

	opts := daemon.Options{
		Sock:       sock,
		RelayURL:   envOr("AGENT_PRESENCE_RELAY", "ws://127.0.0.1:8799"),
		Room:       repo.DiscoverRoom(os.Getenv("AGENT_PRESENCE_ROOM"), cwd),
		Agent:      envOr("AGENT_PRESENCE_AGENT", "presenced@"+hostname()),
		Human:      envOr("AGENT_PRESENCE_HUMAN", envOr("USER", hostname())),
		Principal:  trimASCII(os.Getenv("AGENT_PRESENCE_PRINCIPAL")),
		Token:      discoverToken(os.Getenv("AGENT_PRESENCE_TOKEN"), os.Getenv("XDG_CONFIG_HOME"), os.Getenv("HOME")),
		Unattended: envIsTrue(os.Getenv("AGENT_PRESENCE_UNATTENDED")),

		// Only consulted when AGENT_PRESENCE_RELAY is wss:// — see
		// docs/tls-dev-cert.md. RelayTLSCAFile trusts one extra PEM on
		// top of the system pool; the skip-verify env var is deliberately
		// not named anything an operator could set by accident.
		RelayTLSCAFile:             trimASCII(os.Getenv("AGENT_PRESENCE_RELAY_CA")),
		RelayTLSInsecureSkipVerify: envIsTrue(os.Getenv("AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY")),

		Snapshot:    envOr("AGENT_PRESENCE_SNAPSHOT", runtime+"/agent-presence.json"),
		PolicyCache: envOr("AGENT_PRESENCE_POLICY_CACHE", runtime+"/agent-presence.policy.json"),
		Journal:     discoverJournalPath(os.Getenv("AGENT_PRESENCE_JOURNAL"), runtime),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if _, err := daemon.New(ctx, opts); err != nil {
		fmt.Fprintln(os.Stderr, "presenced: failed to start:", err)
		os.Exit(1)
	}

	<-ctx.Done()
}

// discoverJournalPath is main.cpp's discover_journal: two daemons sharing
// an XDG_RUNTIME_DIR — the normal way to run one per repo — need their own
// journal, same as they already need their own socket and snapshot.
func discoverJournalPath(configured, runtime string) string {
	if configured != "" {
		return configured
	}
	return runtime + "/agent-presence.decisions.jsonl"
}
