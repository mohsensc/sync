// Command gorelay is the Go relay: leases, wait-die, the ladder, negotiation
// and fan-out, speaking the same wire protocol
// python/src/agent_presence/serve.py does. See docs/relay-parity.md for
// what is and isn't ported.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/mohsensc/sync/go/internal/relaysrv"
)

const defaultHost = "127.0.0.1"
const defaultPort = 8799

func envPort(name string, def int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s must be an integer, got %q\n", name, raw)
		os.Exit(2)
	}
	return n
}

func main() {
	host := flag.String("host", envOr("AGENT_PRESENCE_HOST", defaultHost),
		"interface to bind (env AGENT_PRESENCE_HOST). Traffic is unencrypted; see docs/threat-model.md before binding anything but loopback.")
	port := flag.Int("port", envPort("AGENT_PRESENCE_PORT", defaultPort),
		"port to bind, 0 picks a free one (env AGENT_PRESENCE_PORT)")
	flag.Parse()

	roster := relaysrv.DiscoverRoster()
	relay := relaysrv.NewRelay(relaysrv.RealClock{}, roster)

	srv := &relaysrv.Server{Addr: fmt.Sprintf("%s:%d", *host, *port), Relay: relay}
	addr, err := srv.Listen()
	if err != nil {
		log.Fatalf("cannot bind %s:%d — %s", *host, *port, err)
	}
	log.Printf("relay listening on %s", addr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Serve(ctx); err != nil {
		log.Fatalf("relay stopped: %s", err)
	}
	log.Println("shutting down")
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
