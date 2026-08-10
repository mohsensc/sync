#include "daemon/decide.hpp"

#include <optional>

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

std::string decide_response(const std::string& request, const LeaseCache& leases,
                            long long now_ms) {
    if (!wants_decision_line(request)) return {};

    // Rung 0 is a real answer, not a shrug: the hook prints nothing for it, and
    // sending it means a working chain is distinguishable on the wire from a
    // daemon that drained the line and hung up. Every path below answers.
    const std::string path = json_field(request, "path");
    const std::string agent = json_field(request, "agent");

    // Only edits contend, and only a named region can be looked up. The hook
    // already filters both, but the socket is writable by anything on the box.
    if (path.empty() || json_field(request, "verb") != "edit") return R"({"rung":0})";

    const std::optional<CachedLease> held = leases.conflict_for_file(path, agent, now_ms);
    if (!held) return R"({"rung":0})";

    std::string out = R"({"rung":3)";
    append_field(out, "holder", held->agent);
    if (!held->human.empty()) append_field(out, "human", held->human);
    if (!held->intent.empty()) append_field(out, "intent", held->intent);
    out += '}';
    return out;
}

}  // namespace ap
