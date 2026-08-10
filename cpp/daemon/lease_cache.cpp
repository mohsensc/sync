#include "daemon/lease_cache.hpp"

#include <mutex>

namespace ap {

void LeaseCache::replace(std::vector<std::pair<std::string, CachedLease>> entries) {
    std::unique_lock<std::shared_mutex> lock(mu_);
    by_region_.clear();
    for (auto& [key, lease] : entries) by_region_.emplace(key, std::move(lease));
}

std::optional<CachedLease> LeaseCache::conflict_for(const std::string& region_key,
                                                    const std::string& my_agent,
                                                    long long now_ms) const {
    std::shared_lock<std::shared_mutex> lock(mu_);
    auto it = by_region_.find(region_key);
    if (it == by_region_.end()) return std::nullopt;      // unknown -> allow
    if (it->second.agent == my_agent) return std::nullopt;
    if (it->second.expires_at_ms <= now_ms) return std::nullopt;
    return it->second;
}

std::optional<CachedLease> LeaseCache::conflict_for_file(const std::string& path,
                                                         const std::string& my_agent,
                                                         long long now_ms) const {
    if (path.empty()) return std::nullopt;
    const std::string prefix = path + "|";

    std::shared_lock<std::shared_mutex> lock(mu_);
    // Whichever live foreign lease is found first. There is no ranking to make
    // here: every one of them contends with a whole-file edit, and naming one
    // holder is what the hook renders. Iteration order is unspecified, so a file
    // held by two agents may name either — both answers are true.
    for (const auto& [key, lease] : by_region_) {
        if (key.size() < prefix.size() || key.compare(0, prefix.size(), prefix) != 0) continue;
        if (lease.agent == my_agent) continue;
        if (lease.expires_at_ms <= now_ms) continue;
        return lease;
    }
    return std::nullopt;
}

std::optional<CachedLease> LeaseCache::own_handover(const std::string& path,
                                                    const std::string& my_agent,
                                                    long long now_ms) const {
    if (path.empty() || my_agent.empty()) return std::nullopt;
    const std::string prefix = path + "|";

    std::shared_lock<std::shared_mutex> lock(mu_);
    // The soonest deadline, when this agent holds more than one region in the
    // file. Warning about the one that is furthest away would be worse than
    // saying nothing: it is the near one that is about to cost it work.
    std::optional<CachedLease> soonest;
    for (const auto& [key, lease] : by_region_) {
        if (key.size() < prefix.size() || key.compare(0, prefix.size(), prefix) != 0) continue;
        if (lease.agent != my_agent) continue;
        if (lease.expires_at_ms <= now_ms) continue;
        if (lease.handover_at_ms < 0) continue;
        if (!soonest || lease.handover_at_ms < soonest->handover_at_ms) soonest = lease;
    }
    return soonest;
}

void LeaseCache::note_handover(const std::string& path, HandoverNote note) {
    if (path.empty()) return;
    std::unique_lock<std::shared_mutex> lock(mu_);
    // Prune on write, so the map is bounded by the last half hour of handovers
    // and not by how long the daemon has been up. Handovers are rare; this
    // costs nothing that anybody can measure.
    const long long cutoff = note.at_ms - kHandoverNoteMs;
    for (auto it = lost_.begin(); it != lost_.end();) {
        it = (it->second.at_ms < cutoff) ? lost_.erase(it) : std::next(it);
    }
    lost_[path] = std::move(note);
}

std::optional<HandoverNote> LeaseCache::handover_note(const std::string& path, long long now_ms,
                                                      long long within_ms) const {
    if (path.empty()) return std::nullopt;
    std::shared_lock<std::shared_mutex> lock(mu_);
    const auto it = lost_.find(path);
    if (it == lost_.end()) return std::nullopt;
    if (now_ms - it->second.at_ms > within_ms) return std::nullopt;
    return it->second;
}

}  // namespace ap
