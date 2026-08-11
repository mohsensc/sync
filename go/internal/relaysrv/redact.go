package relaysrv

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"strings"
)

// OpaqueEnv is the toggle for org-level opaque mode, read per call so
// flipping it needs no restart — same rule redact.py's opaque_enabled uses.
const OpaqueEnv = "AGENT_PRESENCE_OPAQUE"

const OpaqueMark = "opaque"

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func OpaqueEnabled() bool {
	return truthy(os.Getenv(OpaqueEnv))
}

func hashHex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// OpaqueRegion hashes path and symbol client-side; collision detection is
// equality on region keys, so it still works on hashed input. Mirrors
// redact.opaque_region.
func OpaqueRegion(r Region) Region {
	out := Region{Path: hashHex(r.Path)}
	if r.Symbol != nil {
		h := hashHex(*r.Symbol)
		out.Symbol = &h
	}
	return out
}

func OpaqueRegionIfEnabled(r Region) Region {
	if OpaqueEnabled() {
		return OpaqueRegion(r)
	}
	return r
}

// -- inbound cleaning -----------------------------------------------------

func isLineNo(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	case int:
		return n, true
	}
	return 0, false
}

func cleanLines(v any) []int {
	arr, ok := v.([]any)
	if !ok || len(arr) != 2 {
		return nil
	}
	a, ok1 := isLineNo(arr[0])
	b, ok2 := isLineNo(arr[1])
	if !ok1 || !ok2 {
		return nil
	}
	return []int{a, b}
}

// CleanRegionDict is a region off the wire, stripped to path/symbol/lines
// and hashed when opaque mode is on. Returns (Region{}, false) when there
// is no usable path. Mirrors redact.clean_region_dict — every non-event
// frame that carries a region (claim, contend, release, heartbeat, move)
// goes through this, not just the event path, so a claim reaches exactly
// as far as a touch does.
func CleanRegionDict(v any) (Region, bool) {
	out, ok := cleanRegionRaw(v)
	if !ok {
		return Region{}, false
	}
	if OpaqueEnabled() {
		out = OpaqueRegion(out)
	}
	return out, true
}

// cleanRegionRaw is CleanRegionDict without the opaque check — mirrors
// redact.py's _clean_region, the un-hashing half clean_region_dict wraps.
// RedactEvent uses this one and defers hashing to its own single trailing
// pass, the same split python keeps: the event path reads
// opaque_enabled() exactly once per frame, not once per field plus once
// more for the whole frame.
func cleanRegionRaw(v any) (Region, bool) {
	d, ok := v.(map[string]any)
	if !ok {
		return Region{}, false
	}
	path, ok := d["path"].(string)
	if !ok {
		return Region{}, false
	}
	out := Region{Path: path}
	if sym, ok := d["symbol"].(string); ok {
		out.Symbol = &sym
	}
	out.Lines = cleanLines(d["lines"])
	return out, true
}

func cleanString(v any) string {
	s, _ := v.(string)
	return s
}

// CleanIntent: intent and reason are free text an agent opted into
// publishing; a container under that key is not text, it's an envelope.
func CleanIntent(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

var permittedTopLevel = map[string]bool{
	"room": true, "human": true, "agent": true, "kind": true, "source": true,
	"verb": true, "region": true, "ts": true, "intent": true,
}

var forbiddenFields = map[string]bool{
	"content": true, "contents": true, "text": true, "body": true,
	"diff": true, "patch": true,
	"prompt": true, "reasoning": true, "completion": true, "output": true,
	"stdout": true, "stderr": true,
	"env": true, "environment": true, "secrets": true, "token": true,
	"credentials": true,
}

var stringFields = map[string]bool{
	"room": true, "human": true, "agent": true, "kind": true, "source": true,
	"verb": true, "intent": true,
}

// RedactEvent strips everything not explicitly permitted, by name and by
// type, from an inbound "event" frame. Mirrors redact.redact.
func RedactEvent(msg map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range msg {
		if !permittedTopLevel[key] || forbiddenFields[key] {
			continue
		}
		switch {
		case key == "region":
			if region, ok := cleanRegionRaw(value); ok {
				// Unmarked on purpose — see regionPayloadUnmarked's doc
				// comment. This dict is unhashed; the trailing
				// applyOpaqueMap pass below is what hashes it, once.
				out["region"] = regionPayloadUnmarked(region)
			}
		case key == "ts":
			if n, ok := value.(float64); ok {
				out["ts"] = n
			}
		case stringFields[key]:
			if s, ok := value.(string); ok {
				out[key] = s
			}
		}
	}
	if OpaqueEnabled() {
		out = applyOpaqueMap(out).(map[string]any)
	}
	return out
}

// -- outbound, whole-frame pass -------------------------------------------

// ApplyOpaqueOutbound is the last stop before the wire — a no-op unless
// opaque mode is on. Mirrors redact.opaque_outbound / apply_opaque: walks
// the payload and hashes every region-shaped map in it (one with a string
// "path"), skipping anything already marked. Defence in depth over the
// per-field hashing already done at ingest (CleanRegionDict, RedactEvent):
// this is what a field that slipped through some other path still gets
// caught by.
func ApplyOpaqueOutbound(payload Frame) Frame {
	if !OpaqueEnabled() {
		return payload
	}
	return applyOpaqueMap(map[string]any(payload)).(map[string]any)
}

// EncodeFrame is the one place a Frame becomes wire bytes: opaque mode,
// then JSON. Called exactly once per distinct outbound payload — by
// Relay.Broadcast/PublishTo for fan-out, and by the session loop for a
// direct reply — never once per recipient. Getting that backwards (each
// connection's own writer re-encoding the same frame) is the redundant
// per-recipient serialization the whole point of this relay is to not
// do; see docs/relay-parity.md.
//
// Every Frame this package builds is strings, bools, numbers, nil and
// nested maps/slices of the same — nothing that can fail to marshal, so
// an error here means a bug in a frame builder, not a runtime condition.
// Returned as nil in that case rather than panicking a fan-out goroutine
// mid-broadcast; WsConn.Send drops a nil payload.
func EncodeFrame(payload Frame) []byte {
	body := ApplyOpaqueOutbound(payload)
	b, err := json.Marshal(body)
	if err != nil {
		log.Printf("BUG: frame %v failed to marshal: %s", payload["type"], err)
		return nil
	}
	return b
}

func applyOpaqueMap(v any) any {
	// Frame is map[string]any under the hood, but a type switch matches
	// the concrete type, not what it's defined as — every frame built by
	// this package nests Frame values (regionPayload, leaseFrame, ...), so
	// without this conversion the walk below stops at the outer map and
	// never redacts what's nested inside it.
	if f, ok := v.(Frame); ok {
		v = map[string]any(f)
	}
	switch val := v.(type) {
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = applyOpaqueMap(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, vv := range val {
			out[k] = applyOpaqueMap(vv)
		}
		if out[OpaqueMark] == true {
			return out
		}
		pathAny, hasPath := out["path"]
		if !hasPath {
			return out
		}
		path, isStr := pathAny.(string)
		if !isStr {
			delete(out, "path")
			delete(out, "symbol")
			delete(out, "lines")
			return out
		}
		out["path"] = hashHex(path)
		if sym, ok := out["symbol"].(string); ok {
			out["symbol"] = hashHex(sym)
		}
		if _, has := out["lines"]; has {
			out["lines"] = nil
		}
		out[OpaqueMark] = true
		return out
	default:
		return v
	}
}
