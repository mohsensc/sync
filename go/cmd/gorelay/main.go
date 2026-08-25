// Command gorelay is the relay: leases, wait-die, the ladder, negotiation,
// the org policy floor and fan-out. See docs/relay-parity.md for how it
// was verified against python/tests/, the parity oracle that proved it
// correct before the Python relay was deleted.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/relaysrv"
)

const defaultHost = "127.0.0.1"
const defaultPort = 8799

// envPort reads a port from the environment, reporting rather than exiting
// on a bad value. ok is false when the variable is unset.
//
// It used to print and os.Exit(2) inline, which was a problem of ordering
// rather than of policy: a flag default is evaluated where it is written,
// before flag.Parse runs, so `AGENT_PRESENCE_PORT=abc gorelay --port 9000`
// died on the environment before it ever read the flag that was there to
// override it. The flag's own help calls the env var the default, which
// implies an explicit --port wins.
//
// Still a hard failure when nothing overrides it — a typo in a unit file
// should be loud and name itself, not silently fall back to 8799 and leave
// somebody wondering why the port they set isn't the port that's bound.
func envPort(name string) (int, bool, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, false, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, true, fmt.Errorf("%s must be an integer, got %q", name, raw)
	}
	return n, true, nil
}

// explicitlySet is whether the operator actually passed this flag, as
// opposed to it carrying its default. flag.Visit walks only what was set.
func explicitlySet(name string) bool {
	seen := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			seen = true
		}
	})
	return seen
}

func main() {
	host := flag.String("host", envOr("AGENT_PRESENCE_HOST", defaultHost),
		"interface to bind (env AGENT_PRESENCE_HOST). Traffic is unencrypted "+
			"unless --tls-cert/--tls-key are set; see docs/threat-model.md "+
			"before binding anything but loopback.")
	port := flag.Int("port", defaultPort,
		"port to bind, 0 picks a free one (env AGENT_PRESENCE_PORT)")
	tlsCert := flag.String("tls-cert", os.Getenv("AGENT_PRESENCE_TLS_CERT"),
		"PEM certificate (env AGENT_PRESENCE_TLS_CERT). Terminates wss:// "+
			"instead of ws:// when set together with --tls-key. Unset by "+
			"default: plaintext ws:// on loopback needs nothing here. See "+
			"docs/tls-dev-cert.md for a self-signed dev cert.")
	tlsKey := flag.String("tls-key", os.Getenv("AGENT_PRESENCE_TLS_KEY"),
		"private key matching --tls-cert (env AGENT_PRESENCE_TLS_KEY)")
	metricsAddr := flag.String("metrics-addr", os.Getenv("AGENT_PRESENCE_METRICS_ADDR"),
		"address to serve /metrics on (env AGENT_PRESENCE_METRICS_ADDR), e.g. "+
			"127.0.0.1:9090. Unset by default: presenced and agent-presence-mcp "+
			"run on developer laptops Prometheus cannot reach, so this relay is "+
			"the one place their counters (pushed up the connection they already "+
			"hold — see internal/metrics's package doc) become scrapeable, and an "+
			"endpoint that shows up on a well-known port without anyone asking is "+
			"a way to leak a room's shape to whoever shares the network.")
	flag.Parse()

	// The env var supplies the default, so an explicit --port wins and a
	// malformed env var is only fatal when nothing overrode it.
	if !explicitlySet("port") {
		n, set, err := envPort("AGENT_PRESENCE_PORT")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if set {
			*port = n
		}
	}

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
	reg := metrics.New()
	relay := relaysrv.NewRelay(relaysrv.RealClock{}, roster, reg)

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

	if ms := relaysrv.MetricsServer(*metricsAddr, reg); ms != nil {
		// Bind before logging success, same as the relay listener above: a
		// taken --metrics-addr must not read as a healthy relay with a quiet
		// /metrics — docs/monitoring.md's up==0 check only catches that if
		// the process is actually dead, not limping along unscraped.
		mln, err := net.Listen("tcp", *metricsAddr)
		if err != nil {
			log.Fatalf("cannot bind metrics %s — %s", *metricsAddr, err)
		}
		log.Printf("metrics listening on %s", mln.Addr())
		go func() {
			<-ctx.Done()
			_ = ms.Close()
		}()
		go func() {
			if err := ms.Serve(mln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("metrics server stopped: %s", err)
			}
		}()
	}

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
