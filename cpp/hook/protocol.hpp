#pragma once
#include <string>

// The parts of the hook <-> daemon protocol both halves have to agree on
// letter for letter, header-only so neither side needs to link the other.
//
// hook/hook.hpp documents the protocol; this file is the bit of it that is
// code. It defines nothing that is not inline, so the daemon including it picks
// up no dependency on the hook binary.

namespace ap {

/// Where the decision socket lives, given the event socket's path.
///
/// The two paths are separate sockets on purpose. One-way events and PreToolUse
/// decisions used to share a listening socket, which meant one accept queue:
/// under a burst of events a decision request sat behind them, waited out its
/// budget, and the edit was allowed with nothing said. The queue is what has to
/// be separate, so the sockets are.
///
/// Derived from the event socket rather than configured separately: the hook
/// already knows where the event socket is, and a second environment variable
/// is a second thing that can be set to the wrong value.
///
/// A daemon that does not serve this path is an older one. The hook falls back
/// to asking on the event socket, which is what it always did.
inline std::string decision_sock_path(const std::string& event_sock) {
    if (event_sock.empty()) return {};
    return event_sock + ".decide";
}

}  // namespace ap
