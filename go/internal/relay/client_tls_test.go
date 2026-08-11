package relay

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/leases"
)

// certPEM writes an httptest TLS server's leaf certificate out as a PEM
// file — the shape AGENT_PRESENCE_RELAY_CA / TLSCAFile expects, and the
// same shape docs/tls-dev-cert.md has an operator generate by hand for a
// real self-signed relay cert.
func certPEM(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	block := &pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}
	path := filepath.Join(t.TempDir(), "relay-ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func wssURL(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	return "wss://" + strings.TrimPrefix(srv.URL, "https://")
}

func TestClientDialsWSSWithTrustedCA(t *testing.T) {
	fr := newFakeRelay()
	srv := httptest.NewTLSServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	lc := leases.New()
	c := New(Config{
		URL:       wssURL(t, srv),
		Room:      "test-room",
		Agent:     "go-daemon-test",
		TLSCAFile: certPEM(t, srv),
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.Run(ctx)

	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatalf("relay never received a join frame; last error: %s", c.LastError())
	}
	if !c.Open() {
		t.Fatalf("state = %v, want Open", c.State())
	}
}

func TestClientRejectsUntrustedCertByDefault(t *testing.T) {
	fr := newFakeRelay()
	srv := httptest.NewTLSServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	lc := leases.New()
	c := New(Config{
		URL:        wssURL(t, srv),
		Room:       "test-room",
		Agent:      "go-daemon-test",
		BackoffMin: 5 * time.Millisecond,
		BackoffMax: 20 * time.Millisecond,
		// No TLSCAFile, no TLSInsecureSkipVerify: the default must verify
		// against the system pool, which does not trust httptest's
		// self-signed leaf.
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	c.Run(ctx)

	select {
	case <-fr.joined:
		t.Fatal("join reached the relay; certificate verification did not run")
	default:
	}
	if c.State() != StateBackoff {
		t.Fatalf("state = %v, want StateBackoff", c.State())
	}
	if !strings.Contains(strings.ToLower(c.LastError()), "certificate") &&
		!strings.Contains(strings.ToLower(c.LastError()), "x509") {
		t.Fatalf("last error %q does not look like a certificate failure", c.LastError())
	}
}

func TestClientInsecureSkipVerifyConnectsDespiteUntrustedCert(t *testing.T) {
	fr := newFakeRelay()
	srv := httptest.NewTLSServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	lc := leases.New()
	c := New(Config{
		URL:                   wssURL(t, srv),
		Room:                  "test-room",
		Agent:                 "go-daemon-test",
		TLSInsecureSkipVerify: true,
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.Run(ctx)

	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatalf("relay never received a join frame; last error: %s", c.LastError())
	}
	if !c.Open() {
		t.Fatalf("state = %v, want Open", c.State())
	}
}

func TestClientRejectsUnknownScheme(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "http://127.0.0.1:1", Room: "r", Agent: "a"}, lc)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c.Run(ctx)
	if c.State() != StateBackoff {
		t.Fatalf("state = %v, want StateBackoff", c.State())
	}
	if !strings.Contains(c.LastError(), "ws://") || !strings.Contains(c.LastError(), "wss://") {
		t.Fatalf("last error %q should name both accepted schemes", c.LastError())
	}
}
