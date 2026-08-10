#pragma once
#include <string>
#include <string_view>

#include "daemon/lease_cache.hpp"
#include "daemon/policy_cache.hpp"

namespace ap {

// The daemon's half of the request/response protocol in hook/hook.hpp.
//
// The hook sends one line and, when that line carries `"want":"decision"`,
// half-closes and reads one line back. Until this existed the daemon only ever
// drained: every edit got a clean EOF, every rung came back negative, and the
// blocking half of the product was unreachable no matter what the relay knew.
//
// Everything here is a pure function over the request line and the lease cache.
// No network, no clock of its own, no allocation worth measuring — it runs
// inside the hook's few-millisecond budget on the daemon's single thread.

/// True when this line is asking for an answer rather than just reporting.
bool wants_decision_line(std::string_view line);

/// The response line for `request`, or empty when the line asked nothing.
///
/// Rungs come from the lease cache and nowhere else, which is what keeps the
/// ladder single-sourced in the relay: a live lease held by another agent on
/// the file being edited is rung 3, and anything else is rung 0. Rungs 1 and 2
/// need the incoming region to be narrower than a whole file, and a hook
/// request carries no symbol, so they cannot arise here.
///
/// Never returns a trailing newline; the caller frames it.
///
/// The response carries the rung *and* the effect. The rung is a fact about the
/// lease table and policy cannot change it — a room configured to `notify` at
/// rung 3 still answers `{"rung":3}`, so the wire stays a truthful record and
/// `ap why` can say what was seen as well as what was done about it. The effect
/// is what the hook renders.
///
/// `"decision":"ask"` still rides along whenever the effect is `ask`, because a
/// hook built before effects existed reads that field and nothing else. New
/// hooks read `effect` and ignore it.
/// `self_agent` is the id this machine joined the room under — the daemon's
/// relay agent id, which is what every lease in the cache is keyed by. It is
/// not the same string as the request's `agent`: that one is Claude Code's
/// `session_id`, which the relay has never seen. Comparing the two is how a
/// machine ended up blocked by its own claim, never heard that its lease was on
/// a clock, and got told a region queued for it was queued for somebody else.
/// Empty means no room is configured, and then the request's own agent is all
/// there is and behaves as it always did.
std::string decide_response(const std::string& request, const LeaseCache& leases,
                            const PolicyCache& policy, long long now_ms,
                            const std::string& self_agent);

std::string decide_response(const std::string& request, const LeaseCache& leases,
                            const PolicyCache& policy, long long now_ms);

/// True when this answer is a rung 3 — the one answer that stops an edit, and
/// therefore the one that means this agent wanted a region somebody else holds.
///
/// The rung, not the effect: a room configured to `notify` at rung 3 still has
/// two agents on one region, and the waiting agent's ask is worth the same
/// whether or not the room chose to stop it.
bool blocked_by_lease(const std::string& answer);

/// The same, against the compiled-in defaults. This is what the shipped tables
/// produce, so it is also what "installing the engine and configuring nothing"
/// has to keep producing.
std::string decide_response(const std::string& request, const LeaseCache& leases,
                            long long now_ms);

}  // namespace ap
