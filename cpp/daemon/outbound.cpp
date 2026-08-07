#include "daemon/outbound.hpp"

#include <utility>

namespace ap {

Outbound::Outbound(std::size_t capacity) : capacity_(capacity) {}

void Outbound::push(std::string msg) {
    if (capacity_ == 0) {
        ++dropped_;
        return;
    }
    if (q_.size() >= capacity_) {
        q_.pop_front();
        ++dropped_;
    }
    q_.push_back(std::move(msg));
}

std::vector<std::string> Outbound::drain() {
    std::vector<std::string> out(q_.begin(), q_.end());
    q_.clear();
    return out;
}

}  // namespace ap
