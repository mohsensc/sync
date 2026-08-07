#pragma once
#include <cstddef>
#include <deque>
#include <string>
#include <vector>

namespace ap {

/// Rebuild a socket line as the only four fields the relay is allowed to see.
///
/// The hook emits exactly these, but the daemon does not get to assume that:
/// anything on the machine can write to the unix socket, and whatever it wrote
/// used to be forwarded verbatim. Contents, diffs, prompts and env vars all
/// ride along under a key nobody checked. This is the same allowlist boundary
/// redact.py enforces on the relay side, applied before the bytes leave.
///
/// Values are moved as their original JSON escape sequences rather than
/// decoded and re-encoded: a path may legally hold a quote or a newline, and
/// a round trip is one more place to get that wrong.
std::string redact_line(const std::string& line);

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
