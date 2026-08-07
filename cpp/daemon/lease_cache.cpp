#include "daemon/lease_cache.hpp"

namespace ap {

void LeaseCache::replace(std::vector<std::pair<std::string, CachedLease>> entries) {
    by_region_.clear();
    for (auto& [key, lease] : entries) by_region_.emplace(key, std::move(lease));
}

std::optional<CachedLease> LeaseCache::conflict_for(const std::string& region_key,
                                                    const std::string& my_agent,
                                                    long long now_ms) const {
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

}  // namespace ap
