#pragma once
#include <cstddef>
#include <deque>
#include <string>
#include <vector>

namespace ap {

/// Bounded FIFO for messages awaiting the relay.
///
/// Bounded on purpose: during a long outage an unbounded queue would consume
/// memory and then replay a flood of stale presence on reconnect. Presence is
/// only useful while it is current, so the oldest is discarded first.
class Outbound {
public:
    explicit Outbound(std::size_t capacity);

    void push(std::string msg);
    std::vector<std::string> drain();
    std::size_t dropped() const { return dropped_; }
    std::size_t size() const { return q_.size(); }

private:
    std::size_t capacity_;
    std::size_t dropped_ = 0;
    std::deque<std::string> q_;
};

}  // namespace ap
