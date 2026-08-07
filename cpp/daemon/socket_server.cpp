#include "daemon/socket_server.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <utility>

namespace ap {
namespace {

bool set_nonblocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0) return false;
    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

/// Milliseconds left until `deadline`, floored at zero.
int left_ms(long long deadline) {
    const long long left = deadline - now_ms();
    return left > 0 ? static_cast<int>(left) : 0;
}

}  // namespace

SocketServer::SocketServer(std::string path) : path_(std::move(path)) {}
SocketServer::~SocketServer() { stop(); }

void SocketServer::on_line(std::function<void(std::string)> cb) { cb_ = std::move(cb); }

bool SocketServer::start() {
    // A stale socket file from a crashed daemon must never prevent restart.
    std::error_code ec;
    std::filesystem::remove(path_, ec);

    fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd_ < 0) return false;

    // Non-blocking listen fd: accept() must never park the loop, not even on
    // the race where poll() reports a connection that is gone by the time we
    // get to it.
    if (!set_nonblocking(fd_)) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path_.c_str());

    if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    if (::listen(fd_, 64) != 0) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    return true;
}

void SocketServer::stop() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
        std::error_code ec;
        std::filesystem::remove(path_, ec);
    }
}

void SocketServer::drain_conn(int conn, int budget_ms) {
    if (!set_nonblocking(conn)) {
        ::close(conn);
        return;
    }

    const long long deadline = now_ms() + (budget_ms > 0 ? budget_ms : 0);
    std::string buf;
    char chunk[4096];

    for (;;) {
        const ssize_t n = ::read(conn, chunk, sizeof(chunk));
        if (n > 0) {
            buf.append(chunk, static_cast<size_t>(n));
            // Emit as we go so a long-lived connection is not held hostage by
            // its own tail.
            size_t start = 0;
            for (;;) {
                const size_t nl = buf.find('\n', start);
                if (nl == std::string::npos) break;
                if (cb_) cb_(buf.substr(start, nl - start));
                start = nl + 1;
            }
            if (start) buf.erase(0, start);
            continue;
        }
        if (n == 0) break;  // clean EOF: the client said everything it had
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) break;

        const int left = left_ms(deadline);
        if (left == 0) break;  // out of budget; whatever is unterminated is dropped
        pollfd pfd{conn, POLLIN, 0};
        if (::poll(&pfd, 1, left) != 1) break;
        if ((pfd.revents & (POLLERR | POLLNVAL)) != 0) break;
    }

    // Anything left in buf has no newline. It is a partial line and there is no
    // second chance for it: holding it would mean holding the connection.
    ::close(conn);
}

void SocketServer::poll_once(int timeout_ms) {
    if (fd_ < 0) return;

    const long long deadline = now_ms() + (timeout_ms > 0 ? timeout_ms : 0);

    // Wait for the first connection, then take everything else that is already
    // queued without waiting again. The wait reserves the per-connection budget
    // so the total stays inside timeout_ms.
    bool served_one = false;

    for (;;) {
        int wait_ms = 0;
        if (!served_one) {
            wait_ms = left_ms(deadline) - conn_timeout_ms_;
            if (wait_ms < 0) wait_ms = 0;
        }

        pollfd p{fd_, POLLIN, 0};
        const int r = ::poll(&p, 1, wait_ms);
        if (r < 0) {
            if (errno == EINTR) continue;
            return;
        }
        if (r == 0) return;  // nothing pending
        if ((p.revents & POLLIN) == 0) return;

        const int conn = ::accept(fd_, nullptr, nullptr);
        if (conn < 0) {
            if (errno == EINTR) continue;
            return;  // EAGAIN: the backlog is empty after all
        }
        served_one = true;

        int budget = left_ms(deadline);
        if (budget > conn_timeout_ms_) budget = conn_timeout_ms_;
        drain_conn(conn, budget);

        // Out of time. The rest of the backlog waits for the next tick, which
        // is what a backlog is for.
        if (left_ms(deadline) == 0) return;
    }
}

}  // namespace ap
