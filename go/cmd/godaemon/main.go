// godaemon is the experimental Go replacement for cpp/daemon — issue #18.
// It is off by default and opt-in: running the binary with no flag and no
// env var does nothing but explain that, and exits 0. The C++ daemon
// (agent-presence-daemon, wired into install.sh) is the one anything
// installs or starts automatically; this binary is never invoked by
// anything else in the tree.
//
// Wave 1 scope only — see docs/go-daemon.md. Missing relative to main.cpp:
// presence table, snapshot file for the statusline, policy live-reload
// beyond the compiled-in floor, decision journal, room derivation from a
// git remote (AGENT_PRESENCE_ROOM must be set explicitly), token discovery
// from disk (env var only), and TLS (#22).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/mohsensc/sync/go/internal/daemon"
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

func main() {
	enable := flag.Bool("enable", false, "actually run the daemon (off by default; see #18)")
	flag.Parse()

	if !*enable && !envIsTrue(os.Getenv("AGENT_PRESENCE_GO_DAEMON")) {
		fmt.Fprintln(os.Stderr,
			"godaemon: opt-in only. Pass -enable or set AGENT_PRESENCE_GO_DAEMON=1.\n"+
				"The C++ daemon stays the default; see docs/go-daemon.md.")
		return
	}

	runtime := envOr("XDG_RUNTIME_DIR", envOr("TMPDIR", "/tmp"))
	opts := daemon.Options{
		Sock:       envOr("AGENT_PRESENCE_SOCK", runtime+"/agent-presence.sock"),
		RelayURL:   envOr("AGENT_PRESENCE_RELAY", "ws://127.0.0.1:8799"),
		Room:       os.Getenv("AGENT_PRESENCE_ROOM"),
		Agent:      envOr("AGENT_PRESENCE_AGENT", "presenced-go@"+hostname()),
		Human:      envOr("AGENT_PRESENCE_HUMAN", envOr("USER", hostname())),
		Principal:  os.Getenv("AGENT_PRESENCE_PRINCIPAL"),
		Token:      os.Getenv("AGENT_PRESENCE_TOKEN"),
		Unattended: envIsTrue(os.Getenv("AGENT_PRESENCE_UNATTENDED")),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if _, err := daemon.New(ctx, opts); err != nil {
		fmt.Fprintln(os.Stderr, "godaemon: failed to start hook socket:", err)
		os.Exit(1)
	}

	<-ctx.Done()
}
