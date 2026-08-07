#pragma once
#include <cstddef>
#include <string>
#include <unordered_map>

namespace ap {

struct Ev {
    std::string verb;
    std::string path;
    std::string agent;
};

/// Collapses repeats and caps volume per window. Overflow is dropped and
/// counted, never queued: a backlog would delay live presence forever.
class Coalescer {
public:
    Coalescer(int window_ms, std::size_t max_per_window);

    bool admit(const Ev& e, long long now_ms);
    std::size_t dropped() const { return dropped_; }

private:
    int window_ms_;
    std::size_t max_per_window_;
    long long window_start_ = 0;
    std::size_t in_window_ = 0;
    std::size_t dropped_ = 0;
    std::unordered_map<std::string, long long> last_seen_;
};

}  // namespace ap
