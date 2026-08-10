#pragma once
#include <array>
#include <cstddef>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <string_view>

// Effect, effect_name, parse_effect, louder. They are wire vocabulary — the
// daemon writes `"effect":"deny"` and the hook reads it — so they live with the
// rest of the protocol both halves have to agree on letter for letter.
#include "hook/protocol.hpp"

namespace ap {

// ===========================================================================
// The decision-relevant slice of policy, and nothing else
// ===========================================================================
//
// The hook's whole round trip has a 5ms budget. Everything a decision needs has
// to already be in memory when the request arrives, so this class holds five
// enum values and answers with an array index under a shared lock. That is the
// entire cost policy adds to the hot path.
//
// What is deliberately *not* here: TOML, globs, layers, precedence, floors from
// four sources, the observer ceiling, the unattended promotion. All of that is
// resolved on the Python side by `ap policy compile`, which writes one line of
// JSON to $XDG_RUNTIME_DIR. This reads that line. The daemon never parses a
// config file, never forks, never calls the network and never touches the disk
// inside a decision — it stats one file on the 100ms tick it already runs and
// re-reads only when the mtime or the size moves.
//
// Two inputs, combined with one max():
//
//   local_   the compiled client-side table (repo + user + session + builtin)
//   floor_   the org floor, pushed by the relay on join and on change
//
// max() and not "the relay wins": the relay does not have the client's local
// layers, so it cannot know that this machine asked for something stricter.
// Floors compose upward, so taking the louder of the two is the only answer
// that respects both. `floor_` is itself clamped up to kBuiltinFloor when it is
// set, which is what makes "a degraded policy never resolves below the builtin
// floor" a structural property rather than a promise.

constexpr int kRungs = 5;

struct PolicyTable {
    std::array<Effect, kRungs> rung;
};

/// Installing the engine and configuring nothing has to be today's behaviour,
/// byte for byte. These are the tables that make that true.
/// Rung 4 sits at `context`: AGENT_PRESENCE_RUNG4 is already its off switch, so
/// a second one here would make turning the feature on do nothing.
inline constexpr PolicyTable kBuiltin{
    {Effect::Silent, Effect::Notify, Effect::Context, Effect::Deny, Effect::Context}};

/// Rung 3's floor is `notify`, not `silent`. A silent rung 3 is the product
/// lying: two agents in one symbol with nothing said anywhere is the pre-install
/// world, and nothing a config file or a broken cache does may produce it.
inline constexpr PolicyTable kBuiltinFloor{
    {Effect::Silent, Effect::Silent, Effect::Silent, Effect::Notify, Effect::Silent}};

/// Read a five-element array of effect names — `["silent","notify",...]` — into
/// `out`. Returns false and leaves `out` untouched unless the array really was
/// five strings; a name that is not an effect leaves *that rung* alone and
/// appends one line to `problem`, so one bad word cannot drop the other four.
bool parse_effect_list(std::string_view array, PolicyTable& out, std::string* problem);

/// The same, but finding `"key":[...]` inside a one-line JSON object first.
bool parse_effect_array(std::string_view json, std::string_view key, PolicyTable& out,
                        std::string* problem);

class PolicyCache {
public:
    /// Re-read the compiled cache if it moved. True when the table changed.
    ///
    /// Call it from the tick, as often as you like: it stats at most once per
    /// kRecheckMs and parses only when the mtime or size differs from the last
    /// read. Everything expensive happens outside the lock the hot path takes.
    ///
    /// A file that is not there yet is not a fault — the daemon is allowed to
    /// start before anything has compiled a policy, and `kBuiltin` is the
    /// documented default rather than a degradation. A file that *was* there
    /// and is now unreadable or unusable is: the previous table stays in force
    /// and degraded() goes true, because falling back to silence on a truncated
    /// write is the one outcome this must never produce.
    bool refresh(const std::string& path, long long now_ms);

    /// The org floor the relay pushed. Clamped up to kBuiltinFloor on the way
    /// in, so a relay — or anything pretending to be one — cannot lower it.
    void set_floor(const PolicyTable& floor, std::string source);

    /// The only call on the hot path: one shared lock, one array index, one max.
    /// A rung outside 0..4 is "no answer", which is silent.
    Effect effect_for(int rung) const;

    /// Which of the two inputs decided a rung, and where that side came from.
    ///
    /// `effect_for` plus `source()` plus `floor_source()` would be three lock
    /// acquisitions and could straddle a `set_floor` between them, which is how
    /// `ap why` ends up naming a file that did not decide anything. One shared
    /// lock, one consistent answer.
    struct Origin {
        Effect effect = Effect::Silent;
        /// True when the floor is strictly louder than the local table, i.e.
        /// the floor is what the agent actually ran into.
        bool from_floor = false;
        /// Where the deciding side came from. Empty means the compiled-in
        /// table, which is not a file anybody can go and edit.
        std::string source;
    };
    Origin explain(int rung) const;

    PolicyTable table() const;
    PolicyTable floor() const;

    bool degraded() const;
    /// One line, empty when healthy. Goes in the snapshot and on `ap doctor`.
    std::string problem() const;
    /// Where the local table came from, or empty while it is still the builtin.
    std::string source() const;
    std::string floor_source() const;

    /// How many times the file was actually read and parsed. The point of the
    /// mtime gate is that this stays flat while nothing changes.
    std::size_t parses() const;

    /// The largest compiled cache this daemon will read. Public so a test can
    /// stand on the edge of it without hard-coding the number twice.
    static constexpr std::size_t max_bytes() { return kMaxBytes; }

private:
    static constexpr long long kRecheckMs = 100;
    static constexpr long long kNever = -1;
    /// The cache stopped being one line of five-name arrays when `ap policy
    /// compile` started carrying the [[path]] globs instead of resolving them
    /// away: it now grows with the policy, and a 1200-rule repo policy weighs
    /// about 100KB. The old 64KB cap silently turned that into an unreadable
    /// file — the daemon kept the builtin table, `ap doctor` read the same file
    /// in Python and said ok, and nobody found out until a rung 3 went quiet.
    /// Still a cap: a file this far past any policy anyone writes is not our
    /// file, and it is bounded work on a tick.
    static constexpr std::size_t kMaxBytes = 4 * 1024 * 1024;

    void note(const std::string& problem);

    /// Serialises refreshers so the stat, the read and the parse can all happen
    /// outside `mu_`. Without it the hot path's shared lock would be held for
    /// the length of a file read every time the policy changed.
    mutable std::mutex io_mu_;
    long long checked_ms_ = kNever;
    long long mtime_ns_ = kNever;
    long long size_ = kNever;
    bool loaded_ = false;

    mutable std::shared_mutex mu_;
    PolicyTable local_ = kBuiltin;
    PolicyTable floor_ = kBuiltinFloor;
    std::string source_;
    std::string floor_source_;
    std::string problem_;
    std::size_t parses_ = 0;
};

}  // namespace ap
