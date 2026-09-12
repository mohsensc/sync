package hosted

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestMintedTokenRoundTrips(t *testing.T) {
	tok, err := mintToken()
	if err != nil {
		t.Fatal(err)
	}
	prefix, hash, err := parseToken(tok.raw)
	if err != nil {
		t.Fatal(err)
	}
	if prefix != tok.prefix {
		t.Fatalf("prefix = %q, want %q", prefix, tok.prefix)
	}
	if !bytes.Equal(hash[:], tok.hash[:]) {
		t.Fatal("parsed secret hash differs from minted hash")
	}
	if !strings.HasPrefix(tok.raw, "ags_") || strings.Count(tok.raw, ".") != 1 {
		t.Fatalf("unexpected token format %q", tok.raw)
	}
}

func TestMintedTokensAreDistinct(t *testing.T) {
	a, err := mintToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := mintToken()
	if err != nil {
		t.Fatal(err)
	}
	if a.raw == b.raw || a.prefix == b.prefix || a.hash == b.hash {
		t.Fatal("two token generations returned duplicate material")
	}
}

func TestParseTokenRejectsMalformedInputs(t *testing.T) {
	valid, err := mintToken()
	if err != nil {
		t.Fatal(err)
	}
	cases := []string{
		"", "ags_no-dot", "bad_abcdefghijklmnop.secret",
		"ags_short.secret", valid.raw + ".extra", " " + valid.raw,
		valid.prefix + ".short", strings.Replace(valid.raw, "ags_", "ags_*", 1),
	}
	for _, raw := range cases {
		if _, _, err := parseToken(raw); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("parseToken(%q) error = %v, want ErrInvalidToken", raw, err)
		}
	}
}

func TestTokenHashMatches(t *testing.T) {
	tok, err := mintToken()
	if err != nil {
		t.Fatal(err)
	}
	if !tokenHashMatches(tok.hash[:], tok.hash) {
		t.Fatal("matching token hash was rejected")
	}
	wrong := tok.hash
	wrong[0] ^= 0xff
	if tokenHashMatches(tok.hash[:], wrong) {
		t.Fatal("different token hash was accepted")
	}
	if tokenHashMatches(tok.hash[:len(tok.hash)-1], tok.hash) {
		t.Fatal("wrong-length stored hash was accepted")
	}
}

func TestValidRoomKey(t *testing.T) {
	for _, good := range []string{"0123456789abcdef", "aaaaaaaaaaaaaaaa"} {
		if !validRoomKey(good) {
			t.Errorf("validRoomKey(%q) = false", good)
		}
	}
	for _, bad := range []string{"", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEG", "0123456789abcdeg"} {
		if validRoomKey(bad) {
			t.Errorf("validRoomKey(%q) = true", bad)
		}
	}
}
