#pragma once
#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "daemon/socket_server.hpp"
// Both halves derive the decision socket's path from the event socket's, and
// this is the one definition of how. Header-only, so the daemon takes on no
// dependency on the hook binary by using it.
#include "hook/protocol.hpp"

namespace ap {

/// The decision half of the hook protocol, on its own socket and its own
/// threads.
///
/// Why it is not just another fd in the daemon's main loop:
///
/// A PreToolUse decision has to come back inside the hook's 2ms budget, and a
/// one-way event does not have to come back at all. Sharing one listening
/// socket puts both in one FIFO accept queue, so a burst of events — anything
/// on the machine can open that socket, and a busy session opens it constantly
/// — leaves a decision request sitting behind however many events got there
/// first. It waits out its budget, the hook reads EOF, and the edit is allowed.
/// Nothing is logged and the hook still exits 0, which is the exact failure
/// this product exists to prevent. Measured at 16 event lanes, 60% of decisions
/// were lost that way.
///
/// A separate queue is what removes the head-of-line blocking, and a separate
/// thread is what decouples the answer from everything else the loop does
/// between polls: draining events, stepping the relay, writing the snapshot.
/// Neither alone is enough — one socket with two threads still hands a decision
/// whatever position in the queue it landed in.
///
/// This is safe to run beside the loop because a decision is a pure read of
/// LeaseCache, which takes a shared lock. The responder must touch nothing
/// else. It gets no access to presence, the coalescer or the outbound queue,
/// and it makes no protocol decisions of its own — same rule the rest of the
/// daemon lives by.
class DecisionServer {
public:
    /// Answers one request line. Called from the server's own threads, so it
    /// must be safe to call concurrently with itself and with the main loop.
    using Responder = std::function<std::string(const std::string&)>;

    DecisionServer(std::string path, Responder responder);
    ~DecisionServer();

    DecisionServer(const DecisionServer&) = delete;
    DecisionServer& operator=(const DecisionServer&) = delete;

    /// Bind, listen, and spin up the workers. False means no decision socket:
    /// the caller keeps answering on the event socket and hooks fall back to
    /// it, which is slower under load but never wrong.
    bool start();

    /// Stop the workers and drop the socket. Idempotent, and the destructor
    /// calls it.
    void stop();

    bool running() const { return running_.load(std::memory_order_relaxed); }

private:
    void work();

    /// How many threads answer.
    ///
    /// More than one so a client that connects and then says nothing costs one
    /// worker its per-connection budget instead of stalling every decision on
    /// the box. Four rather than two because two still lost about one answer in
    /// four hundred with the machine saturated — a decision is a lock and a map
    /// lookup, so the threads are asleep in poll() almost all of the time and
    /// the spare ones cost nothing but their stacks.
    static constexpr int kWorkers = 4;

    /// Per-connection read budget, in milliseconds.
    ///
    /// Longer than the hook's own 2ms on purpose. Matching it looked tidy and
    /// cost about one answer in four hundred: on a machine with every core
    /// busy, 2ms of wall clock is not always enough for this side to be
    /// scheduled, read the line and write the answer, and the connection was
    /// then closed on a hook that was still waiting. The cost of the longer
    /// budget is one worker held by a client that connects and says nothing,
    /// which is what having more than one worker is for.
    static constexpr int kConnTimeoutMs = 5;

    std::string path_;
    Responder responder_;
    SocketServer server_;
    std::atomic<bool> stop_{false};
    std::atomic<bool> running_{false};
    std::vector<std::thread> pool_;
};

}  // namespace ap
