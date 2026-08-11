package relaysrv

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// selfSignedCert writes a one-off EC cert/key pair to t.TempDir(), the same
// shape docs/tls-dev-cert.md's openssl recipe produces (test_serve_tls.py
// shells out to openssl for the same cert; this stays in the stdlib so
// `go test` needs nothing extra on PATH).
func selfSignedCert(t *testing.T) (certPath, keyPath string, certPEM []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "gorelay-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	dir := t.TempDir()
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath, certPEM
}

func startTLSServer(t *testing.T, certPath, keyPath string) string {
	t.Helper()
	relay := NewRelay(NewVirtualClock(0), InertRoster())
	srv := &Server{Addr: "127.0.0.1:0", Relay: relay, TLSCert: certPath, TLSKey: keyPath}
	addr, err := srv.Listen()
	if err != nil {
		t.Fatalf("Listen: %s", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go srv.Serve(ctx)
	t.Cleanup(cancel)
	return addr
}

// TestWssHandshakeSucceedsWhenTheClientTrustsTheCert mirrors
// test_serve_tls.py's test of the same name: a client told to trust this
// specific self-signed cert completes the handshake and speaks the
// ordinary frame protocol over it unchanged.
func TestWssHandshakeSucceedsWhenTheClientTrustsTheCert(t *testing.T) {
	certPath, keyPath, certPEM := selfSignedCert(t)
	addr := startTLSServer(t, certPath, keyPath)

	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	dialer := websocket.Dialer{TLSClientConfig: &tls.Config{RootCAs: pool}, HandshakeTimeout: 5 * time.Second}
	ws, _, err := dialer.Dial("wss://"+addr+"/", nil)
	if err != nil {
		t.Fatalf("dial: %s", err)
	}
	defer ws.Close()

	if err := ws.WriteJSON(map[string]any{"type": "join", "room": "r", "agent": "a", "human": "h"}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := ws.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if reply["type"] != "leases" {
		t.Fatalf("expected a leases snapshot over wss://, got %+v", reply)
	}
}

// TestWssHandshakeFailsWithoutTheCertTrusted is the whole point: a default
// client — nothing told to trust this specific self-signed cert — must not
// complete the handshake.
func TestWssHandshakeFailsWithoutTheCertTrusted(t *testing.T) {
	certPath, keyPath, _ := selfSignedCert(t)
	addr := startTLSServer(t, certPath, keyPath)

	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	_, _, err := dialer.Dial("wss://"+addr+"/", nil)
	if err == nil {
		t.Fatalf("expected the handshake to fail against an untrusted cert")
	}
}

// TestPlaintextRequestToATLSPortGetsNoUpgrade confirms a plain HTTP
// request to a TLS-terminated port never reaches the websocket handler —
// the "plaintext to the port gets nothing" half of issue #40/#22's TLS
// requirement.
func TestPlaintextRequestToATLSPortGetsNoUpgrade(t *testing.T) {
	certPath, keyPath, _ := selfSignedCert(t)
	addr := startTLSServer(t, certPath, keyPath)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/")
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("expected plaintext HTTP to a TLS port to fail or be rejected, got status %d", resp.StatusCode)
		}
	}
	// An error (connection reset, TLS-required response, etc.) is the
	// expected outcome either way — there is no code path here that hands
	// a plaintext caller a working websocket.
}

// TestPlainWsIsStillTheZeroConfigDefault: no TLSCert/TLSKey at all — the
// call every existing caller of Listen already makes — must still be
// plain ws://, not silently upgraded or broken by TLS support existing.
func TestPlainWsIsStillTheZeroConfigDefault(t *testing.T) {
	relay := NewRelay(NewVirtualClock(0), InertRoster())
	srv := &Server{Addr: "127.0.0.1:0", Relay: relay}
	addr, err := srv.Listen()
	if err != nil {
		t.Fatalf("Listen: %s", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.Serve(ctx)

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+addr+"/", nil)
	if err != nil {
		t.Fatalf("dial: %s", err)
	}
	defer ws.Close()
	if err := ws.WriteJSON(map[string]any{"type": "join", "room": "r", "agent": "a", "human": "h"}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := ws.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if reply["type"] != "leases" {
		t.Fatalf("expected a leases snapshot over ws://, got %+v", reply)
	}
}
