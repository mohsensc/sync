#pragma once
#include <optional>
#include <string>
#include <string_view>

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

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
//
// Five, totally ordered by attention spent: silent < notify < context < ask <
// deny. docs/policy-design.md §1 is the table of what each one means on each
// surface; this is the vocabulary, and it lives here because `"effect":"deny"`
// goes over the wire and both halves have to read the same five words.
//
// It used to live in daemon/policy_cache.hpp, where the hook could not reach
// it. That is not why the hook ignored the field — it ignored it because
// nothing parsed it — but a second copy of the five names in hook.cpp would
// have been the next bug rather than a fix for this one.

enum class Effect : int {
    Silent = 0,
    Notify = 1,
    Context = 2,
    Ask = 3,
    Deny = 4,
};

/// How many there are. Not the same number as the rung count, which is also
/// five and coincidentally so.
inline constexpr int kEffects = 5;

/// The wire names, in lattice order. The one place they are spelled.
inline constexpr const char* kEffectNames[kEffects] = {"silent", "notify", "context", "ask",
                                                       "deny"};

/// The wire name. Never null; an out-of-range value reads as "silent".
inline const char* effect_name(Effect e) {
    const int i = static_cast<int>(e);
    if (i < 0 || i >= kEffects) return kEffectNames[0];
    return kEffectNames[i];
}

/// The inverse. Empty for anything not one of the five — including the empty
/// string, which is what a daemon from before effects existed sends.
inline std::optional<Effect> parse_effect(std::string_view s) {
    for (int i = 0; i < kEffects; ++i) {
        if (s == kEffectNames[i]) return static_cast<Effect>(i);
    }
    return std::nullopt;
}

/// Louder of the two. The lattice is totally ordered by attention spent, so
/// this is the whole of "apply a floor".
inline Effect louder(Effect a, Effect b) { return a >= b ? a : b; }

}  // namespace ap
