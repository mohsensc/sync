// agent-presence-mcp serves the agent-presence MCP tools over stdio — the
// Go port of python/src/agent_presence/mcp_server.py (#32). One process
// per Claude Code session; `claude mcp add agent-presence -- <this binary>`
// is the whole install.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/mohsensc/sync/go/internal/mcptools"
	"github.com/mohsensc/sync/go/internal/metrics"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("agent-presence-mcp", flag.ContinueOnError)
	cwd := fs.String("cwd", "", "repo to derive room and human from (default: current directory)")
	fs.StringVar(cwd, "C", "", "shorthand for -cwd")
	room := fs.String("room", "", fmt.Sprintf("override the derived room id (env %s)", mcptools.RoomEnv))
	agent := fs.String("agent", "", fmt.Sprintf("override the session id (env %s)", mcptools.AgentEnv))
	human := fs.String("human", "", fmt.Sprintf("override the name from git config user.email (env %s)", mcptools.HumanEnv))
	relayURL := fs.String("relay", "", fmt.Sprintf("relay url to connect to (env %s, default %s)", mcptools.RelayEnv, mcptools.DefaultRelayURL))
	logLevel := fs.String("log-level", envOr("AGENT_PRESENCE_LOG_LEVEL", "INFO"), "log level (env AGENT_PRESENCE_LOG_LEVEL, default INFO)")
	fs.SetOutput(os.Stderr)
	if err := fs.Parse(args); err != nil {
		return 2
	}

	if !validLogLevel(*logLevel) {
		fmt.Fprintf(os.Stderr, "agent-presence-mcp: unknown log level %q\n", *logLevel)
		return 2
	}

	// stderr only. stdout is the transport — one stray line there and the
	// client sees a protocol error instead of a tool list.
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags)

	// Flags win over env, env wins over what git says — setting the env
	// var is how the flag reaches the derivation helpers, which is also
	// how build_tools sees the same answer a nested call would.
	overrides := []struct{ value, env string }{
		{*room, mcptools.RoomEnv}, {*agent, mcptools.AgentEnv},
		{*human, mcptools.HumanEnv}, {*relayURL, mcptools.RelayEnv},
	}
	for _, o := range overrides {
		if o.value != "" {
			os.Setenv(o.env, o.value)
		}
	}

	workdir := *cwd
	if workdir == "" {
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintln(os.Stderr, "agent-presence-mcp: cannot read cwd:", err)
			return 1
		}
		workdir = wd
	}

	// One registry for the whole process — see internal/metrics's package
	// comment. Nothing here scrapes it: there's no relay connection open
	// yet to push it over, and building that transport belongs wherever
	// the daemon's own equivalent gets built, not duplicated here.
	reg := metrics.New()

	tools := mcptools.BuildTools(workdir, "", reg)
	defer tools.Close()

	log.Printf("serving mcp over stdio: room=%s agent=%s human=%s",
		tools.Room(), tools.Agent(), tools.Human())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := mcptools.RunStdio(ctx, tools); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "agent-presence-mcp:", err)
		return 1
	}
	return 0
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func validLogLevel(level string) bool {
	switch strings.ToUpper(level) {
	case "DEBUG", "INFO", "WARNING", "WARN", "ERROR", "CRITICAL", "FATAL":
		return true
	}
	return false
}
