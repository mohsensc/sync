#pragma once
#include <mutex>
#include <string>
#include <vector>

namespace ap {

/// Paths this agent was stopped on, waiting to be told to the relay.
///
/// The hook path never told anybody it wanted a region, and that made the
/// lease deadline unreachable where it matters most. Worth spelling out,
/// because the shape of this daemon hides it:
///
///   - a PreToolUse edit goes to the *decision* socket and is answered from the
///     local LeaseCache. No relay round trip, by design — that is what keeps it
///     inside a 2 ms budget.
///   - the relay only ever hears about an edit through a PostToolUse event, and
///     a blocked edit has no PostToolUse.
///
/// So an agent could be refused the same region a hundred times an hour and the
/// relay would never learn that anybody wanted it. The holder's renewals were
/// capped by *asking*, and on this path nobody ever asked. Priority and the
/// fair-share bound both worked only through the MCP tool channel.
///
/// This is the missing edge, and it is one string per block. The decision
/// threads drop a path in; the main loop drains it, coalesces it like any other
/// relay traffic, and sends one `contend` frame. Nothing waits on anything.
///
/// DecisionServer's contract is that a responder touches nothing but the lease
/// cache, because it runs concurrently with the loop. This keeps that contract
/// honest the same way LeaseCache does: its own lock, no other state, and no
/// call back into anything.
class ContendQueue {
public:
    /// Remember a path. Safe from any thread. Repeats within one drain collapse,
    /// and past `kMax` distinct paths the newest are dropped — a burst that
    /// large is a session touching everything, not a contest worth queueing.
    void note(const std::string& path);

    /// Take everything pending. Empty when nothing was blocked.
    std::vector<std::string> drain();

    /// The cap, exposed so a test can reach it without knowing the number.
    static constexpr std::size_t kMax = 64;

private:
    mutable std::mutex mu_;
    std::vector<std::string> pending_;
};

}  // namespace ap
