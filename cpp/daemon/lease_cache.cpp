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

}  // namespace ap
