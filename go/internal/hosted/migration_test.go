package hosted

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEmbeddedMigrationMatchesCanonicalFile(t *testing.T) {
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller did not return this test's path")
	}
	path := filepath.Join(filepath.Dir(here), "..", "..", "..", "db", "migrations", "000001_hosted_accounts.up.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	normalize := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	if normalize(string(raw)) != normalize(initialMigrationSQL) {
		t.Fatal("embedded migration differs from db/migrations/000001_hosted_accounts.up.sql")
	}
}
