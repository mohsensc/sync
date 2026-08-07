#pragma once
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ap {

struct CachedLease {
    std::string agent;
    std::string human;
    std::string intent;
    long long expires_at_ms;
};

/// A read-only snapshot of relay-held leases, refreshed by push.
///
/// This class deliberately contains no protocol logic: no ladder, no
/// wound-wait, no arbitration. It answers exactly one question — "is there a
/// live lease on this region held by somebody else?" — so the C++ side can
/// never drift from the Python authority.
class LeaseCache {
public:
    void replace(std::vector<std::pair<std::string, CachedLease>> entries);

    std::optional<CachedLease> conflict_for(const std::string& region_key,
                                            const std::string& my_agent,
                                            long long now_ms) const;

private:
    std::unordered_map<std::string, CachedLease> by_region_;
};

}  // namespace ap
