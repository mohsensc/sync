// Policy: the org floor, ported from python/src/agent_sync/policy.py's
// relay slice — builtin plus one org layer (policy.py's RELAY_INCLUDE),
// which is the whole of what the relay ever resolves. The repo, user and
// session layers are files on the client's own disk that the relay cannot
// see and has no business guessing at; those stay Python-only, resolved
// by the daemon's own `ap policy compile` (go/internal/policy just reads
// the JSON that writes).
//
// Same rule as the Python doc comment at the top of policy.py: policy
// governs presentation and blocking, never lease grants. Acquire/Contend/
// wait-die in leases.go run exactly the same regardless of what a Resolve
// call below returns.
package relaysrv

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// -- effects ------------------------------------------------------------

type Effect string

const (
	EffectSilent  Effect = "silent"
	EffectNotify  Effect = "notify"
	EffectContext Effect = "context"
	EffectAsk     Effect = "ask"
	EffectDeny    Effect = "deny"
)

var effectRank = map[Effect]int{
	EffectSilent: 0, EffectNotify: 1, EffectContext: 2, EffectAsk: 3, EffectDeny: 4,
}

func validEffect(s string) (Effect, bool) {
	e := Effect(s)
	_, ok := effectRank[e]
	return e, ok
}

func stricterEffect(a, b Effect) Effect {
	if effectRank[a] >= effectRank[b] {
		return a
	}
	return b
}

func quieterEffect(a, b Effect) Effect {
	if effectRank[a] <= effectRank[b] {
		return a
	}
	return b
}

// opensNegotiation mirrors policy.py's opens_negotiation: only ask/deny
// interrupt; silent/notify/context leave the relay answering ack.
func opensNegotiation(e Effect) bool { return effectRank[e] >= effectRank[EffectAsk] }

// observerCeiling is the only ceiling mechanism there is: anyone can make
// their own agent stricter (mode = "observer"), never cap anyone else.
const observerCeiling = EffectNotify

// EffectTable is five effects, one per rung 0..4.
type EffectTable [5]Effect

func (t EffectTable) names() []string {
	out := make([]string, 5)
	for i, e := range t {
		out[i] = string(e)
	}
	return out
}

// builtinTable/builtinFloor mirror policy.py's BUILTIN/BUILTIN_FLOOR
// exactly, rung by rung — see there for why rung 3 defaults to deny and
// rung 4 to context.
var builtinTable = EffectTable{EffectSilent, EffectNotify, EffectContext, EffectDeny, EffectContext}
var builtinFloor = EffectTable{EffectSilent, EffectSilent, EffectSilent, EffectNotify, EffectSilent}

func rungIndex(rung int) int {
	if rung < 0 {
		return 0
	}
	if rung > 4 {
		return 4
	}
	return rung
}

// -- glob matching --------------------------------------------------------
//
// Ported byte-for-byte from policy.py's _compile_glob: ** crosses
// directory separators, * and ? do not. Go's path.Match/filepath.Match
// give neither this semantics nor **, so this stays a hand-rolled
// translation to regexp, exactly like the Python side.

var globCacheMu sync.Mutex
var globCache = map[string]*regexp.Regexp{}

func compileGlob(pattern string) *regexp.Regexp {
	globCacheMu.Lock()
	if re, ok := globCache[pattern]; ok {
		globCacheMu.Unlock()
		return re
	}
	globCacheMu.Unlock()

	var out strings.Builder
	i, n := 0, len(pattern)
	ok := true
	for i < n && ok {
		ch := pattern[i]
		switch {
		case ch == '*':
			if strings.HasPrefix(pattern[i:], "**/") {
				out.WriteString("(?:.*/)?")
				i += 3
			} else if strings.HasPrefix(pattern[i:], "**") {
				out.WriteString(".*")
				i += 2
			} else {
				out.WriteString("[^/]*")
				i++
			}
		case ch == '?':
			out.WriteString("[^/]")
			i++
		case ch == '[':
			close := strings.IndexByte(pattern[i+1:], ']')
			if close == -1 {
				ok = false
				break
			}
			body := pattern[i+1 : i+1+close]
			if strings.HasPrefix(body, "!") {
				body = "^" + body[1:]
			}
			out.WriteString("[" + body + "]")
			i = i + 1 + close + 1
		default:
			out.WriteString(regexp.QuoteMeta(string(ch)))
			i++
		}
	}

	var compiled *regexp.Regexp
	if ok {
		if re, err := regexp.Compile("^(?:" + out.String() + ")$"); err == nil {
			compiled = re
		}
	}
	globCacheMu.Lock()
	globCache[pattern] = compiled
	globCacheMu.Unlock()
	return compiled
}

func validGlob(pattern string) bool {
	return pattern != "" && compileGlob(pattern) != nil
}

var wildcardChar = regexp.MustCompile(`[*?\[]`)

// literalChars mirrors policy.py's _literal_chars.
func literalChars(pattern string) int {
	count := 0
	i, n := 0, len(pattern)
	for i < n {
		ch := pattern[i]
		switch {
		case ch == '*':
			if strings.HasPrefix(pattern[i:], "**/") {
				i += 3
			} else if strings.HasPrefix(pattern[i:], "**") {
				i += 2
			} else {
				i++
			}
		case ch == '?':
			i++
		case ch == '[':
			close := strings.IndexByte(pattern[i+1:], ']')
			if close == -1 {
				i++
			} else {
				i = i + 1 + close + 1
			}
		default:
			count++
			i++
		}
	}
	return count
}

func literalPrefix(pattern string) int {
	loc := wildcardChar.FindStringIndex(pattern)
	if loc == nil {
		return len(pattern)
	}
	return loc[0]
}

// -- path normalisation -----------------------------------------------------

var multiSlash = regexp.MustCompile(`/{2,}`)
var opaquePathRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

func normalizePath(path string) string {
	text := strings.TrimSpace(path)
	if text == "" {
		return ""
	}
	text = multiSlash.ReplaceAllString(text, "/")
	for strings.HasPrefix(text, "./") {
		text = text[2:]
	}
	if len(text) > 1 {
		text = strings.TrimRight(text, "/")
	}
	return text
}

func pathIsOpaque(path string) bool { return opaquePathRe.MatchString(path) }

// readings mirrors policy.py's _readings: every spelling of path a
// repo-relative glob may be tried against, most literal first.
func readings(path string) []string {
	if !strings.HasPrefix(path, "/") {
		return []string{path}
	}
	out := []string{path}
	rest := strings.TrimLeft(path, "/")
	for rest != "" {
		out = append(out, rest)
		cut := strings.IndexByte(rest, '/')
		if cut == -1 {
			break
		}
		rest = rest[cut+1:]
	}
	return out
}

// -- rules and layers ---------------------------------------------------

type policyRule struct {
	match   string // "" means the blanket rule for the layer
	isBlank bool   // true iff match == "" is the deliberate blanket, not an empty string glob
	effects map[int]Effect
	isFloor bool
	order   int
}

func (r policyRule) matches(path string) bool {
	if r.isBlank {
		return true
	}
	re := compileGlob(r.match)
	return re != nil && re.MatchString(path)
}

type specificity [4]int

func lessSpec(a, b specificity) bool {
	for i := 0; i < 4; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// specificityOf mirrors policy.py's Rule.specificity exactly — see there
// for why filename-pinning outranks directory-pinning.
func (r policyRule) specificityOf() specificity {
	if r.isBlank {
		return specificity{-1, -1, -1, -1}
	}
	head, base := r.match, r.match
	if idx := strings.LastIndexByte(r.match, '/'); idx >= 0 {
		head, base = r.match[:idx], r.match[idx+1:]
	} else {
		head = ""
	}
	pinned := 0
	if !wildcardChar.MatchString(base) {
		pinned = 1
	}
	return specificity{pinned, literalChars(base), literalPrefix(head), literalChars(r.match)}
}

func (r policyRule) describe() string {
	if r.isBlank {
		return "blanket"
	}
	return r.match
}

type layerName string

const (
	layerBuiltin layerName = "builtin"
	layerOrg     layerName = "org"
)

// layerOrder mirrors policy.py's LAYER_ORDER. The relay only ever
// populates builtin and org (policy.py's RELAY_INCLUDE), but the ordering
// stays general so digest_of/resolve read exactly like the Python source
// they're a port of.
var layerOrder = []layerName{"builtin", "org", "repo", "user", "session"}

func layerRank(name layerName) int {
	for i, n := range layerOrder {
		if n == name {
			return i
		}
	}
	return 0
}

var floorLayers = map[layerName]bool{"org": true, "repo": true}

type policyLayer struct {
	name     layerName
	source   string
	mode     string // "normal" | "observer"
	rules    []policyRule
	problems []string
	parsed   bool
}

func (l policyLayer) candidates(rung int, path string, floors bool) []policyRule {
	rung = rungIndex(rung)
	var out []policyRule
	for _, r := range l.rules {
		if r.isFloor != floors {
			continue
		}
		if _, ok := r.effects[rung]; !ok {
			continue
		}
		if r.matches(path) {
			out = append(out, r)
		}
	}
	return out
}

func (l policyLayer) ruleFor(rung int, path string, floors bool) *policyRule {
	var best *policyRule
	for _, r := range l.candidates(rung, path, floors) {
		r := r
		if best == nil {
			best = &r
			continue
		}
		bs, rs := best.specificityOf(), r.specificityOf()
		if lessSpec(bs, rs) || (bs == rs && best.order < r.order) {
			best = &r
		}
	}
	return best
}

func (l policyLayer) floorFor(rung int, path string) (Effect, *policyRule) {
	var best *policyRule
	var bestEffect Effect
	for _, r := range l.candidates(rung, path, true) {
		r := r
		candidate := r.effects[rungIndex(rung)]
		if best == nil || effectRank[candidate] > effectRank[bestEffect] {
			best = &r
			bestEffect = candidate
		}
	}
	return bestEffect, best
}

func (l policyLayer) tieFor(rung int, path string, floors bool) *policyRule {
	winner := l.ruleFor(rung, path, floors)
	if winner == nil {
		return nil
	}
	ws := winner.specificityOf()
	for _, r := range l.candidates(rung, path, floors) {
		r := r
		if r.match != winner.match && r.specificityOf() == ws {
			return &r
		}
	}
	return nil
}

func builtinLayer() policyLayer {
	effects := map[int]Effect{}
	for i := 0; i < 5; i++ {
		effects[i] = builtinTable[i]
	}
	return policyLayer{
		name: layerBuiltin, source: "<builtin>", mode: "normal", parsed: true,
		rules: []policyRule{{isBlank: true, effects: effects, isFloor: false, order: 0}},
	}
}

// -- resolution -----------------------------------------------------------

// Resolution mirrors policy.py's Resolution: every input to one decision,
// not just the answer.
type Resolution struct {
	Rung               int
	Path               string
	Effect             Effect
	Base               Effect
	WinningLayer       layerName
	WinningRule        string
	Ceiling            *Effect
	Floor              Effect
	FloorLayer         layerName
	UnattendedPromoted bool
	Problems           []string
	Source             string
}

// Policy is a stack of layers and the answers you can get out of it.
type Policy struct {
	Layers   []policyLayer
	Digest   string
	LoadedAt float64
	Degraded bool
	Problems []string
}

func (p Policy) layer(name layerName) *policyLayer {
	for i := range p.Layers {
		if p.Layers[i].name == name {
			return &p.Layers[i]
		}
	}
	return nil
}

func (p Policy) ordered() []policyLayer {
	out := make([]policyLayer, len(p.Layers))
	copy(out, p.Layers)
	sort.SliceStable(out, func(i, j int) bool { return layerRank(out[i].name) < layerRank(out[j].name) })
	return out
}

func (p Policy) floorAt(rung int, path string) (Effect, layerName) {
	floor := builtinFloor[rungIndex(rung)]
	var source layerName
	for _, l := range p.ordered() {
		if !floorLayers[l.name] {
			continue
		}
		candidate, rule := l.floorFor(rung, path)
		if rule == nil {
			continue
		}
		if effectRank[candidate] > effectRank[floor] {
			floor, source = candidate, l.name
		}
	}
	return floor, source
}

func (p Policy) floorAnywhere(rung int) (Effect, layerName) {
	floor := builtinFloor[rungIndex(rung)]
	var source layerName
	for _, l := range p.ordered() {
		if !floorLayers[l.name] {
			continue
		}
		for _, r := range l.rules {
			if !r.isFloor {
				continue
			}
			candidate, ok := r.effects[rungIndex(rung)]
			if !ok {
				continue
			}
			if effectRank[candidate] > effectRank[floor] {
				floor, source = candidate, l.name
			}
		}
	}
	return floor, source
}

func (p Policy) hasPathRules() bool {
	for _, l := range p.Layers {
		for _, r := range l.rules {
			if !r.isBlank {
				return true
			}
		}
	}
	return false
}

func (p Policy) touches(path string) bool {
	for _, l := range p.Layers {
		for _, r := range l.rules {
			if !r.isBlank && r.matches(path) {
				return true
			}
		}
	}
	return false
}

func (p Policy) floorFor(rung int, path string) (Effect, layerName) {
	path = normalizePath(path)
	if pathIsOpaque(path) {
		return p.floorAnywhere(rung)
	}
	bestEffect, bestLayer := p.floorAt(rung, path)
	for _, alt := range readings(path)[1:] {
		e, l := p.floorAt(rung, alt)
		if effectRank[e] > effectRank[bestEffect] {
			bestEffect, bestLayer = e, l
		}
	}
	return bestEffect, bestLayer
}

// Resolve mirrors policy.py's Policy.resolve: what happens at this rung
// on this path, taking the strictest reading when the path has more than
// one honest one (see readings).
func (p Policy) Resolve(rung int, path string, unattended bool) Resolution {
	rung = rungIndex(rung)
	path = normalizePath(path)

	if pathIsOpaque(path) {
		return p.resolveOpaque(rung, path, unattended)
	}

	best := p.resolveAt(rung, path, unattended)
	if !p.hasPathRules() {
		return best
	}
	var blanket *Resolution
	for _, alt := range readings(path)[1:] {
		var candidate Resolution
		if p.touches(alt) {
			candidate = p.resolveAt(rung, alt, unattended)
		} else {
			if blanket == nil {
				b := p.resolveAt(rung, "", unattended)
				blanket = &b
			}
			candidate = *blanket
		}
		if effectRank[candidate.Effect] > effectRank[best.Effect] {
			candidate.Path = path
			best = candidate
		}
	}
	return best
}

func (p Policy) resolveOpaque(rung int, path string, unattended bool) Resolution {
	blanket := p.resolveAt(rung, "", unattended)
	floor, floorLayer := p.floorAnywhere(rung)

	blanketAfterCeiling := blanket.Base
	if blanket.Ceiling != nil {
		blanketAfterCeiling = quieterEffect(blanket.Base, *blanket.Ceiling)
	}
	effect := stricterEffect(blanketAfterCeiling, floor)
	base, layerN, ruleName, source := blanket.Base, blanket.WinningLayer, blanket.WinningRule, blanket.Source

	for _, l := range p.ordered() {
		var ceiling *Effect
		if l.mode == "observer" {
			c := Effect(observerCeiling)
			ceiling = &c
		}
		for _, r := range l.rules {
			if r.isFloor || r.isBlank {
				continue
			}
			candidate, ok := r.effects[rung]
			if !ok {
				continue
			}
			if ceiling != nil {
				candidate = quieterEffect(candidate, *ceiling)
			}
			if effectRank[candidate] > effectRank[effect] {
				effect = candidate
				base, layerN = candidate, l.name
				ruleName, source = r.describe(), l.source
			}
		}
	}

	promoted := false
	if unattended && effect == EffectAsk {
		effect, promoted = EffectDeny, true
	}

	problems := append(append([]string{}, blanket.Problems...),
		fmt.Sprintf("%s is an opaque path (AGENT_SYNC_OPAQUE); no glob can "+
			"match a hash, so every path rule was read as if it might apply "+
			"and the strictest one stands", path))

	return Resolution{
		Rung: rung, Path: path, Effect: effect, Base: base,
		WinningLayer: layerN, WinningRule: ruleName, Ceiling: blanket.Ceiling,
		Floor: floor, FloorLayer: floorLayer, UnattendedPromoted: promoted,
		Problems: problems, Source: source,
	}
}

func (p Policy) resolveAt(rung int, path string, unattended bool) Resolution {
	base := builtinTable[rungIndex(rung)]
	winningLayer := layerBuiltin
	winningRule := "blanket"
	source := "<builtin>"
	mode := "normal"
	problems := append([]string{}, p.Problems...)

	ordered := p.ordered()
	for i := len(ordered) - 1; i >= 0; i-- {
		l := ordered[i]
		rule := l.ruleFor(rung, path, false)
		if rule == nil {
			continue
		}
		base = rule.effects[rungIndex(rung)]
		winningLayer = l.name
		winningRule = rule.describe()
		source = l.source
		mode = l.mode
		if loser := l.tieFor(rung, path, false); loser != nil {
			problems = append(problems, fmt.Sprintf(
				"%s: rung%d rules %q and %q are equally specific for %q; the later one wins",
				l.source, rung, loser.describe(), rule.describe(), path))
		}
		break
	}

	var ceiling *Effect
	effect := base
	if mode == "observer" {
		c := Effect(observerCeiling)
		ceiling = &c
		effect = quieterEffect(base, c)
	}

	floor, floorLayer := p.floorAt(rung, path)
	effect = stricterEffect(effect, floor)

	promoted := false
	if unattended && effect == EffectAsk {
		effect, promoted = EffectDeny, true
	}

	return Resolution{
		Rung: rung, Path: path, Effect: effect, Base: base,
		WinningLayer: winningLayer, WinningRule: winningRule, Ceiling: ceiling,
		Floor: floor, FloorLayer: floorLayer, UnattendedPromoted: promoted,
		Problems: problems, Source: source,
	}
}

func (p Policy) tableFor(path string, unattended bool) EffectTable {
	var t EffectTable
	for r := 0; r < 5; r++ {
		t[r] = p.Resolve(r, path, unattended).Effect
	}
	return t
}

func (p Policy) floorTable(path string) EffectTable {
	var t EffectTable
	for r := 0; r < 5; r++ {
		e, _ := p.floorFor(r, path)
		t[r] = e
	}
	return t
}

// floorRule is one path-scoped floor line, in the shape the wire carries
// them. Mirrors policy.py's Policy.floor_rules.
type floorRule struct {
	Match   string   `json:"match"`
	Effects []string `json:"effects"`
	Layer   string   `json:"layer"`
}

func (p Policy) floorRules() []floorRule {
	var out []floorRule
	for _, l := range p.ordered() {
		if !floorLayers[l.name] {
			continue
		}
		for _, r := range l.rules {
			if !r.isFloor || r.isBlank {
				continue
			}
			effects := make([]string, 5)
			any := false
			for rung := 0; rung < 5; rung++ {
				if e, ok := r.effects[rung]; ok {
					effects[rung] = string(e)
					any = true
				}
			}
			if any {
				out = append(out, floorRule{Match: r.match, Effects: effects, Layer: string(l.name)})
			}
		}
	}
	return out
}

// -- parsing ----------------------------------------------------------------

var rungKeyRe = regexp.MustCompile(`^rung([0-4])$`)

func rungEffects(table map[string]any, source, where string) (map[int]Effect, []string) {
	out := map[int]Effect{}
	var problems []string
	keys := make([]string, 0, len(table))
	for k := range table {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := table[key]
		m := rungKeyRe.FindStringSubmatch(key)
		if m == nil {
			problems = append(problems, fmt.Sprintf("%s: %s: unknown key %q; expected rung0..rung4", source, where, key))
			continue
		}
		s, ok := value.(string)
		if !ok {
			problems = append(problems, fmt.Sprintf("%s: %s: %s = %v is not one of silent, notify, context, ask, deny; falling back to the default", source, where, key, value))
			continue
		}
		effect, valid := validEffect(s)
		if !valid {
			problems = append(problems, fmt.Sprintf("%s: %s: %s = %q is not one of silent, notify, context, ask, deny; falling back to the default", source, where, key, s))
			continue
		}
		rung := int(m[1][0] - '0')
		out[rung] = effect
	}
	return out, problems
}

func pathRules(entries any, source, where string, isFloor bool, start int) ([]policyRule, []string, int) {
	var rules []policyRule
	var problems []string
	order := start

	if entries == nil {
		return rules, problems, order
	}
	list, ok := toTableList(entries)
	if !ok {
		problems = append(problems, fmt.Sprintf("%s: %s must be an array of tables; ignored", source, where))
		return rules, problems, order
	}

	for index, entry := range list {
		label := fmt.Sprintf("%s[%d]", where, index)
		match, ok := entry["match"].(string)
		if !ok || match == "" {
			problems = append(problems, fmt.Sprintf("%s: %s has no usable `match` glob; ignored", source, label))
			continue
		}
		if !validGlob(match) {
			problems = append(problems, fmt.Sprintf("%s: %s: %q is not a valid glob; ignored", source, label, match))
			continue
		}
		rest := map[string]any{}
		for k, v := range entry {
			if k != "match" {
				rest[k] = v
			}
		}
		effects, probs := rungEffects(rest, source, fmt.Sprintf("%s %s", where, match))
		problems = append(problems, probs...)
		if len(effects) > 0 {
			rules = append(rules, policyRule{match: match, effects: effects, isFloor: isFloor, order: order})
			order++
		}
	}
	return rules, problems, order
}

// toTableList normalizes what BurntSushi/toml hands back for an array of
// tables — []map[string]interface{} for a clean array, but a caller
// passing something else (a malformed [[path]] block, e.g. a bare array
// of strings) needs to fail the "must be an array of tables" check
// instead of panicking.
func toTableList(v any) ([]map[string]any, bool) {
	switch vv := v.(type) {
	case []map[string]any:
		return vv, true
	case []any:
		out := make([]map[string]any, 0, len(vv))
		for _, e := range vv {
			m, ok := e.(map[string]any)
			if !ok {
				return nil, false
			}
			out = append(out, m)
		}
		return out, true
	default:
		return nil, false
	}
}

func parseLayer(text string, name layerName, source string) policyLayer {
	var problems []string
	var data map[string]any
	if _, err := toml.Decode(text, &data); err != nil {
		return policyLayer{name: name, source: source, mode: "normal", parsed: false,
			problems: []string{fmt.Sprintf("%s: could not be read as TOML: %s", source, err)}}
	}

	if raw, ok := data["schema"]; ok {
		v, isInt := raw.(int64)
		if !isInt || v != 1 {
			// Parsed as schema 1 anyway. Refusing the file would drop
			// protection, which is the one thing a bad config must
			// never be able to do.
			problems = append(problems, fmt.Sprintf("%s: schema = %v, expected 1; read as schema 1", source, raw))
		}
	}

	mode := "normal"
	if m, ok := data["mode"]; ok {
		s, isStr := m.(string)
		if isStr && (s == "normal" || s == "observer") {
			mode = s
		} else {
			problems = append(problems, fmt.Sprintf("%s: mode = %v is not one of normal, observer; using normal", source, m))
		}
	}

	var rules []policyRule
	order := 0

	if raw, ok := data["effects"]; ok {
		table, isMap := raw.(map[string]any)
		if !isMap {
			problems = append(problems, fmt.Sprintf("%s: [effects] must be a table; ignored", source))
		} else {
			effects, probs := rungEffects(table, source, "[effects]")
			problems = append(problems, probs...)
			if len(effects) > 0 {
				rules = append(rules, policyRule{isBlank: true, effects: effects, isFloor: false, order: order})
				order++
			}
		}
	}

	pr, probs, next := pathRules(data["path"], source, "[[path]]", false, order)
	rules = append(rules, pr...)
	problems = append(problems, probs...)
	order = next

	if raw, ok := data["floor"]; ok {
		if !floorLayers[name] {
			problems = append(problems, fmt.Sprintf("%s: [floor] is only honoured in the org and repo layers; ignored in the %s layer", source, name))
		} else if table, isMap := raw.(map[string]any); !isMap {
			problems = append(problems, fmt.Sprintf("%s: [floor] must be a table; ignored", source))
		} else {
			rest := map[string]any{}
			for k, v := range table {
				if k != "path" {
					rest[k] = v
				}
			}
			blanket, probs := rungEffects(rest, source, "[floor]")
			problems = append(problems, probs...)
			if len(blanket) > 0 {
				rules = append(rules, policyRule{isBlank: true, effects: blanket, isFloor: true, order: order})
				order++
			}
			fp, probs2, next2 := pathRules(table["path"], source, "[[floor.path]]", true, order)
			rules = append(rules, fp...)
			problems = append(problems, probs2...)
			order = next2
		}
	}

	return policyLayer{name: name, source: source, mode: mode, rules: rules, problems: problems, parsed: true}
}

func loadLayer(path string, name layerName) *policyLayer {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		l := policyLayer{name: name, source: path, mode: "normal", parsed: false,
			problems: []string{fmt.Sprintf("%s: cannot be read: %s", path, err)}}
		return &l
	}
	if fi, statErr := os.Stat(path); statErr == nil && fi.IsDir() {
		l := policyLayer{name: name, source: path, mode: "normal", parsed: false,
			problems: []string{fmt.Sprintf("%s: is a directory, not a policy file", path)}}
		return &l
	}
	l := parseLayer(string(data), name, path)
	return &l
}

// -- discovery ----------------------------------------------------------

const orgPolicyEnv = "AGENT_SYNC_ORG_POLICY"
const orgPolicyDefault = "/etc/agent-sync/policy.toml"

func orgPolicyPath() string {
	if v := os.Getenv(orgPolicyEnv); v != "" {
		return v
	}
	return orgPolicyDefault
}

func digestOf(layers []policyLayer) string {
	h := sha256.New()
	for _, l := range layers {
		fmt.Fprintf(h, "%s\x00%s\x00%s\x00", l.name, l.source, l.mode)
		ordered := append([]policyRule{}, l.rules...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].order < ordered[j].order })
		for _, r := range ordered {
			// Python's f-string interpolates match with str(), not
			// repr() — None prints as "None", a real glob prints
			// unquoted. Only rule.effects.items() goes through repr
			// (Python's str(list-of-tuples) reprs its elements).
			matchRepr := "None"
			if !r.isBlank {
				matchRepr = r.match
			}
			keys := make([]int, 0, len(r.effects))
			for k := range r.effects {
				keys = append(keys, k)
			}
			sort.Ints(keys)
			parts := make([]string, len(keys))
			for i, k := range keys {
				parts[i] = fmt.Sprintf("(%d, '%s')", k, r.effects[k])
			}
			isFloorRepr := "False"
			if r.isFloor {
				isFloorRepr = "True"
			}
			fmt.Fprintf(h, "%s\x00%s\x00[%s]\x00", matchRepr, isFloorRepr, strings.Join(parts, ", "))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func buildPolicy(layers []policyLayer, loadedAt float64) Policy {
	var problems []string
	for _, l := range layers {
		problems = append(problems, l.problems...)
	}
	return Policy{
		Layers: layers, Digest: digestOf(layers), LoadedAt: loadedAt,
		Degraded: len(problems) > 0, Problems: problems,
	}
}

// -- live reload ------------------------------------------------------------

const policyRecheckS = 1.0

// PolicyFile is a Policy that notices when its org file changes. Mirrors
// policy.py's PolicyFile, narrowed to the one entry the relay ever reads
// (PolicyFile.for_relay): builtin plus one org layer.
type PolicyFile struct {
	path    string
	clock   Clock
	metrics *metrics.Registry

	mu        sync.Mutex
	policy    *Policy
	checkedAt *float64
	stampSet  bool
	stampMod  int64
	stampSize int64
}

// NewPolicyFileForRelay mirrors policy.py's PolicyFile.for_relay.
func NewPolicyFileForRelay(clock Clock, m *metrics.Registry) *PolicyFile {
	return &PolicyFile{path: orgPolicyPath(), clock: clock, metrics: m}
}

type stamp struct {
	ok   bool
	mod  int64
	size int64
}

func statStamp(path string) stamp {
	fi, err := os.Stat(path)
	if err != nil {
		return stamp{}
	}
	return stamp{ok: true, mod: fi.ModTime().UnixNano(), size: fi.Size()}
}

// Current mirrors policy.py's PolicyFile.current: gated to one stat per
// second, and a file that stops parsing keeps the last good Policy
// (marked degraded) rather than silently dropping to builtin-only.
func (pf *PolicyFile) Current() Policy {
	pf.mu.Lock()
	defer pf.mu.Unlock()

	now := pf.clock.Now()
	if pf.policy != nil && pf.checkedAt != nil && now-*pf.checkedAt < policyRecheckS {
		return *pf.policy
	}
	pf.checkedAt = &now

	st := statStamp(pf.path)
	if pf.policy != nil && pf.stampSet == st.ok && pf.stampMod == st.mod && pf.stampSize == st.size {
		return *pf.policy
	}
	pf.stampSet, pf.stampMod, pf.stampSize = st.ok, st.mod, st.size

	// Everything below is the actual re-read-and-recompile — the gated
	// checks above are the cheap steady-state path, not what this
	// histogram is asking about. Current returns right after this block
	// either way, so a defer set up here times exactly the reload and
	// nothing else.
	reloadStart := time.Now()
	defer func() { pf.metrics.PolicyReload.Observe(time.Since(reloadStart).Seconds()) }()

	layers := []policyLayer{builtinLayer()}
	org := loadLayer(pf.path, layerOrg)
	var broken *policyLayer
	if org != nil {
		if !org.parsed {
			broken = org
		}
		layers = append(layers, *org)
	}

	if broken != nil && pf.policy != nil {
		extra := append([]string{}, broken.problems...)
		for _, p := range extra {
			log.Printf("policy: %s; keeping the last good table", p)
		}
		kept := *pf.policy
		kept.LoadedAt = now
		kept.Degraded = true
		kept.Problems = append(append([]string{}, kept.Problems...), extra...)
		pf.policy = &kept
		return *pf.policy
	}

	policy := buildPolicy(layers, now)
	for _, p := range policy.Problems {
		log.Printf("policy: %s", p)
	}
	pf.policy = &policy
	return *pf.policy
}
