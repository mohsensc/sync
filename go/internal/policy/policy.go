// Package policy is the decision-relevant slice of policy, and nothing
// else. It is the Go mirror of cpp/daemon/policy_cache.{hpp,cpp}: five enum
// values read from the blob `ap policy compile` writes, combined with the
// org floor the relay pushes, answered with one lock and one array index.
//
// What is deliberately not here: TOML, layers, precedence, the observer
// ceiling, the unattended promotion. All of that is resolved on the Python
// side — layer authority and rule specificity are baked into the order of
// the `rules`/`floors` arrays before this ever sees them, and this package
// never re-derives it. What this package now does have: glob matching, one
// path at a time, against entries python already sorted. That is a much
// smaller thing than "policy" and was left out only until per-path rules
// had a daemon-side reader at all — see EffectForPath. No file parsing
// happens on the decision path itself — Refresh is called from a tick,
// stats the file and re-parses only when the mtime or size moved, same
// rule as the C++ side.
package policy

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Effect names, in lattice order: silent < notify < context < ask < deny.
// Mirrors hook/protocol.hpp's kEffectNames — the one place they are
// spelled on the Go side too.
type Effect int

const (
	Silent Effect = iota
	Notify
	Context
	Ask
	Deny
)

const Rungs = 5

var effectNames = [Rungs]string{"silent", "notify", "context", "ask", "deny"}

func (e Effect) String() string {
	if e < 0 || int(e) >= len(effectNames) {
		return effectNames[0]
	}
	return effectNames[e]
}

// ParseEffect is protocol.hpp's parse_effect: empty for anything not one of
// the five names.
func ParseEffect(s string) (Effect, bool) {
	for i, n := range effectNames {
		if s == n {
			return Effect(i), true
		}
	}
	return 0, false
}

// Louder is the whole of "apply a floor": the lattice is totally ordered,
// so max() is the entire operation.
func Louder(a, b Effect) Effect {
	if a >= b {
		return a
	}
	return b
}

// Table is one effect per rung, 0..4.
type Table [Rungs]Effect

// Builtin is what installing the engine and configuring nothing produces.
// Byte for byte python/src/agent_presence/policy.py's BUILTIN table — the
// C++ policy_cache.hpp this used to mirror is gone, that file is the
// source of truth now. Rung 4 sits at context: AGENT_PRESENCE_RUNG4 is
// already its off switch.
var Builtin = Table{Silent, Notify, Context, Deny, Context}

// BuiltinFloor is kBuiltinFloor: rung 3's floor is notify, not silent — a
// silent rung 3 is two agents in one symbol with nothing said anywhere,
// which nothing may produce, not a broken cache and not an empty config.
var BuiltinFloor = Table{Silent, Silent, Silent, Notify, Silent}

// Origin is which side of the policy decided a rung, and where that side
// came from — cpp/daemon/policy_cache.hpp's PolicyCache::Origin. One call,
// one lock, one consistent answer: separate EffectFor/Source/FloorSource
// calls could straddle a SetFloor between them.
type Origin struct {
	Effect    Effect
	FromFloor bool
	Source    string
	// Layer is which policy layer's rule won — "org", "repo", "user",
	// "session" or "builtin", the same vocabulary `ap policy explain`
	// prints. Empty whenever no entry in `rules`/`floors` actually fired
	// for this call: an old-format cache with no such array, a path
	// nothing in it covers, or a rung none of its entries fill. The
	// answer still comes from the blanket table/floor in that case —
	// there just isn't a single layer to name for it.
	//
	// This is a known disagreement with the python side, not yet aligned:
	// python's Origin equivalent (policy.py's `winning_layer`) defaults to
	// the literal string "builtin", because its walk always starts from an
	// explicit `builtin_layer()` entry rather than a compiled-in blanket
	// table with no layer of its own. `ap policy explain` and cli.py's
	// `res.floor_layer or 'builtin'` both print "builtin" for the exact
	// case this field leaves "". Nothing in this codebase reads Layer as a
	// display value today — daemon.go's journalRecord tells "the builtin
	// table" apart from a loaded file by checking Origin.Source == "",
	// not Layer — so the two sides read the same today by accident, not
	// by a shared contract. The first caller that prints Layer directly
	// will need to decide whether "" means "builtin" or "no rule fired"
	// before it can match python's wording, since right now it means both.
	Layer string
}

const (
	recheckMs = 100
	maxBytes  = 4 * 1024 * 1024
	never     = -1
)

// ruleEntry is one line of the wire `rules`/`floors` array — policy.py's
// _compiled_rules/_compiled_floors. `Match` is "" for a blanket rule
// (python's `rule.match or ""`, since Rule.match is None internally and
// None doesn't survive JSON); five `Effects` slots, "" where that rule says
// nothing for that rung, same convention `_compiled_effects` writes. Layer
// is one of "builtin"/"org"/"repo"/"user"/"session", carried through only
// for Explain — nothing here compares layers, python already ordered the
// array by authority before it was written.
type ruleEntry struct {
	Match   string   `json:"match"`
	Effects []string `json:"effects"`
	Layer   string   `json:"layer"`
}

// cacheFile is the shape `ap policy compile` writes. encoding/json instead
// of a hand-rolled scanner — see #19 — but the per-rung tolerance
// (`parse_effect_list`'s "one bad word leaves that rung alone") still has
// to be reproduced by hand below: a JSON array that merely decodes is not
// the same guarantee as one that decodes to five known effect names.
type cacheFile struct {
	Table    []string    `json:"table"`
	Degraded bool        `json:"degraded"`
	Problem  string      `json:"problem"`
	Rules    []ruleEntry `json:"rules"`
	Floors   []ruleEntry `json:"floors"`
}

// pathRule is a ruleEntry after its glob compiled and its effect names
// parsed — what EffectForPath actually walks, so a decision never runs
// regexp.Compile or ParseEffect itself.
type pathRule struct {
	blanket bool           // wire match == "": matches every path, python's Rule.match is None
	re      *regexp.Regexp // nil when blanket, or when the glob failed to compile
	layer   string
	effects [Rungs]Effect
	has     [Rungs]bool
}

// matches mirrors the daemon's half of compile_runtime's docstring:
// `matches(entry.match, path)`. A malformed glob compiles to a rule that
// matches nothing rather than one that panics or matches everything — the
// same direction policy_cache.cpp fails in for a bad table entry.
func (r pathRule) matches(path string) bool {
	if r.blanket {
		return true
	}
	if r.re == nil {
		return false
	}
	return r.re.MatchString(path)
}

// compileGlob translates one [[path]] glob into an anchored regexp, byte
// for byte what policy.py's _compile_glob does: ** crosses directory
// separators, * and ? do not (fnmatch would map * to .*, which is not what
// `src/*.py` means to anyone who wrote it). nil means the glob is
// malformed — an unmatched `[`, or a bracket expression the regexp engine
// itself rejects — the same two cases _compile_glob returns None for.
func compileGlob(pattern string) *regexp.Regexp {
	runes := []rune(pattern)
	n := len(runes)
	var b strings.Builder
	for i := 0; i < n; {
		switch runes[i] {
		case '*':
			rest := string(runes[i:])
			switch {
			case strings.HasPrefix(rest, "**/"):
				// A leading `**/` has to match nothing at all too, so
				// `**/x.py` catches a bare `x.py` as well as `a/b/x.py`.
				b.WriteString(`(?:.*/)?`)
				i += 3
			case strings.HasPrefix(rest, "**"):
				b.WriteString(`.*`)
				i += 2
			default:
				b.WriteString(`[^/]*`)
				i++
			}
		case '?':
			b.WriteString(`[^/]`)
			i++
		case '[':
			close := -1
			for j := i + 1; j < n; j++ {
				if runes[j] == ']' {
					close = j
					break
				}
			}
			if close == -1 {
				return nil
			}
			body := string(runes[i+1 : close])
			if strings.HasPrefix(body, "!") {
				body = "^" + body[1:]
			}
			b.WriteString("[" + body + "]")
			i = close + 1
		default:
			b.WriteString(regexp.QuoteMeta(string(runes[i])))
			i++
		}
	}
	re, err := regexp.Compile("^(?:" + b.String() + ")$")
	if err != nil {
		return nil
	}
	return re
}

// compileRules turns one wire array (`rules` or `floors`) into matchers,
// tolerating a bad line the way the blanket table already tolerates a bad
// word: one unparseable glob or unknown effect name drops just that piece
// and is named in the returned problem string, never the whole array.
func compileRules(entries []ruleEntry) ([]pathRule, string) {
	out := make([]pathRule, 0, len(entries))
	var bad []string
	for _, e := range entries {
		pr := pathRule{layer: e.Layer}
		if e.Match == "" {
			pr.blanket = true
		} else if re := compileGlob(e.Match); re != nil {
			pr.re = re
		} else {
			// No matches() call can ever tell what this line meant to
			// cover, so the whole entry is unusable — not just quieter,
			// unknowable — and is dropped rather than kept as a rule that
			// never fires silently.
			bad = append(bad, "glob "+strconv.Quote(e.Match)+" does not compile")
			continue
		}
		for i := 0; i < Rungs && i < len(e.Effects); i++ {
			name := e.Effects[i]
			if name == "" {
				continue
			}
			eff, ok := ParseEffect(name)
			if !ok {
				bad = append(bad, "rule "+strconv.Quote(e.Match)+" rung"+strconv.Itoa(i)+"="+strconv.Quote(name))
				continue
			}
			pr.effects[i] = eff
			pr.has[i] = true
		}
		out = append(out, pr)
	}
	if len(bad) == 0 {
		return out, ""
	}
	return out, "bad rule entries dropped (" + strings.Join(bad, "; ") + ")"
}

// Cache is safe for concurrent use. Refresh is meant to be called from one
// tick; EffectFor/Explain are the hot-path reads, taking a shared lock the
// same way the C++ side's std::shared_mutex does — see docs/go-daemon.md's
// note on why a read-mostly cache like this one stays a mutex rather than
// growing a goroutine of its own: nothing here can deadlock or starve the
// decision path, which is the property #20 actually cares about.
type Cache struct {
	ioMu      sync.Mutex // serializes refreshers so stat+read+parse never overlaps
	checkedMs int64
	mtimeNs   int64
	size      int64
	loaded    bool

	mu          sync.RWMutex
	local       Table
	floor       Table
	rules       []pathRule // [[path]] effect rules, priority-ordered by python already
	floors      []pathRule // [[floor.path]] rules from org/repo; combined by max, not by priority
	source      string
	floorSource string
	problem     string
	parses      uint64
}

func New() *Cache {
	return &Cache{local: Builtin, floor: BuiltinFloor, checkedMs: never, mtimeNs: never, size: never}
}

// Refresh re-reads the compiled cache if it moved. Returns whether the
// table changed. Safe to call every tick: it stats at most once per
// recheckMs and parses only when the mtime or size differs from the last
// read.
func (c *Cache) Refresh(path string, nowMs int64) bool {
	if path == "" {
		return false
	}
	c.ioMu.Lock()
	defer c.ioMu.Unlock()

	if c.checkedMs != never && nowMs-c.checkedMs < recheckMs {
		return false
	}
	c.checkedMs = nowMs

	st, err := os.Stat(path)
	if err != nil {
		if !c.loaded {
			return false // never had one; Builtin is the default, not a fault
		}
		c.loaded = false
		c.mtimeNs = never
		c.size = never
		c.setProblem("policy cache " + path + " disappeared; keeping the last table")
		return false
	}

	mtime := st.ModTime().UnixNano()
	size := st.Size()
	if c.loaded && mtime == c.mtimeNs && size == c.size {
		return false
	}

	if size > maxBytes {
		c.mtimeNs = mtime
		c.size = size
		c.note("policy cache " + path + " is too large; keeping the last table")
		return false
	}

	data, err := os.ReadFile(path)
	if err != nil || int64(len(data)) > maxBytes {
		c.mtimeNs = never // try again next tick rather than latching the failure
		c.size = never
		c.note("policy cache " + path + " could not be read; keeping the last table")
		return false
	}
	c.mtimeNs = mtime
	c.size = size

	var cf cacheFile
	problem := ""
	ok := json.Unmarshal(data, &cf) == nil && len(cf.Table) == Rungs

	c.mu.RLock()
	next := c.local
	c.mu.RUnlock()

	if ok {
		unknown := ""
		for i, name := range cf.Table {
			if e, known := ParseEffect(name); known {
				next[i] = e
			} else {
				if unknown != "" {
					unknown += ", "
				}
				unknown += "rung" + strconv.Itoa(i) + "=" + name
			}
		}
		if unknown != "" {
			problem = "unknown effect names kept at their previous value (" + unknown + ")"
		}
	}

	rules, rulesProblem := compileRules(cf.Rules)
	floors, floorsProblem := compileRules(cf.Floors)
	for _, extra := range []string{rulesProblem, floorsProblem} {
		if extra == "" {
			continue
		}
		if problem != "" {
			problem += "; "
		}
		problem += extra
	}

	// What the compiler thought of the config it read, separate from
	// whether this file parsed — see policy_cache.cpp's comment on why both
	// checks exist.
	if cf.Degraded {
		said := cf.Problem
		if said == "" {
			said = "policy cache " + path + " is marked degraded and says no why"
		}
		if problem != "" {
			said += "; " + problem
		}
		problem = said
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.parses++
	if !ok {
		c.problem = "policy cache " + path + " has no usable table; keeping the last one"
		return false
	}
	moved := next != c.local
	c.local = next
	c.rules = rules
	c.floors = floors
	c.source = path
	c.loaded = true
	c.problem = problem
	return moved
}

func (c *Cache) note(msg string) {
	c.mu.Lock()
	c.problem = msg
	c.mu.Unlock()
}

func (c *Cache) setProblem(msg string) { c.note(msg) }

// SetFloor installs the org floor the relay pushed, clamped up to
// BuiltinFloor so a relay — or anything pretending to be one — cannot
// lower it.
func (c *Cache) SetFloor(floor Table, source string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := 0; i < Rungs; i++ {
		c.floor[i] = Louder(floor[i], BuiltinFloor[i])
	}
	c.floorSource = source
}

// EffectFor is the blanket answer, kept for callers that genuinely never
// have a path to give — decide.go's early-out for a request with no region
// at all (see its own comment on why that one call site stays path-less).
// It is EffectForPath with no path, not a separate code path, but "no path"
// is not "no rules": EffectForPath("") still walks `rules`/`floors` and
// fires any entry whose compiled pattern matches the empty string. That is
// every wire-level blanket entry (`match:""`, python's `Rule.match is
// None`) plus any glob built from a bare `*` or `**` — `[^/]*` and `.*`
// both match "" too, the same as they would match "" as a real path
// component. A prefixed or anchored glob (`src/**`, `**/x.py`) or one that
// requires a character (`?`) never does. So a cache with no [[path]] rules
// loaded (every cache before this feature, and any cache compiled with the
// default path="") answers EffectFor and EffectForPath identically because
// there is nothing in `rules`/`floors` to tell them apart — not because
// empty path is special-cased anywhere below.
func (c *Cache) EffectFor(rung int) Effect {
	return c.EffectForPath(rung, "")
}

// EffectForPath is compile_runtime's docstring, transcribed: walk `rules`
// in the order python already sorted it (highest-authority layer first,
// most specific within a layer first) and take the first entry that both
// matches this path and fills this rung; fall back to the blanket table
// when nothing does. Then raise that by the strictest matching `floors`
// entry, the same as the blanket floor already was — a floor is never
// first-match, every matching line can only push it up.
//
// The path is matched exactly as given, with no normalisation: no
// tail-matching for an absolute path, no opaque-hash handling. Those live
// entirely on the python side (see policy.py's `_readings` block) because
// this reads a path python already resolved for one repo checkout. A
// caller here has to pass a repo-relative path — repo.RegionKey's job —
// or every [[path]] glob simply never matches and this silently falls
// back to the blanket table, which is the exact defect this function
// exists to fix, one layer up.
func (c *Cache) EffectForPath(rung int, path string) Effect {
	if rung < 0 || rung >= Rungs {
		return Silent
	}
	c.mu.RLock()
	defer c.mu.RUnlock()

	effect := c.local[rung]
	for _, r := range c.rules {
		if r.has[rung] && r.matches(path) {
			effect = r.effects[rung]
			break
		}
	}

	floor := c.floor[rung]
	for _, r := range c.floors {
		if r.has[rung] && r.matches(path) {
			floor = Louder(floor, r.effects[rung])
		}
	}

	return Louder(effect, floor)
}

// Explain is ExplainPath with no path — see EffectFor's note on why that
// is the blanket answer and not a different one.
func (c *Cache) Explain(rung int) Origin {
	return c.ExplainPath(rung, "")
}

// ExplainPath is EffectForPath with its reasoning kept instead of thrown
// away: which rule matched, which layer wrote it, and whether the floor is
// what actually decided the rung — the same three things
// `ap policy explain` prints, so a daemon-side "why" and a python-side
// "why" for the same path read the same.
func (c *Cache) ExplainPath(rung int, path string) Origin {
	if rung < 0 || rung >= Rungs {
		return Origin{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()

	local := c.local[rung]
	localLayer := ""
	for _, r := range c.rules {
		if r.has[rung] && r.matches(path) {
			local = r.effects[rung]
			localLayer = r.layer
			break
		}
	}

	floor := c.floor[rung]
	floorLayer := ""
	floorSource := c.floorSource
	for _, r := range c.floors {
		if r.has[rung] && r.matches(path) && r.effects[rung] > floor {
			floor = r.effects[rung]
			floorLayer = r.layer
			// This floor came from the locally compiled cache, not the
			// relay push SetFloor tracks — attribute it to the file that
			// actually said so, the same source `local` already gets.
			floorSource = c.source
		}
	}

	fromFloor := floor > local
	origin := Origin{Effect: Louder(local, floor), FromFloor: fromFloor}
	if fromFloor {
		origin.Source = floorSource
		origin.Layer = floorLayer
	} else {
		origin.Source = c.source
		origin.Layer = localLayer
	}
	return origin
}

func (c *Cache) Degraded() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.problem != ""
}

func (c *Cache) Problem() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.problem
}

func (c *Cache) Source() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.source
}

func (c *Cache) Parses() uint64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.parses
}
