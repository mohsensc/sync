#include "daemon/contend_queue.hpp"

#include <algorithm>
#include <utility>

namespace ap {

void ContendQueue::note(const std::string& path) {
    if (path.empty()) return;
    std::lock_guard<std::mutex> lock(mu_);
    if (std::find(pending_.begin(), pending_.end(), path) != pending_.end()) return;
    if (pending_.size() >= kMax) return;
    pending_.push_back(path);
}

std::vector<std::string> ContendQueue::drain() {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<std::string> out;
    out.swap(pending_);
    return out;
}

}  // namespace ap
