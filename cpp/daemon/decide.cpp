#include "daemon/decide.hpp"

#include <optional>
#include <string>

#include "daemon/json.hpp"

namespace ap {
namespace {

void append_field(std::string& out, const char* key, const std::string& value) {
    out += ",\"";
    out += key;
    out += "\":\"";
    append_json_string(out, value);
    out += '"';
}

}  // namespace

bool wants_decision_line(std::string_view line) {
    return json_field(line, "want") == "decision";
}

namespace {

/// `{"rung":N,"effect":"..."}` plus the legacy `decision` field when it applies.
/// Unterminated on purpose: the rung-3 path has more fields to add.
std::string open_response(int rung, Effect effect) {
    std::string out = "{\"rung\":";
    out += std::to_string(rung);
    append_field(out, "effect", effect_name(effect));
    // The old field, still on the wire. A hook from before this change reads
    // `decision` and nothing else, and dropping it would turn every `ask` that
    // hook could have rendered into a `deny` it renders instead.
    if (effect == Effect::Ask) append_field(out, "decision", "ask");
    return out;
}

}  // namespace

std::string decide_response(const std::string& request, const LeaseCache& leases,
                            const PolicyCache& policy, long long now_ms) {
    if (!wants_decision_line(request)) return {};

    // Rung 0 is a real answer, not a shrug: the hook prints nothing for it, and
    // sending it means a working chain is distinguishable on the wire from a
    // daemon that drained the line and hung up. Every path below answers.
    const std::string path = json_field(request, "path");
    const std::string agent = json_field(request, "agent");

    // Only edits contend, and only a named region can be looked up. The hook
    // already filters both, but the socket is writable by anything on the box.
    if (path.empty() || json_field(request, "verb") != "edit") {
        return open_response(0, policy.effect_for(0)) + "}";
    }

    const std::optional<CachedLease> held = leases.conflict_for_file(path, agent, now_ms);
    if (!held) return open_response(0, policy.effect_for(0)) + "}";

    // The rung is decided by the lease table alone and policy never moves it.
    // Only the effect is policy's to set — see §0 of docs/policy-design.md.
    std::string out = open_response(3, policy.effect_for(3));
    append_field(out, "holder", held->agent);
    if (!held->human.empty()) append_field(out, "human", held->human);
    if (!held->intent.empty()) append_field(out, "intent", held->intent);
    out += '}';
    return out;
}

std::string decide_response(const std::string& request, const LeaseCache& leases,
                            long long now_ms) {
    // Function-local so there is exactly one, built on first use and never
    // refreshed: it is the compiled-in table by construction.
    static const PolicyCache kDefaults;
    return decide_response(request, leases, kDefaults, now_ms);
}

}  // namespace ap
