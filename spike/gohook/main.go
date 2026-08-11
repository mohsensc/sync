// Spike for issue #23: does a Go hook clear the 5ms budget once fork+exec is
// counted. Deliberately a straight port of cpp/hook/'s hot path and nothing
// past it — same stdin read cap, same naive scalar field extractor (no JSON
// library: allocating a parser on every tool call is exactly the cost this
// spike exists to price), same two-socket protocol, same floor table. It does
// not implement the daemon-side message prose (handover/lost/near wording) in
// cpp/hook/hook.cpp — that is daemon policy dressing, not hot-path cost, and
// out of scope for "can the runtime meet the budget."
//
// Not wired into any build, not installed by install.sh. See spike/gohook/README.md.
package main

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	maxInput      = 1 << 20 // 1 MiB, same cap as cpp/hook/main.cpp
	readBudgetMs  = 1000    // stdin read ceiling, same as the C++ hook
	socketBudget  = 2 * time.Millisecond
	maxReplyBytes = 8192
)

// ---------------------------------------------------------------------------
// Minimal scalar JSON extraction — a port of cpp/hook/hook.cpp's `field()`.
// No parser: this runs before every tool call and has to cost near zero.
// ---------------------------------------------------------------------------

func field(json, key string) string {
	needle := "\"" + key + "\":\""
	pos := strings.Index(json, needle)
	if pos < 0 {
		return ""
	}
	pos += len(needle)

	var out strings.Builder
	for pos < len(json) {
		c := json[pos]
		if c == '"' {
			return out.String()
		}
		if c != '\\' {
			out.WriteByte(c)
			pos++
			continue
		}
		if pos+1 >= len(json) {
			break // truncated payload
		}
		e := json[pos+1]
		pos += 2
		switch e {
		case 'n':
			out.WriteByte('\n')
		case 't':
			out.WriteByte('\t')
		case 'r':
			out.WriteByte('\r')
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'u':
			cp, ok := hex4(json, pos)
			if !ok {
				return ""
			}
			pos += 4
			if cp >= 0xD800 && cp <= 0xDBFF {
				if lo, ok := hex4(json, pos+2); ok && pos+6 <= len(json) &&
					json[pos] == '\\' && json[pos+1] == 'u' && lo >= 0xDC00 && lo <= 0xDFFF {
					cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
					pos += 6
				} else {
					cp = 0xFFFD
				}
			} else if cp >= 0xDC00 && cp <= 0xDFFF {
				cp = 0xFFFD
			}
			out.WriteRune(rune(cp))
		default:
			out.WriteByte(e) // covers \" \\ \/ and anything odd
		}
	}
	return "" // unterminated string: no value worth sending
}

func hex4(s string, pos int) (rune, bool) {
	if pos+4 > len(s) {
		return 0, false
	}
	var v rune
	for i := 0; i < 4; i++ {
		c := s[pos+i]
		v <<= 4
		switch {
		case c >= '0' && c <= '9':
			v |= rune(c - '0')
		case c >= 'a' && c <= 'f':
			v |= rune(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v |= rune(c-'A') + 10
		default:
			return 0, false
		}
	}
	return v, true
}

// intField mirrors cpp/hook/hook.cpp's int_field: a bare number only, no quotes.
func intField(json, key string, missing int) int {
	needle := "\"" + key + "\":"
	pos := strings.Index(json, needle)
	if pos < 0 {
		return missing
	}
	pos += len(needle)
	for pos < len(json) && (json[pos] == ' ' || json[pos] == '\t') {
		pos++
	}
	negative := false
	if pos < len(json) && (json[pos] == '-' || json[pos] == '+') {
		negative = json[pos] == '-'
		pos++
	}
	if pos >= len(json) || json[pos] < '0' || json[pos] > '9' {
		return missing
	}
	v := 0
	for pos < len(json) && json[pos] >= '0' && json[pos] <= '9' {
		v = v*10 + int(json[pos]-'0')
		if v > 1000000 {
			v = 1000000
		}
		pos++
	}
	if negative {
		v = -v
	}
	return v
}

func appendJSONString(out *strings.Builder, v string) {
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch c {
		case '"':
			out.WriteString("\\\"")
		case '\\':
			out.WriteString("\\\\")
		case '\n':
			out.WriteString("\\n")
		case '\t':
			out.WriteString("\\t")
		case '\r':
			out.WriteString("\\r")
		case '\b':
			out.WriteString("\\b")
		case '\f':
			out.WriteString("\\f")
		default:
			if c < 0x20 {
				fmt.Fprintf(out, "\\u%04x", c)
			} else {
				out.WriteByte(c)
			}
		}
	}
}

func verbFor(tool string) string {
	switch tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return "edit"
	case "Read":
		return "read"
	case "Grep", "Glob":
		return "search"
	case "Bash":
		return "run"
	default:
		return "think"
	}
}

func wantsDecision(hookJSON string) bool {
	if field(hookJSON, "hook_event_name") != "PreToolUse" {
		return false
	}
	return verbFor(field(hookJSON, "tool_name")) == "edit"
}

func buildEvent(hookJSON string) string {
	tool := field(hookJSON, "tool_name")
	path := field(hookJSON, "file_path")
	session := field(hookJSON, "session_id")

	var out strings.Builder
	out.WriteString(`{"verb":"`)
	appendJSONString(&out, verbFor(tool))
	out.WriteString(`","agent":"`)
	appendJSONString(&out, session)
	out.WriteString(`","path":"`)
	appendJSONString(&out, path)
	out.WriteString(`"}`)
	return out.String()
}

func buildRequest(hookJSON string) string {
	out := buildEvent(hookJSON)
	if len(out) < 2 || out[len(out)-1] != '}' {
		return out
	}
	return out[:len(out)-1] + `,"want":"decision"}`
}

// ---------------------------------------------------------------------------
// Decision + the floor, ported from protocol.hpp / hook.hpp.
// ---------------------------------------------------------------------------

type effect int

const (
	effectSilent effect = iota
	effectNotify
	effectContext
	effectAsk
	effectDeny
)

var effectNames = [5]string{"silent", "notify", "context", "ask", "deny"}

func parseEffect(s string) (effect, bool) {
	for i, n := range effectNames {
		if s == n {
			return effect(i), true
		}
	}
	return 0, false
}

func louder(a, b effect) effect {
	if a >= b {
		return a
	}
	return b
}

// Same table as ap::kHookFloor: what the daemon's answer cannot go below.
var hookFloor = [5]effect{effectSilent, effectSilent, effectSilent, effectNotify, effectSilent}

type decision struct {
	rung   int
	effect string
	holder string
	human  string
	intent string
}

func parseDecision(line string) decision {
	d := decision{rung: -1}
	if line == "" {
		return d
	}
	d.rung = intField(line, "rung", -1)
	if d.rung < 0 {
		return d
	}
	d.effect = field(line, "effect")
	d.holder = field(line, "holder")
	d.human = field(line, "human")
	d.intent = field(line, "intent")
	return d
}

func effectOf(d decision) effect {
	e, ok := parseEffect(d.effect)
	if !ok {
		// Legacy daemon with no effect field: rung 0 is nothing to say, any
		// other rung was always at least a notify.
		if d.rung > 0 {
			e = effectNotify
		} else {
			e = effectSilent
		}
	}
	rung := d.rung
	if rung < 0 {
		rung = 0
	}
	if rung >= 5 {
		rung = 4
	}
	return louder(e, hookFloor[rung])
}

// hookOutput is deliberately terser than cpp/hook/hook.cpp's message
// rendering (near/blocked/handover/lost/policy prose) — that text is daemon
// policy dressing, not hot-path cost, and out of scope for this spike. It
// still exercises the same decision: string building, the floor lookup, and
// the two JSON shapes Claude Code actually reads (permissionDecision,
// additionalContext).
func hookOutput(d decision, path string) string {
	if d.rung < 0 {
		return ""
	}
	where := path
	if where == "" {
		where = "this file"
	}
	e := effectOf(d)

	holder := d.holder
	if holder == "" {
		holder = d.human
	}
	msg := holder + " is editing " + where
	if d.intent != "" {
		msg += ": \"" + d.intent + "\""
	}

	var out strings.Builder
	switch e {
	case effectSilent, effectNotify:
		return ""
	case effectContext:
		out.WriteString(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"`)
		appendJSONString(&out, msg)
		out.WriteString(`"}}`)
	case effectAsk:
		out.WriteString(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"`)
		appendJSONString(&out, msg)
		out.WriteString(`"}}`)
	case effectDeny:
		out.WriteString(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"`)
		appendJSONString(&out, msg)
		out.WriteString(`"}}`)
	}
	return out.String()
}

// ---------------------------------------------------------------------------
// The socket round trip.
// ---------------------------------------------------------------------------

func decisionSockPath(eventSock string) string {
	if eventSock == "" {
		return ""
	}
	return eventSock + ".decide"
}

// writeLine is the fire-and-forget path: connect, write, done. Never reads.
func writeLine(sockPath, line string, budget time.Duration) bool {
	if sockPath == "" {
		return false
	}
	deadline := time.Now().Add(budget)
	d := net.Dialer{Deadline: deadline}
	conn, err := d.Dial("unix", sockPath)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	_, err = conn.Write([]byte(line + "\n"))
	return err == nil
}

// requestDecision connects, sends `line`, half-closes, and reads one response
// line back, all inside budget. Mirrors ap::request_decision: any failure
// yields rung < 0, and `connected` tells the caller whether the socket was
// reached at all so it knows whether to fall back to the event socket.
func requestDecision(sockPath, line string, budget time.Duration) (decision, bool) {
	if sockPath == "" {
		return decision{rung: -1}, false
	}
	deadline := time.Now().Add(budget)
	d := net.Dialer{Deadline: deadline}
	conn, err := d.Dial("unix", sockPath)
	if err != nil {
		return decision{rung: -1}, false
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)

	if _, err := conn.Write([]byte(line + "\n")); err != nil {
		return decision{rung: -1}, true
	}
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	var resp bytes.Buffer
	buf := make([]byte, 4096)
	for resp.Len() < maxReplyBytes {
		n, err := conn.Read(buf)
		if n > 0 {
			resp.Write(buf[:n])
			if idx := bytes.IndexByte(resp.Bytes(), '\n'); idx >= 0 {
				return parseDecision(resp.String()[:idx]), true
			}
		}
		if err != nil {
			break // EOF or timeout: whatever's in resp is the whole answer
		}
	}
	return parseDecision(resp.String()), true
}

func remaining(start time.Time, budget time.Duration) time.Duration {
	left := budget - time.Since(start)
	if left < 0 {
		return 0
	}
	return left
}

// runHook is the whole hook minus process I/O, same split as ap::run_hook.
func runHook(hookJSON, sockPath string, budget time.Duration) string {
	if !wantsDecision(hookJSON) {
		writeLine(sockPath, buildEvent(hookJSON), budget)
		return ""
	}

	request := buildRequest(hookJSON)
	start := time.Now()

	d, connected := requestDecision(decisionSockPath(sockPath), request, budget)
	if !connected {
		if left := remaining(start, budget); left > 0 {
			d, _ = requestDecision(sockPath, request, left)
		}
	}
	path := field(hookJSON, "file_path")
	return hookOutput(d, path)
}

// ---------------------------------------------------------------------------
// stdin, bounded — a port of ap::read_bounded. Reads (and discards past the
// cap) until EOF or the deadline, whichever comes first.
// ---------------------------------------------------------------------------

func readBounded(r io.Reader, maxBuf int, timeout time.Duration) string {
	var mu sync.Mutex
	buf := make([]byte, 0, 4096)
	done := make(chan struct{})

	go func() {
		defer close(done)
		tmp := make([]byte, 65536)
		for {
			n, err := r.Read(tmp)
			if n > 0 {
				mu.Lock()
				if len(buf) < maxBuf {
					take := n
					if room := maxBuf - len(buf); take > room {
						take = room
					}
					buf = append(buf, tmp[:take]...)
				}
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(timeout):
		// Parent never closed its end. Take whatever is there now; the
		// goroutine is abandoned, same tradeoff main.cpp documents: killing
		// the read early hands a still-writing parent an EPIPE, which is worse
		// than this process exiting a beat later than it needs to.
	}
	mu.Lock()
	defer mu.Unlock()
	return string(buf)
}

// ---------------------------------------------------------------------------

func sockPath() string {
	if v := os.Getenv("AGENT_PRESENCE_SOCK"); v != "" {
		return v
	}
	if v := os.Getenv("XDG_RUNTIME_DIR"); v != "" {
		return joinPath(v, "agent-presence.sock")
	}
	if v := os.Getenv("TMPDIR"); v != "" {
		return joinPath(v, "agent-presence.sock")
	}
	return "/tmp/agent-presence.sock"
}

func joinPath(dir, leaf string) string {
	dir = strings.TrimSuffix(dir, "/")
	return dir + "/" + leaf
}

func main() {
	// Exit 0 on every path, same rule as main.cpp: a hook that can fail is a
	// hook that can break an agent session.
	defer func() { _ = recover() }()

	input := readBounded(os.Stdin, maxInput, time.Duration(readBudgetMs)*time.Millisecond)
	out := runHook(input, sockPath(), socketBudget)
	if out != "" {
		os.Stdout.WriteString(out)
		os.Stdout.WriteString("\n")
	}
}
