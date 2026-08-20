// Rung 4 intent similarity, ported as-is from
// python/src/agent_presence/similarity.py — a separate track (#15) owns
// improving it, so this is a straight port of the shipped lexical
// scorer: weighted-cosine token overlap with a hand-maintained synonym
// table, off by default (AGENT_PRESENCE_RUNG4 unset). See the Python
// file's module doc for why the backend is a baseline and not the
// answer, and why the weights and synonym table are shaped the way they
// are.
package relaysrv

import (
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const rung4Env = "AGENT_PRESENCE_RUNG4"
const rung4ThresholdEnv = "AGENT_PRESENCE_RUNG4_THRESHOLD"

var rung4Truthy = map[string]bool{"1": true, "true": true, "yes": true, "on": true}

// defaultRung4Threshold is tuned in python/tools/tune_rung4.py.
const defaultRung4Threshold = 0.82

func rung4Enabled() bool {
	return rung4Truthy[strings.ToLower(strings.TrimSpace(os.Getenv(rung4Env)))]
}

func rung4Threshold() float64 {
	raw := strings.TrimSpace(os.Getenv(rung4ThresholdEnv))
	if raw == "" {
		return defaultRung4Threshold
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return defaultRung4Threshold
	}
	if v <= 0.0 || v > 1.0 {
		return defaultRung4Threshold
	}
	return v
}

// -- tokenizer, ported from similarity.py's tokens() ------------------------

var tokenRe = regexp.MustCompile(`[a-z0-9]+`)

var stopwords = map[string]bool{
	"the": true, "a": true, "an": true, "to": true, "in": true, "on": true,
	"for": true, "of": true, "and": true, "or": true, "with": true,
	"from": true, "at": true, "by": true, "into": true, "that": true,
	"this": true, "it": true, "is": true, "are": true, "be": true,
	"was": true, "were": true, "our": true, "my": true, "we": true,
	"i": true, "so": true, "then": true, "when": true, "new": true,
	"old": true, "some": true, "all": true, "out": true, "up": true,
	"as": true, "its": true, "their": true, "there": true,
	"here": true, "do": true, "does": true, "please": true, "also": true,
	"just": true, "now": true, "per": true, "via": true,
	"not": true, "no": true, "but": true, "if": true, "than": true,
	"over": true, "under": true, "about": true, "across": true,
	"while": true, "should": true, "will": true, "can": true, "would": true,
	"more": true, "less": true, "any": true,
	"each": true, "both": true, "how": true, "what": true, "why": true,
	"where": true, "who": true, "one": true, "two": true,
	"properly": true, "correctly": true, "again": true, "still": true,
	"yet": true, "currently": true,
	"use": true, "uses": true, "using": true, "used": true, "get": true,
	"gets": true, "getting": true, "same": true,
	"only": true, "much": true, "many": true, "very": true, "really": true,
}

type wordPair struct{ a, b string }

var bigrams = map[wordPair]string{
	{"rate", "limit"}:    "throttle",
	{"rate", "limiting"}: "throttle",
	{"rate", "limits"}:   "throttle",
	{"sign", "in"}:       "auth",
	{"sign", "on"}:       "auth",
	{"sign", "up"}:       "auth",
	{"log", "in"}:        "auth",
	{"access", "token"}:  "token",
	{"unit", "test"}:     "test",
	{"unit", "tests"}:    "test",
	{"pull", "request"}:  "pr",
}

var synonyms = map[string]string{}

func fold(canonical string, forms ...string) {
	synonyms[canonical] = canonical
	for _, f := range forms {
		synonyms[f] = canonical
	}
}

func init() {
	// actions
	fold("add", "adds", "adding", "added", "implement", "implements",
		"implementing", "implemented", "create", "creates", "creating",
		"build", "building", "write", "writing", "wrote", "introduce",
		"introducing", "make", "making", "set", "setup", "install")
	fold("fix", "fixes", "fixing", "fixed", "repair", "repairing", "patch",
		"patching", "correct", "correcting", "resolve", "resolving")
	fold("update", "updates", "updating", "updated", "modify", "modifying",
		"change", "changes", "changing", "edit", "editing", "tweak",
		"tweaking", "adjust", "adjusting", "bump", "bumping")
	fold("delete", "deletes", "deleting", "remove", "removes", "removing",
		"removed", "drop", "dropping", "strip", "stripping", "purge")
	fold("refactor", "refactors", "refactoring", "refactored", "restructure",
		"rework", "reworking", "rewrite", "rewriting", "clean", "cleanup",
		"tidy", "simplify", "simplifying")
	fold("migrate", "migrates", "migrating", "migration", "migrations")
	fold("move", "moves", "moving", "moved", "relocate", "port", "porting")
	fold("rename", "renames", "renaming", "renamed")
	fold("handle", "handles", "handling", "handled", "support", "supports",
		"supporting", "cover", "covering")
	fold("wire", "wires", "wiring", "wired", "hook", "hooking", "connect",
		"connecting", "integrate", "integrating")
	fold("check", "checks", "checking", "checked", "verify", "verifying",
		"verification", "assert", "asserting")
	fold("debug", "debugging", "investigate", "investigating", "diagnose")
	fold("enable", "enabling", "disable", "disabling", "toggle")
	fold("split", "splitting", "extract", "extracting", "merge", "merging")
	fold("improve", "improving", "harden", "hardening", "optimize",
		"optimizing", "optimise", "speed", "speeding")

	// structural nouns
	fold("endpoint", "endpoints", "route", "routes", "api", "apis", "url",
		"urls", "path", "paths")
	fold("module", "modules", "package", "packages", "lib", "library")
	fold("table", "tables")
	fold("page", "pages", "screen", "screens", "view", "views")
	fold("file", "files")
	fold("function", "functions", "method", "methods", "func", "fn")
	fold("class", "classes")
	fold("test", "tests", "testing", "spec", "specs", "unittest", "coverage")
	fold("flow", "flows", "pipeline", "pipelines")
	fold("config", "configs", "configuration", "settings", "setting", "option", "options")
	fold("handler", "handlers", "controller", "controllers")
	fold("service", "services", "server", "servers", "worker", "workers")
	fold("component", "components", "widget", "widgets")
	fold("form", "forms", "field", "fields", "input", "inputs")
	fold("list", "lists", "item", "items", "row", "rows")
	fold("job", "jobs", "task", "tasks")
	fold("script", "scripts")
	fold("layer", "layers", "wrapper", "wrappers")
	fold("request", "requests", "call", "calls", "response", "responses")
	fold("code", "codebase")
	fold("data", "value", "values")
	fold("error", "errors", "exception", "exceptions", "failure", "failures")

	// domain nouns
	fold("token", "tokens", "jwt", "jwts", "bearer", "credential", "credentials")
	fold("auth", "authentication", "authorization", "authorisation", "authn",
		"authz", "login", "logins", "signin", "signup", "session", "sessions",
		"logout", "signout")
	fold("refresh", "refreshes", "refreshing", "renew", "renewal", "renewing",
		"reissue", "rotate", "rotation", "rotating")
	fold("retry", "retries", "retrying", "reattempt")
	fold("backoff", "jitter")
	fold("upload", "uploads", "uploader", "uploading", "uploaded")
	fold("download", "downloads", "downloader", "downloading")
	fold("cache", "caches", "caching", "cached", "memoize", "memoization")
	fold("paginate", "pagination", "paging", "paginated", "cursor")
	fold("throttle", "throttling", "ratelimit", "ratelimiting", "quota")
	fold("log", "logs", "logging", "logger", "telemetry", "trace", "tracing")
	fold("metric", "metrics", "instrument", "instrumentation")
	fold("validate", "validates", "validation", "validator", "validating",
		"sanitize", "sanitizing")
	fold("db", "database", "databases", "postgres", "sql")
	fold("query", "queries", "querying", "lookup", "lookups", "fetch",
		"fetching", "read", "reads")
	fold("index", "indexes", "indices", "indexing")
	fold("css", "style", "styles", "styling", "stylesheet", "scss", "tailwind")
	fold("layout", "layouts", "grid", "flexbox", "spacing", "alignment")
	fold("docs", "doc", "documentation", "readme", "changelog")
	fold("deploy", "deploys", "deployment", "deployments", "deploying",
		"release", "releases", "ship", "shipping")
	fold("webhook", "webhooks", "callback", "callbacks")
	fold("payment", "payments", "checkout", "charge", "charges")
	fold("billing", "invoice", "invoices", "subscription", "subscriptions")
	fold("user", "users", "account", "accounts", "profile", "profiles")
	fold("order", "orders", "purchase", "purchases")
	fold("notification", "notifications", "notify", "alert", "alerts",
		"email", "emails")
	fold("schema", "schemas", "model", "models")
	fold("timezone", "timezones", "tz", "datetime", "timestamp", "timestamps")
	fold("search", "searching", "lookup", "filter", "filters", "filtering")
	fold("permission", "permissions", "role", "roles", "acl", "scope", "scopes")
	fold("websocket", "websockets", "ws", "socket", "sockets")
	fold("queue", "queues", "queueing", "buffer", "buffering")
}

// suffixes: (suffix, replacement, minimum stem length). Ordered as
// similarity.py's _SUFFIXES; first match wins.
var suffixes = []struct {
	suffix, replacement string
	floor               int
}{
	{"ies", "y", 4},
	{"ing", "", 4},
	{"ed", "", 4},
	{"er", "", 5},
	{"es", "", 4},
	{"s", "", 4},
}

func stem(token string) string {
	if canon, ok := synonyms[token]; ok {
		return canon
	}
	for _, suf := range suffixes {
		if strings.HasSuffix(token, suf.suffix) && len(token)-len(suf.suffix) >= suf.floor {
			s := token[:len(token)-len(suf.suffix)] + suf.replacement
			if canon, ok := synonyms[s]; ok {
				return canon
			}
			return s
		}
	}
	return token
}

const (
	verbWeight    = 0.3
	genericWeight = 0.5
	domainWeight  = 1.0
)

var verbTokens = map[string]bool{
	"add": true, "fix": true, "update": true, "delete": true, "refactor": true,
	"migrate": true, "move": true, "rename": true, "handle": true, "wire": true,
	"check": true, "debug": true, "enable": true, "split": true, "improve": true,
}

var genericTokens = map[string]bool{
	"endpoint": true, "module": true, "table": true, "page": true, "file": true,
	"function": true, "class": true, "test": true, "flow": true, "config": true,
	"handler": true, "service": true, "component": true, "form": true,
	"list": true, "job": true, "script": true, "layer": true, "request": true,
	"code": true, "data": true, "error": true,
}

func tokenWeight(token string) float64 {
	if verbTokens[token] {
		return verbWeight
	}
	if genericTokens[token] {
		return genericWeight
	}
	return domainWeight
}

// tokenize mirrors similarity.py's tokens(): normalise, drop stopwords,
// fold bigrams, then fold and stem. Returns a slice (not a set) — the
// cosine below uses counts, and repetition is mild evidence of emphasis.
func tokenize(text string) []string {
	// strings.ToLower is a simple case fold: U+0130 (Turkish dotted capital
	// İ) goes to a bare "i". Python's str.lower() is a full case mapping and
	// yields "i" + U+0307 (combining dot above) instead, which the
	// [a-z0-9]+ token regex then splits the word around. Pre-mapping İ to
	// that same two-rune form before ToLower reproduces the split here, so
	// "İstanbul" folds to ["stanbul", ...] on both sides instead of "istanbul"
	// surviving whole on Go's. This is the only full-case-mapping divergence
	// that matters: the regex is ASCII-only, so it already discards anything
	// else full case mapping could change (final sigma, ligatures) before it
	// could affect a score.
	text = strings.ReplaceAll(text, "İ", "i̇")
	raw := tokenRe.FindAllString(strings.ToLower(text), -1)

	folded := make([]string, 0, len(raw))
	i := 0
	for i < len(raw) {
		if i+1 < len(raw) {
			if pair, ok := bigrams[wordPair{raw[i], raw[i+1]}]; ok {
				folded = append(folded, pair)
				i += 2
				continue
			}
		}
		folded = append(folded, raw[i])
		i++
	}

	out := make([]string, 0, len(folded))
	for _, token := range folded {
		if stopwords[token] || len(token) < 2 {
			continue
		}
		stemmed := stem(token)
		if stemmed != "" && !stopwords[stemmed] {
			out = append(out, stemmed)
		}
	}
	return out
}

const (
	minTokens        = 2
	minSharedNonVerb = 2
	minSharedDomain  = 1
)

// lexicalScore mirrors similarity.py's LexicalSimilarity.score: weighted-
// cosine token overlap, gated by floors that keep a two-token match from
// scoring 1.0 on a single shared idea.
func lexicalScore(a, b string) float64 {
	ta, tb := tokenize(a), tokenize(b)
	if len(ta) < minTokens || len(tb) < minTokens {
		return 0.0
	}

	setA := map[string]bool{}
	for _, t := range ta {
		setA[t] = true
	}
	setB := map[string]bool{}
	for _, t := range tb {
		setB[t] = true
	}
	var shared []string
	for t := range setA {
		if setB[t] {
			shared = append(shared, t)
		}
	}

	var nonVerb []string
	for _, t := range shared {
		if !verbTokens[t] {
			nonVerb = append(nonVerb, t)
		}
	}
	if len(nonVerb) < minSharedNonVerb {
		return 0.0
	}
	domainHits := 0
	for _, t := range nonVerb {
		if tokenWeight(t) >= domainWeight {
			domainHits++
		}
	}
	if domainHits < minSharedDomain {
		return 0.0
	}

	countA := counter(ta)
	countB := counter(tb)
	sharedSet := map[string]bool{}
	for _, t := range shared {
		sharedSet[t] = true
	}
	var dot float64
	for t := range sharedSet {
		w := tokenWeight(t)
		dot += float64(countA[t]) * float64(countB[t]) * w * w
	}
	var na, nb float64
	for t, n := range countA {
		w := tokenWeight(t)
		na += (float64(n) * w) * (float64(n) * w)
	}
	for t, n := range countB {
		w := tokenWeight(t)
		nb += (float64(n) * w) * (float64(n) * w)
	}
	na, nb = math.Sqrt(na), math.Sqrt(nb)
	if na == 0.0 || nb == 0.0 {
		return 0.0
	}
	score := dot / (na * nb)
	if score > 1.0 {
		score = 1.0
	}
	return score
}

func counter(tokens []string) map[string]int {
	out := map[string]int{}
	for _, t := range tokens {
		out[t]++
	}
	return out
}
