#pragma once

// A stand-in for presenced's side of the decision protocol.
//
// The real daemon lives in cpp/daemon/ and is owned by someone else, so the hook
// tests cannot depend on it having grown a responder yet. What they can depend on
// is the wire contract in hook/hook.hpp, which this speaks: read one request line,
// optionally write one response line, close.
//
// It also models the ways a daemon misbehaves, because those are the cases the
// 5ms budget exists for: answering late, answering never, and hanging up early.

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace apt {

enum class Mode {
    kReply,    // read the request, write the response, close
    kSilent,   // read the request, close without answering (today's presenced)
    kHold,     // accept and then nothing at all: no read, no answer, no close
    kSlow,     // read the request, sleep, then answer far too late
    kHangup,   // accept and close immediately, before the request even lands
};

class FakeDaemon {
public:
    FakeDaemon(std::string path, Mode mode, std::string reply = {}, int delay_ms = 0)
        : path_(std::move(path)), mode_(mode), reply_(std::move(reply)), delay_ms_(delay_ms) {
        std::error_code ec;
        std::filesystem::remove(path_, ec);
    }

    ~FakeDaemon() {
        stop_.store(true, std::memory_order_relaxed);
        if (loop_.joinable()) loop_.join();
        if (fd_ >= 0) ::close(fd_);
        for (int held : held_) ::close(held);
        std::error_code ec;
        std::filesystem::remove(path_, ec);
    }

    bool start() {
        fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd_ < 0) return false;
        const int flags = ::fcntl(fd_, F_GETFL, 0);
        if (flags < 0 || ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK) != 0) return false;

        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path_.c_str());
        if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return false;
        if (::listen(fd_, 64) != 0) return false;

        loop_ = std::thread([this] { run(); });
        return true;
    }

    long long served() const { return served_.load(std::memory_order_relaxed); }

    std::string last_request() {
        std::lock_guard<std::mutex> lock(mu_);
        return last_request_;
    }

private:
    void run() {
        while (!stop_.load(std::memory_order_relaxed)) {
            pollfd p{fd_, POLLIN, 0};
            if (::poll(&p, 1, 5) != 1) continue;
            const int conn = ::accept(fd_, nullptr, nullptr);
            if (conn < 0) continue;
#ifdef SO_NOSIGPIPE
            const int on = 1;
            ::setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif
            serve(conn);
        }
    }

    void serve(int conn) {
        if (mode_ == Mode::kHold) {
            held_.push_back(conn);  // deliberately never read, never answered
            served_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        if (mode_ == Mode::kHangup) {
            ::close(conn);
            served_.fetch_add(1, std::memory_order_relaxed);
            return;
        }

        std::string buf;
        char chunk[4096];
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (buf.find('\n') == std::string::npos &&
               std::chrono::steady_clock::now() < deadline) {
            pollfd p{conn, POLLIN, 0};
            if (::poll(&p, 1, 20) != 1) continue;
            const ssize_t n = ::read(conn, chunk, sizeof(chunk));
            if (n <= 0) break;
            buf.append(chunk, static_cast<std::size_t>(n));
        }
        {
            std::lock_guard<std::mutex> lock(mu_);
            const auto nl = buf.find('\n');
            last_request_ = nl == std::string::npos ? buf : buf.substr(0, nl);
        }

        if (mode_ == Mode::kSlow && delay_ms_ > 0) {
            // Slept in small steps so teardown does not wait on a rude daemon.
            for (int i = 0; i < delay_ms_ && !stop_.load(std::memory_order_relaxed); ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }

        if (mode_ != Mode::kSilent && !reply_.empty()) {
            std::string out = reply_;
            out.push_back('\n');
            // A late reply lands on a hook that already gave up and closed, and
            // the default action for SIGPIPE would take this whole test binary
            // down with it. Which is the hazard the hook guards against too.
#ifdef MSG_NOSIGNAL
            const ssize_t ignored = ::send(conn, out.data(), out.size(), MSG_NOSIGNAL);
#else
            const ssize_t ignored = ::send(conn, out.data(), out.size(), 0);
#endif
            (void)ignored;
        }
        ::close(conn);
        served_.fetch_add(1, std::memory_order_relaxed);
    }

    std::string path_;
    Mode mode_;
    std::string reply_;
    int delay_ms_ = 0;
    int fd_ = -1;
    std::vector<int> held_;
    std::atomic<long long> served_{0};
    std::atomic<bool> stop_{false};
    std::thread loop_;
    std::mutex mu_;
    std::string last_request_;
};

}  // namespace apt
