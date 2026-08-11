// Command gorelay is the relay: leases, wait-die, the ladder, negotiation,
// the org policy floor and fan-out. See docs/relay-parity.md for how it
// was verified against python/tests/, the parity oracle that proved it
// correct before the Python relay was deleted.
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
		"interface to bind (env AGENT_PRESENCE_HOST). Traffic is unencrypted "+
			"unless --tls-cert/--tls-key are set; see docs/threat-model.md "+
			"before binding anything but loopback.")
	port := flag.Int("port", envPort("AGENT_PRESENCE_PORT", defaultPort),
		"port to bind, 0 picks a free one (env AGENT_PRESENCE_PORT)")
	tlsCert := flag.String("tls-cert", os.Getenv("AGENT_PRESENCE_TLS_CERT"),
		"PEM certificate (env AGENT_PRESENCE_TLS_CERT). Terminates wss:// "+
			"instead of ws:// when set together with --tls-key. Unset by "+
			"default: plaintext ws:// on loopback needs nothing here. See "+
			"docs/tls-dev-cert.md for a self-signed dev cert.")
	tlsKey := flag.String("tls-key", os.Getenv("AGENT_PRESENCE_TLS_KEY"),
		"private key matching --tls-cert (env AGENT_PRESENCE_TLS_KEY)")
	flag.Parse()

	if (*tlsCert == "") != (*tlsKey == "") {
		fmt.Fprintln(os.Stderr, "--tls-cert and --tls-key must be given together")
		os.Exit(2)
	}
	if *tlsCert == "" && !isLoopback(*host) {
		log.Printf("binding %s with no --tls-cert/--tls-key: traffic (including "+
			"the bearer token at join) crosses the wire in the clear. See "+
			"docs/threat-model.md before doing this on an untrusted network.", *host)
	}

	roster := relaysrv.DiscoverRoster()
	relay := relaysrv.NewRelay(relaysrv.RealClock{}, roster)

	srv := &relaysrv.Server{
		Addr: fmt.Sprintf("%s:%d", *host, *port), Relay: relay,
		TLSCert: *tlsCert, TLSKey: *tlsKey,
	}
	addr, err := srv.Listen()
	if err != nil {
		log.Fatalf("cannot bind %s:%d — %s", *host, *port, err)
	}
	if *tlsCert != "" {
		log.Printf("TLS enabled: terminating wss://")
	}
	log.Printf("relay listening on %s", addr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Serve(ctx); err != nil {
		log.Fatalf("relay stopped: %s", err)
	}
	log.Println("shutting down")
}

func isLoopback(host string) bool {
	switch host {
	case defaultHost, "localhost", "::1":
		return true
	default:
		return false
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
