#pragma once
#include <string>
#include <string_view>

#include "daemon/lease_cache.hpp"

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
std::string decide_response(const std::string& request, const LeaseCache& leases,
                            long long now_ms);

}  // namespace ap
