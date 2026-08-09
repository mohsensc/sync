#pragma once
#include <cstddef>
#include <string>

namespace ap {

// ===========================================================================
// The hook <-> daemon socket protocol
// ===========================================================================
//
// One unix SOCK_STREAM connection per hook invocation. Newline-delimited JSON
// in both directions. There are no ids and no multiplexing: a response belongs
// to the request it arrived on, and the connection is closed after it.
//
// Two sockets, not one. Events go to `$AGENT_PRESENCE_SOCK` and decisions to
// that path plus `.decide` — see protocol.hpp, which both halves derive it
// with. They are separate because they shared an accept queue and a decision
// therefore waited behind whatever events were in front of it, spent its
// budget, and allowed the edit without saying anything. A hook still falls back
// to asking on the event socket when nothing answers on the decision one, which
// is what a daemon from before the split does.
//
// The protocol is deliberately relay-agnostic. The hook knows nothing about
// leases, rooms, wait-die or the relay; it asks a local question and renders
// the answer. Everything the daemon needs to arbitrate it already has.
//
// --- Request (hook -> daemon), exactly one line ----------------------------
//
//   {"verb":"edit","agent":"<session id>","path":"<absolute path>"}
//   {"verb":"edit","agent":"<session id>","path":"<...>","want":"decision"}
//
// `want` is absent for every observe-and-exit event, which is all of them
// except PreToolUse on a writing tool. When absent the hook does not read and
// does not wait: the daemon may answer or not, nobody is listening.
//
// When `want` is `"decision"` the hook half-closes its write side (shutdown
// SHUT_WR) as soon as the line is out, then reads. A daemon that only ever
// drained lines sees a clean EOF, closes, and the hook silently allows — which
// is why this change cannot break a daemon that has not implemented it yet.
// A daemon that does answer may write its response after that EOF; the read
// side is still open.
//
// `verb` follows the event vocabulary: edit, read, search, run, think. Only
// `edit` ever carries `want`.
//
// --- Response (daemon -> hook), exactly one line ---------------------------
//
//   {"rung":<int>,"holder":"<agent id>","human":"<name>","intent":"<text>",
//    "decision":"deny"|"ask"}
//
//   rung      required. The collision ladder rung this edit reaches, decided
//             against the daemon's local LeaseCache. No network call: a lookup
//             on a table the relay pushed. Absent or unparseable means "no
//             answer", which means allow.
//   holder    the agent id already in the region. Optional.
//   human     display name for that agent. Optional; falls back to holder.
//   intent    what the holder said they are doing, from their MCP claim.
//             Optional, and the reason rung 3 is worth interrupting for.
//   decision  optional override, and only ever downward: "ask" softens a rung 3
//             block into a prompt. Anything else is ignored. A daemon cannot
//             use this field to turn a block into an allow, and cannot use it
//             to turn rungs 0-2 into a block.
//
// The region is the path for now. When region keys grow symbols and line
// ranges, both sides gain the same fields on `path`; the shape does not change.
//
// --- What the hook does with a rung ----------------------------------------
//
//   no answer  print nothing. Exit 0. Identical to nothing being installed.
//   rung 0     print nothing. Co-location is the world's job, not the agent's.
//   rung 1-2   additionalContext only. Never blocks.
//   rung >= 3  permissionDecision deny (or ask), with the holder and their
//              intent in the reason.
//
// --- Budget ----------------------------------------------------------------
//
// Connect, write and read share one deadline of a few milliseconds. Every way
// this can fail — no socket, full backlog, no answer, a late answer, a torn
// down connection, a malformed line — resolves to "print nothing, exit 0".
// A slow daemon delays a tool call by the budget and never by more.
//
// ===========================================================================

/// What the daemon said, or didn't.
struct Decision {
    /// Ladder rung, or negative for "the daemon did not answer".
    int rung = -1;
    /// Daemon's downward override at rung 3: "ask", or empty for the default.
    std::string decision;
    std::string holder;
    std::string human;
    std::string intent;
    /// The tier the holder's lease was taken at, by name. Empty when the relay
    /// said nothing. Only `elevated` and `critical` are ever rendered: they are
    /// the two that explain why waiting is the right move rather than retrying.
    std::string holder_priority;
};

/// True when this payload is a PreToolUse on a tool that writes to a file, and
/// therefore the one case that does a round trip. Everything else observes and
/// exits. A payload with no hook_event_name gets no decision: an edit that has
/// already happened must never be handed a permission decision.
bool wants_decision(const std::string& hook_json);

/// Build a minimal JSON event from a Claude Code hook payload.
/// Extracts only permitted fields; never copies file contents or prompts.
std::string build_event(const std::string& hook_json);

/// build_event plus the `"want":"decision"` marker.
std::string build_request(const std::string& hook_json);

/// Parse one response line. Anything unparseable yields rung < 0, which the
/// rest of the hook treats as "allow".
Decision parse_decision(const std::string& line);

/// Render a decision as what belongs on stdout. Empty means print nothing,
/// which Claude Code reads as allow.
std::string hook_output(const Decision& d, const std::string& path);

/// Connect, send `line`, half-close, and read one response line back — all
/// inside `timeout_ms` total. Any failure returns a Decision with rung < 0.
/// Never blocks past the budget, never throws, never raises a signal.
///
/// `connected`, when given, comes back true if the socket was reached at all,
/// which is how the caller tells "there is no daemon on this path" from "the
/// daemon had nothing to say". Only the first is worth asking somewhere else.
Decision request_decision(const std::string& sock_path, const std::string& line, int timeout_ms,
                          bool* connected = nullptr);

/// Connect to a unix socket and write one line. Returns false on any failure.
/// Never blocks longer than timeout_ms and never throws.
bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms);

/// The whole hook minus process I/O: decide what to send, send it, and return
/// exactly what belongs on stdout. Empty string means say nothing.
std::string run_hook(const std::string& hook_json, const std::string& sock_path, int budget_ms);

/// Read the hook payload off `fd`, buffering at most `max_buffer` bytes and
/// giving up after `timeout_ms` no matter what the writer does.
///
/// Bytes past the cap are read and discarded rather than left in the pipe: the
/// fields we want sit in the first few hundred bytes, but exiting early would
/// hand the parent an EPIPE on a write it is still making, and a hook that can
/// error the process that spawned it is worse than a slow one. The deadline is
/// the backstop for the parent that never closes its end at all.
std::string read_bounded(int fd, std::size_t max_buffer, int timeout_ms);

}  // namespace ap
