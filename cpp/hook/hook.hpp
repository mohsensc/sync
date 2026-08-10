#pragma once
#include <cstddef>
#include <string>

#include "hook/protocol.hpp"

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
//   {"rung":<int>,"effect":"<name>","holder":"<agent id>","human":"<name>",
//    "intent":"<text>","decision":"ask"}
//
//   rung      required. The collision ladder rung this edit reaches, decided
//             against the daemon's local LeaseCache. No network call: a lookup
//             on a table the relay pushed. Absent or unparseable means "no
//             answer", which means allow.
//   effect    what to do about it: silent, notify, context, ask or deny. This
//             is the room's policy, resolved on the daemon side. Absent means
//             the daemon predates effects; see `decision` below.
//   holder    the agent id already in the region. Optional.
//   human     display name for that agent. Optional; falls back to holder.
//   intent    what the holder said they are doing, from their MCP claim.
//             Optional, and the reason rung 3 is worth interrupting for.
//   decision  the legacy shape of `effect`, still sent, set to "ask" when the
//             effect is "ask". Read only when `effect` is absent.
//
// The region is the path for now. When region keys grow symbols and line
// ranges, both sides gain the same fields on `path`; the shape does not change.
//
// --- What the hook does with an answer -------------------------------------
//
// The rung says what happened. The effect says what to do about it, and it is
// the effect that picks the output — a rung 3 the room quieted to `notify`
// prints nothing, and a rung 1 the room raised to `deny` blocks. For a while
// the rung picked the output on its own and the effect was parsed by nobody,
// which made every `[effects]` table on the machine decorative: `ap why`
// reported the configured effect and the hook denied anyway.
//
//   no answer          print nothing. Exit 0. Identical to nothing installed.
//   silent, notify     print nothing.
//   context            additionalContext. Never blocks.
//   ask                permissionDecision ask, with the reason.
//   deny               permissionDecision deny, with the reason.
//
// `kHookFloor` is the part of that the daemon does not get a vote on — anything
// on this box can write to that socket. See hook.cpp.
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
    /// What the room's policy says to do about that rung, by name. Empty when
    /// the daemon did not say, which is a daemon from before effects existed;
    /// `decision` is then the only thing left to read.
    std::string effect;
    /// The legacy spelling of an `ask` effect. Only read when `effect` is empty.
    std::string decision;
    std::string holder;
    std::string human;
    std::string intent;
    /// The tier the holder's lease was taken at, by name. Empty when the relay
    /// said nothing. Only `elevated` and `critical` are ever rendered: they are
    /// the two that explain why waiting is the right move rather than retrying.
    std::string holder_priority;

    /// The agent this request came from, so the hook can tell "the region is
    /// queued for you" from "somebody is ahead of you" without a second lookup.
    std::string agent;

    /// How long the holder's lease has left, and when it stops being renewable.
    /// Negative means the daemon did not say — an older one, or an uncontended
    /// lease, which has no deadline at all.
    long long expires_in_ms = -1;
    long long handover_in_ms = -1;
    /// Who the region goes to when that deadline passes.
    std::string handover_to;
    std::string handover_to_human;
    std::string handover_to_priority;
    /// How many agents are queued on the region. 0 when unsaid.
    int waiting = 0;

    /// Set when a region *this* agent held has gone to somebody else. The one
    /// event an agent cannot piece together on its own: its lease vanishes, its
    /// next edit is refused, and nothing says the two are the same thing.
    std::string lost_to;
    std::string lost_to_priority;
    long long lost_ms_ago = -1;
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

/// The floor the hook holds the daemon's answer to.
///
/// Anything on this box can write to that socket, so the effect that arrives is
/// the room's opinion and not an instruction. This is the part of the answer
/// that is not up for negotiation.
///
/// `notify` at rung 3 and not `deny`, deliberately: quieting rung 3 is a thing a
/// room is allowed to ask for, and `notify` still reaches a human through the
/// statusline and the relay's fan-out. What the floor rules out is a rung 3
/// resolving below what the rest of the system treats as the minimum. It is the
/// same table as `kBuiltinFloor` on the daemon side, for the same reason.
inline constexpr Effect kHookFloor[5] = {Effect::Silent, Effect::Silent, Effect::Silent,
                                         Effect::Notify, Effect::Silent};

/// What the daemon's answer resolves to once the floor is applied. Exposed
/// because "which effect did this response actually mean" is a question worth
/// asking without rendering a whole message to find out.
Effect effect_of(const Decision& d);

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
