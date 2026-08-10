#pragma once
#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

namespace ap {

struct Peer {
    std::string human;
    std::string verb;
    std::string path;
};

/// Write atomically: temp file then rename. The statusline reads this file
/// once a second and must never observe a partial write.
///
/// `problem` is how a policy degradation gets said out loud. Fail open and fail
/// safe are different things: the daemon keeps running on the last good table
/// (open), and it is not allowed to do that quietly (safe). The two fields are
/// written only when there *is* a problem, so a healthy snapshot is byte for
/// byte what it always was and nothing downstream has to learn a new shape to
/// keep working.
void write_snapshot(const std::string& path, const std::vector<Peer>& peers,
                    const std::string& problem = "");

/// Who is currently doing what, one entry per agent.
///
/// The statusline has no other source of truth, so a stale table reads exactly
/// like a dead daemon. Agents drop off after ttl_ms of silence rather than
/// lingering forever on their last event.
class PresenceTable {
public:
    explicit PresenceTable(long long ttl_ms);

    /// Record an event. Returns true when the snapshot would look different,
    /// which is the only time it is worth rewriting the file.
    bool touch(const std::string& agent, const std::string& human, const std::string& verb,
               const std::string& path, long long now_ms);

    /// Forget agents that have gone quiet. Returns true if any were dropped.
    bool expire(long long now_ms);

    /// First-seen order, so the statusline does not reshuffle every tick.
    std::vector<Peer> peers() const;
    std::size_t size() const { return agents_.size(); }

private:
    struct Entry {
        std::string human;
        std::string verb;
        std::string path;
        long long seen_ms = 0;
        long long seq = 0;
    };

    long long ttl_ms_;
    long long seq_ = 0;
    std::unordered_map<std::string, Entry> agents_;
};

}  // namespace ap
