#include "daemon/coalesce.hpp"

namespace ap {

Coalescer::Coalescer(int window_ms, std::size_t max_per_window)
    : window_ms_(window_ms), max_per_window_(max_per_window) {}

bool Coalescer::admit(const Ev& e, long long now_ms) {
    if (now_ms - window_start_ >= window_ms_) {
        window_start_ = now_ms;
        in_window_ = 0;
    }

    const std::string key = e.agent + "|" + e.verb + "|" + e.path;
    auto it = last_seen_.find(key);
    if (it != last_seen_.end() && now_ms - it->second < window_ms_) return false;

    if (in_window_ >= max_per_window_) {
        ++dropped_;
        return false;
    }

    last_seen_[key] = now_ms;
    ++in_window_;
    return true;
}

}  // namespace ap
