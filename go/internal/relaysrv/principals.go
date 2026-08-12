package relaysrv

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	rosterVersion = 1
	rosterEnv     = "AGENT_PRESENCE_PRINCIPALS"
	rosterRelPath = ".agent-presence/principals.toml"
	repoRootEnv   = "AGENT_PRESENCE_REPO_ROOT"
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// resolvePath mirrors python's Path(start).expanduser().resolve(): an
// absolute path with every symlink in it followed, not just made textually
// absolute. filepath.Abs alone (what this used to call) does neither —
// see issue #48. Confirmed to matter on stock macOS, where /tmp is itself
// a symlink to /private/tmp: filepath.Abs("/tmp/foo") stays "/tmp/foo",
// Path("/tmp/foo").resolve() returns "/private/tmp/foo", and a checkout
// reached through either spelling could load a different
// principals.toml depending purely on which relay implementation
// resolved the path.
//
// filepath.EvalSymlinks alone isn't a drop-in replacement: it requires
// every component to exist on disk, where resolve() (without strict=True)
// resolves as far as the filesystem allows and appends whatever is left
// literally. Falling back component-by-component keeps that behaviour for
// a path whose tail doesn't exist yet, which matters here because `start`
// can be a working directory a caller only intends to create.
func resolvePath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(abs)
	if parent == abs {
		// Reached the filesystem root and it doesn't exist either — as
		// unresolvable as Path.resolve() gets without raising.
		return abs, nil
	}
	parentResolved, perr := resolvePath(parent)
	if perr != nil {
		return "", perr
	}
	return filepath.Join(parentResolved, filepath.Base(abs)), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// GrantReason mirrors principals.py's GrantReason.
type GrantReason string

const (
	ReasonRoster   GrantReason = "roster"
	ReasonNoRoster GrantReason = "no-roster"
	ReasonNoToken  GrantReason = "no-token"
	ReasonBadToken GrantReason = "bad-token"
	ReasonUnknown  GrantReason = "unknown"
)

// Grant is what a connection is entitled to, decided once at join. Mirrors
// principals.py's Grant.
type Grant struct {
	Principal  string // "" means unauthenticated
	Attended   int
	Unattended int
	Reason     GrantReason
}

func (g Grant) Authenticated() bool { return g.Principal != "" }

// Priority is the tier this connection gets, always inside the band.
func (g Grant) Priority(unattended bool) int {
	low, high := g.Attended, g.Unattended
	if low > high {
		low, high = high, low
	}
	wanted := g.Attended
	if unattended {
		wanted = g.Unattended
	}
	if wanted < low {
		return low
	}
	if wanted > high {
		return high
	}
	return wanted
}

func (g Grant) TierName(unattended bool) string {
	return PriorityName(g.Priority(unattended))
}

func defaultGrant(tier int, reason GrantReason) Grant {
	return Grant{Attended: tier, Unattended: tier, Reason: reason}
}

// Principal is one entry from the roster.
type Principal struct {
	ID          string
	Display     string
	Attended    int
	Unattended  int
	TokenSHA256 string
}

// tomlRoster is the raw shape BurntSushi/toml decodes principals.toml into.
type tomlRoster struct {
	Version     any             `toml:"version"`
	DefaultTier any             `toml:"default_tier"`
	Principal   []tomlPrincipal `toml:"principal"`
}

type tomlPrincipal struct {
	ID          any `toml:"id"`
	Display     any `toml:"display"`
	Attended    any `toml:"attended"`
	Unattended  any `toml:"unattended"`
	TokenSHA256 any `toml:"token_sha256"`
}

// Roster is the principals file, parsed. Never raises; a broken roster is
// inert. Mirrors principals.py's Roster.
type Roster struct {
	byID        map[string]Principal
	defaultTier int
	source      string
	present     bool
	problems    []string
}

func InertRoster() Roster {
	return Roster{byID: map[string]Principal{}, defaultTier: PriorityNormal, source: "<none>"}
}

func (r Roster) Source() string      { return r.source }
func (r Roster) Present() bool       { return r.present }
func (r Roster) DefaultTier() int    { return r.defaultTier }
func (r Roster) Problems() []string  { return r.problems }
func (r Roster) Degraded() bool      { return len(r.problems) > 0 }
func (r Roster) PrincipalCount() int { return len(r.byID) }

// ParseRoster mirrors principals.py's Roster.parse.
func ParseRoster(text string, source string) Roster {
	var raw tomlRoster
	if _, err := toml.Decode(text, &raw); err != nil {
		log.Printf("principals roster %s is unparseable: %s; everyone is normal", source, err)
		return Roster{byID: map[string]Principal{}, defaultTier: PriorityNormal, source: source, present: true,
			problems: []string{fmt.Sprintf("%s: could not be read as TOML: %s", source, err)}}
	}

	var problems []string

	version := rosterVersion
	if raw.Version != nil {
		if v, ok := toInt(raw.Version); ok {
			version = v
		}
	}
	if version != rosterVersion {
		problems = append(problems, fmt.Sprintf("%s: version = %v, expected %d; read as version %d", source, raw.Version, rosterVersion, rosterVersion))
	}

	defaultTier := PriorityNormal
	if raw.DefaultTier != nil {
		if t, err := parsePriorityAny(raw.DefaultTier); err == nil {
			defaultTier = t
		} else {
			problems = append(problems, fmt.Sprintf("%s: default_tier: %s; using normal", source, err))
		}
	}

	principals := map[string]Principal{}
	var order []string
	for i, entry := range raw.Principal {
		p, probs := parsePrincipal(entry, i, source, defaultTier)
		problems = append(problems, probs...)
		if p == nil {
			continue
		}
		if _, dup := principals[p.ID]; dup {
			problems = append(problems, fmt.Sprintf("%s: [[principal]][%d]: duplicate id %q; the first one stands", source, i, p.ID))
			continue
		}
		principals[p.ID] = *p
		order = append(order, p.ID)
	}
	_ = order

	for _, p := range problems {
		log.Printf("principals: %s", p)
	}

	return Roster{byID: principals, defaultTier: defaultTier, source: source, present: true, problems: problems}
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func parsePriorityAny(v any) (int, error) {
	switch val := v.(type) {
	case string:
		return ParsePriority(val)
	case int64:
		return ParsePriority(fmt.Sprintf("%d", val))
	case int:
		return ParsePriority(fmt.Sprintf("%d", val))
	case bool:
		return 0, fmt.Errorf("%v is a boolean, not a priority tier", val)
	default:
		return 0, fmt.Errorf("cannot read a priority tier from %v", val)
	}
}

func parsePrincipal(entry tomlPrincipal, index int, source string, defaultTier int) (*Principal, []string) {
	where := fmt.Sprintf("%s: [[principal]][%d]", source, index)
	var problems []string

	id, ok := entry.ID.(string)
	id = strings.TrimSpace(id)
	if !ok || id == "" {
		return nil, []string{fmt.Sprintf("%s: has no usable `id`; ignored", where)}
	}

	display := id
	if d, ok := entry.Display.(string); ok && strings.TrimSpace(d) != "" {
		display = strings.TrimSpace(d)
	}

	tokenRaw, ok := entry.TokenSHA256.(string)
	tokenRaw = strings.ToLower(strings.TrimSpace(tokenRaw))
	if !ok || !hex64.MatchString(tokenRaw) {
		return nil, []string{fmt.Sprintf("%s: %q has no usable `token_sha256` (64 hex chars); ignored", where, id)}
	}

	attended, aProblem := tierOrDefault(entry.Attended, entry.Unattended, defaultTier, where, id, "attended")
	unattended, uProblem := tierOrDefault(entry.Unattended, entry.Attended, defaultTier, where, id, "unattended")
	if aProblem != "" {
		problems = append(problems, aProblem)
	}
	if uProblem != "" {
		problems = append(problems, uProblem)
	}

	if attended > unattended {
		problems = append(problems, fmt.Sprintf(
			"%s: %q has attended %s above unattended %s; dropped to %s",
			where, id, PriorityName(attended), PriorityName(unattended), PriorityName(defaultTier)))
		attended, unattended = defaultTier, defaultTier
	}

	return &Principal{ID: id, Display: display, Attended: attended, Unattended: unattended, TokenSHA256: tokenRaw}, problems
}

// tierOrDefault mirrors the paired-field logic in principals.py's
// _parse_principal: naming one end sets both, so a raw value missing on
// `key` falls back to the *other* key's value (parsed, or defaultTier if
// that is missing too), not straight to defaultTier.
func tierOrDefault(raw, otherRaw any, defaultTier int, where, id, key string) (int, string) {
	if raw == nil {
		if otherRaw == nil {
			return defaultTier, ""
		}
		if v, err := parsePriorityAny(otherRaw); err == nil {
			return v, ""
		}
		return defaultTier, ""
	}
	v, err := parsePriorityAny(raw)
	if err != nil {
		return defaultTier, fmt.Sprintf("%s: %q %s: %s; using default_tier", where, id, key, err)
	}
	return v, ""
}

// Authenticate turns a join frame's claim into a Grant. Never refuses — a
// bad token is never a join refusal; losing a rung is the right
// punishment. Mirrors principals.py's Roster.authenticate.
func (r Roster) Authenticate(principal, token string) Grant {
	if !r.present {
		return defaultGrant(PriorityNormal, ReasonNoRoster)
	}
	name := strings.TrimSpace(principal)
	secret := strings.TrimSpace(token)
	if name == "" {
		return defaultGrant(r.defaultTier, ReasonNoToken)
	}
	entry, ok := r.byID[name]
	if !ok {
		log.Printf("unknown principal %q; granting %s", name, PriorityName(r.defaultTier))
		return defaultGrant(r.defaultTier, ReasonUnknown)
	}
	if secret == "" {
		log.Printf("principal %q presented no token; granting %s", name, PriorityName(r.defaultTier))
		return defaultGrant(r.defaultTier, ReasonNoToken)
	}
	if !hmac.Equal([]byte(hashToken(secret)), []byte(entry.TokenSHA256)) {
		log.Printf("principal %q presented a token that does not match the roster; granting %s", name, PriorityName(r.defaultTier))
		return defaultGrant(r.defaultTier, ReasonBadToken)
	}
	return Grant{Principal: entry.ID, Attended: entry.Attended, Unattended: entry.Unattended, Reason: ReasonRoster}
}

// FindRoster is the nearest .agent-presence/principals.toml at or above
// start, stopping at the checkout root (a directory holding .git).
// Mirrors principals.py's find_roster.
func FindRoster(start string) string {
	here, err := resolvePath(start)
	if err != nil {
		return ""
	}
	dir := here
	for {
		candidate := filepath.Join(dir, rosterRelPath)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// DiscoverRoster is the roster for a checkout: $AGENT_PRESENCE_PRINCIPALS,
// else $AGENT_PRESENCE_REPO_ROOT, else the nearest one at or above the
// working directory. Mirrors principals.py's Roster.discover.
func DiscoverRoster() Roster {
	if override := os.Getenv(rosterEnv); override != "" {
		return LoadRoster(override)
	}
	start := os.Getenv(repoRootEnv)
	if start == "" {
		start, _ = os.Getwd()
	}
	found := FindRoster(start)
	if found == "" {
		log.Printf("no principals roster at or above %s; everyone is normal", start)
		return InertRoster()
	}
	return LoadRoster(found)
}

func LoadRoster(path string) Roster {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("no principals roster at %s; everyone is normal", path)
			return InertRoster()
		}
		log.Printf("principals roster %s cannot be read: %s; everyone is normal", path, err)
		return Roster{byID: map[string]Principal{}, defaultTier: PriorityNormal, source: path, present: true,
			problems: []string{fmt.Sprintf("%s: cannot be read: %s", path, err)}}
	}
	return ParseRoster(string(data), path)
}
