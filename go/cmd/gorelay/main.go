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
	"time"

	"github.com/mohsensc/sync/go/internal/envflag"
	"github.com/mohsensc/sync/go/internal/hosted"
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
// before flag.Parse runs, so `AGENT_SYNC_PORT=abc gorelay --port 9000`
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

func deploymentPort() (int, bool, error) {
	if os.Getenv("AGENT_SYNC_PORT") != "" {
		return envPort("AGENT_SYNC_PORT")
	}
	// Container platforms conventionally inject PORT. The product-specific
	// variable remains authoritative when both are present.
	return envPort("PORT")
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
	host := flag.String("host", envOr("AGENT_SYNC_HOST", defaultHost),
		"interface to bind (env AGENT_SYNC_HOST). Traffic is unencrypted "+
			"unless --tls-cert/--tls-key are set; see docs/threat-model.md "+
			"before binding anything but loopback.")
	port := flag.Int("port", defaultPort,
		"port to bind, 0 picks a free one (env AGENT_SYNC_PORT)")
	tlsCert := flag.String("tls-cert", os.Getenv("AGENT_SYNC_TLS_CERT"),
		"PEM certificate (env AGENT_SYNC_TLS_CERT). Terminates wss:// "+
			"instead of ws:// when set together with --tls-key. Unset by "+
			"default: plaintext ws:// on loopback needs nothing here. See "+
			"docs/tls-dev-cert.md for a self-signed dev cert.")
	tlsKey := flag.String("tls-key", os.Getenv("AGENT_SYNC_TLS_KEY"),
		"private key matching --tls-cert (env AGENT_SYNC_TLS_KEY)")
	metricsAddr := flag.String("metrics-addr", os.Getenv("AGENT_SYNC_METRICS_ADDR"),
		"address to serve /metrics on (env AGENT_SYNC_METRICS_ADDR), e.g. "+
			"127.0.0.1:9090. Unset by default: presenced and agent-sync-mcp "+
			"run on developer laptops Prometheus cannot reach, so this relay is "+
			"the one place their counters (pushed up the connection they already "+
			"hold — see internal/metrics's package doc) become scrapeable, and an "+
			"endpoint that shows up on a well-known port without anyone asking is "+
			"a way to leak a room's shape to whoever shares the network.")
	hostedMode := flag.Bool("hosted", envflag.Truthy(os.Getenv("AGENT_SYNC_HOSTED")),
		"require account tokens and persist bounded dashboard projections "+
			"(env AGENT_SYNC_HOSTED; requires DATABASE_URL)")
	flag.Parse()

	// The env var supplies the default, so an explicit --port wins and a
	// malformed env var is only fatal when nothing overrode it.
	if !explicitlySet("port") {
		n, set, err := deploymentPort()
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

	var (
		hostedStore *hosted.Store
		projector   *projectionWriter
	)
	roster := relaysrv.DiscoverRoster()
	if *hostedMode {
		databaseURL := os.Getenv("DATABASE_URL")
		if databaseURL == "" {
			log.Fatal("hosted mode requires DATABASE_URL")
		}
		startupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		var err error
		hostedStore, err = hosted.Open(startupCtx, databaseURL)
		if err == nil {
			err = hostedStore.Ping(startupCtx)
		}
		if err == nil {
			err = hostedStore.Migrate(startupCtx)
		}
		cancel()
		if err != nil {
			log.Fatalf("hosted database startup failed: %v", err)
		}
		// Account tokens are the hosted authority. A local principals file must
		// never silently add another identity or policy boundary.
		roster = relaysrv.InertRoster()
		projector = newProjectionWriter(hostedStore)
		log.Printf("hosted account isolation enabled")
	}
	reg := metrics.New()
	relay := relaysrv.NewRelay(relaysrv.RealClock{}, roster, reg)
	if projector != nil {
		relay.SetProjectionSink(projector)
	}

	srv := &relaysrv.Server{
		Addr: fmt.Sprintf("%s:%d", *host, *port), Relay: relay,
		TLSCert: *tlsCert, TLSKey: *tlsKey,
	}
	if hostedStore != nil {
		srv.HostedAuth = storeAuthenticator{store: hostedStore}
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
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if projector != nil {
		if err := projector.Close(shutdownCtx); err != nil {
			log.Printf("hosted projector shutdown: %v", err)
		}
	}
	if hostedStore != nil {
		if err := hostedStore.Close(shutdownCtx); err != nil {
			log.Printf("hosted database shutdown: %v", err)
		}
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
