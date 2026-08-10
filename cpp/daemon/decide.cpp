#include "daemon/decide.hpp"

#include <algorithm>
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

void append_number(std::string& out, const char* key, long long value) {
    out += ",\"";
    out += key;
    out += "\":";
    out += std::to_string(value);
}

/// Milliseconds from now to `at_ms`, floored at zero. Never negative on the
/// wire: a hook that reads -3000 has to decide what that means, and there is
/// only one sensible answer, so it is given here.
long long left_ms(long long at_ms, long long now_ms) {
    return at_ms > now_ms ? at_ms - now_ms : 0;
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

/// A region this agent lost, as fields. Only ever recorded for handovers away
/// from *us* (see RelayClient), so its presence is already the whole claim.
void append_lost(std::string& out, const HandoverNote& lost, long long now_ms) {
    append_field(out, "lost_to", lost.to_human.empty() ? lost.to : lost.to_human);
    if (!lost.to.empty()) append_field(out, "lost_to_agent", lost.to);
    if (!lost.to_priority.empty()) append_field(out, "lost_to_priority", lost.to_priority);
    append_number(out, "lost_ms_ago", std::max(0LL, now_ms - lost.at_ms));
}

/// The two things an agent that is *not* blocked may still need to hear: that a
/// region it holds has a deadline on it, and that a region it held has gone.
///
/// Both ride on a rung 0 answer, which is what "nothing is blocked" has always
/// looked like on this wire, so a daemon that has neither to report produces
/// exactly the bytes it produced before any of this existed. That matters: rung
/// 0 is the overwhelmingly common answer and it has to stay free.
std::string ambient_response(const LeaseCache& leases, const PolicyCache& policy,
                             const std::string& path, const std::string& agent,
                             long long now_ms) {
    std::string out = open_response(0, policy.effect_for(0));

    if (const auto mine = leases.own_handover(path, agent, now_ms)) {
        // Delivered on this agent's own next edit, which is the only moment it
        // is both holding the region and reachable. A push channel does not
        // exist: hooks are the only way in.
        append_number(out, "handover_in_ms", left_ms(mine->handover_at_ms, now_ms));
        if (!mine->handover_to.empty()) append_field(out, "handover_to", mine->handover_to);
        if (!mine->handover_to_human.empty()) {
            append_field(out, "handover_to_human", mine->handover_to_human);
        }
        if (!mine->handover_to_priority.empty()) {
            append_field(out, "handover_to_priority", mine->handover_to_priority);
        }
        if (mine->waiting > 0) append_number(out, "waiting", mine->waiting);
        out += '}';
        return out;
    }

    if (const auto lost = leases.handover_note(path, now_ms, kHandoverNoteMs)) {
        append_lost(out, *lost, now_ms);
        out += '}';
        return out;
    }

    out += '}';
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
    if (!held) return ambient_response(leases, policy, path, agent, now_ms);

    // The rung is decided by the lease table alone and policy never moves it.
    // Only the effect is policy's to set — see §0 of docs/policy-design.md.
    std::string out = open_response(3, policy.effect_for(3));
    append_field(out, "holder", held->agent);
    if (!held->human.empty()) append_field(out, "human", held->human);
    if (!held->intent.empty()) append_field(out, "intent", held->intent);
    // Passed through exactly as the relay said it, unjudged. Which tiers are
    // worth telling an agent about is the hook's call, not the daemon's — see
    // hook_output — and a daemon that filtered here would have to be changed
    // again the day the tier names change.
    if (!held->priority.empty()) append_field(out, "holder_priority", held->priority);

    // How long this actually lasts. The hook used to print "their claim expires
    // on its own within 90 seconds" as a fixed string, which was true of a
    // holder that had stopped working and false of every holder that had not —
    // and the second kind is the whole reason anybody is reading the sentence.
    append_number(out, "expires_in_ms", left_ms(held->expires_at_ms, now_ms));
    if (held->handover_at_ms >= 0) {
        append_number(out, "handover_in_ms", left_ms(held->handover_at_ms, now_ms));
        // Whether the region is queued for *this* agent decides whether the
        // right instruction is "wait, it is yours" or "wait, and you are second".
        append_field(out, "handover_to", held->handover_to);
        if (held->waiting > 0) append_number(out, "waiting", held->waiting);
    }

    // And if this agent is blocked on a region it used to hold, the block and
    // the loss are the same event. Saying only the first leaves the agent
    // reading "sara is editing pay.py" with no idea that it was its own region
    // ten seconds ago, which is the moment the whole thing feels arbitrary.
    if (const auto lost = leases.handover_note(path, now_ms, kHandoverNoteMs)) {
        append_lost(out, *lost, now_ms);
    }
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
