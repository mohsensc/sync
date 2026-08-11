// Package policy is the decision-relevant slice of policy, and nothing
// else. It is the Go mirror of cpp/daemon/policy_cache.{hpp,cpp}: five enum
// values read from the blob `ap policy compile` writes, combined with the
// org floor the relay pushes, answered with one lock and one array index.
//
// What is deliberately not here: TOML, globs, layers, precedence, the
// observer ceiling, the unattended promotion. All of that is resolved on
// the Python side; this reads the one line of JSON it writes to
// $XDG_RUNTIME_DIR. No file parsing happens on the decision path itself —
// Refresh is called from a tick, stats the file and re-parses only when the
// mtime or size moved, same rule as the C++ side.
package policy

import (
	"encoding/json"
	"os"
	"strconv"
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
// Byte for byte cpp/daemon/policy_cache.hpp's kBuiltin. Rung 4 sits at
// context: AGENT_PRESENCE_RUNG4 is already its off switch.
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
}

const (
	recheckMs = 100
	maxBytes  = 4 * 1024 * 1024
	never     = -1
)

// cacheFile is the shape `ap policy compile` writes. encoding/json instead
// of a hand-rolled scanner — see #19 — but the per-rung tolerance
// (`parse_effect_list`'s "one bad word leaves that rung alone") still has
// to be reproduced by hand below: a JSON array that merely decodes is not
// the same guarantee as one that decodes to five known effect names.
type cacheFile struct {
	Table    []string `json:"table"`
	Degraded bool     `json:"degraded"`
	Problem  string   `json:"problem"`
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

// EffectFor is the only call meant for the hot path: one shared lock, one
// array index, one max. A rung outside 0..4 is "no answer", which is
// silent.
func (c *Cache) EffectFor(rung int) Effect {
	if rung < 0 || rung >= Rungs {
		return Silent
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Louder(c.local[rung], c.floor[rung])
}

func (c *Cache) Explain(rung int) Origin {
	if rung < 0 || rung >= Rungs {
		return Origin{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	local := c.local[rung]
	floor := c.floor[rung]
	return Origin{
		Effect:    Louder(local, floor),
		FromFloor: floor > local,
		Source: func() string {
			if floor > local {
				return c.floorSource
			}
			return c.source
		}(),
	}
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
