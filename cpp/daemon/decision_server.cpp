#include "daemon/decision_server.hpp"

#include <utility>

namespace ap {

DecisionServer::DecisionServer(std::string path, Responder responder)
    : path_(std::move(path)), responder_(std::move(responder)), server_(path_) {}

DecisionServer::~DecisionServer() { stop(); }

bool DecisionServer::start() {
    if (running_.load(std::memory_order_relaxed)) return true;
    if (path_.empty() || !responder_) return false;

    // No on_line: this socket carries requests, not events. A line that asks
    // nothing gets an empty answer and is dropped, the same as on the event
    // socket, and nothing that arrives here is ever forwarded to the relay.
    server_.on_request(responder_);
    server_.set_conn_timeout_ms(kConnTimeoutMs);
    if (!server_.start()) return false;

    stop_.store(false, std::memory_order_relaxed);
    running_.store(true, std::memory_order_relaxed);
    pool_.reserve(kWorkers);
    for (int i = 0; i < kWorkers; ++i) pool_.emplace_back([this] { work(); });
    return true;
}

void DecisionServer::work() {
    // Several workers polling and accepting on one listening fd is fine: accept
    // hands the connection to exactly one of them, and SocketServer keeps no
    // state across calls that a second thread could tear.
    //
    // The timeout is how long a worker takes to notice stop(), and nothing
    // else — a connection arriving wakes the poll immediately.
    while (!stop_.load(std::memory_order_relaxed)) server_.poll_once(25);
}

void DecisionServer::stop() {
    if (!running_.exchange(false, std::memory_order_relaxed)) return;
    stop_.store(true, std::memory_order_relaxed);
    // Join before closing the fd. Closing it out from under a thread sitting in
    // poll() means that thread is waiting on a number the kernel is free to
    // hand to the next file this process opens.
    for (auto& t : pool_) {
        if (t.joinable()) t.join();
    }
    pool_.clear();
    server_.stop();
}

}  // namespace ap
