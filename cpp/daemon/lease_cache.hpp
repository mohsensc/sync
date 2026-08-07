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

    /// The same question asked about a whole file rather than one region.
    ///
    /// A hook request names a path and no symbol, and a whole-file region
    /// contends with every symbol inside that path — see same_region() in
    /// types.py, which is the authority both sides answer to. An exact lookup on
    /// `path + "|"` would miss a live claim on `path|sign_in` and allow an edit
    /// the relay considers a collision, so the whole-file question gets its own
    /// entry point rather than a caller that guesses at keys.
    ///
    /// Region keys are `path + "|" + symbol`, so this matches by that prefix.
    /// A path containing '|' can therefore collide with another path, exactly as
    /// it already can in region_key itself; both resolve toward reporting a
    /// conflict, and a spurious rung 3 is an explained prompt, not a silent loss.
    std::optional<CachedLease> conflict_for_file(const std::string& path,
                                                 const std::string& my_agent,
                                                 long long now_ms) const;

private:
    std::unordered_map<std::string, CachedLease> by_region_;
};

}  // namespace ap
