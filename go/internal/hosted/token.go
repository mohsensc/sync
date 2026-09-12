package hosted

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

const (
	tokenTag       = "ags_"
	publicIDBytes  = 16
	secretBytes    = 32
	publicIDLength = 32 // UUID bytes as lowercase hex, without hyphens
)

type tokenMaterial struct {
	prefix string
	raw    string
	hash   [sha256.Size]byte
}

func mintToken() (tokenMaterial, error) {
	publicID := make([]byte, publicIDBytes)
	secret := make([]byte, secretBytes)
	if _, err := rand.Read(publicID); err != nil {
		return tokenMaterial{}, fmt.Errorf("hosted: generate token id: %w", err)
	}
	if _, err := rand.Read(secret); err != nil {
		return tokenMaterial{}, fmt.Errorf("hosted: generate token secret: %w", err)
	}
	// Give the public lookup id UUIDv4 version/variant bits, then render it
	// without hyphens as required by the account-page token contract.
	publicID[6] = (publicID[6] & 0x0f) | 0x40
	publicID[8] = (publicID[8] & 0x3f) | 0x80
	prefix := tokenTag + hex.EncodeToString(publicID)
	secretText := base64.RawURLEncoding.EncodeToString(secret)
	return tokenMaterial{
		prefix: prefix,
		raw:    prefix + "." + secretText,
		hash:   sha256.Sum256(secret),
	}, nil
}

func parseToken(raw string) (prefix string, hash [sha256.Size]byte, err error) {
	if raw != strings.TrimSpace(raw) {
		return "", hash, ErrInvalidToken
	}
	prefix, encodedSecret, ok := strings.Cut(raw, ".")
	if !ok || strings.Contains(encodedSecret, ".") || !strings.HasPrefix(prefix, tokenTag) {
		return "", hash, ErrInvalidToken
	}
	encodedID := strings.TrimPrefix(prefix, tokenTag)
	if len(encodedID) != publicIDLength {
		return "", hash, ErrInvalidToken
	}
	publicID, decodeErr := hex.DecodeString(encodedID)
	if decodeErr != nil || len(publicID) != publicIDBytes || hex.EncodeToString(publicID) != encodedID ||
		publicID[6]>>4 != 4 || publicID[8]>>6 != 2 {
		return "", hash, ErrInvalidToken
	}
	secret, decodeErr := base64.RawURLEncoding.DecodeString(encodedSecret)
	if decodeErr != nil || len(secret) != secretBytes || base64.RawURLEncoding.EncodeToString(secret) != encodedSecret {
		return "", hash, ErrInvalidToken
	}
	return prefix, sha256.Sum256(secret), nil
}

func tokenHashMatches(want []byte, got [sha256.Size]byte) bool {
	// hmac.Equal is constant-time when lengths match. The migration pins every
	// stored digest to sha256.Size bytes, but retain the explicit length check
	// for stores created before that constraint existed.
	return len(want) == sha256.Size && hmac.Equal(want, got[:])
}

func validRoomKey(roomKey string) bool {
	if len(roomKey) != 16 {
		return false
	}
	for _, c := range roomKey {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
