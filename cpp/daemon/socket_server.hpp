#pragma once
#include <functional>
#include <string>

namespace ap {

class SocketServer {
public:
    explicit SocketServer(std::string path);
    ~SocketServer();

    bool start();
    void stop();
    void on_line(std::function<void(std::string)> cb);

    /// Answer lines as well as observe them.
    ///
    /// Runs after on_line for every line, on the connection that line arrived
    /// on. A non-empty return is written back with a newline; empty writes
    /// nothing, which the hook reads as "no answer" and therefore allow. The
    /// hook half-closes its write side before reading, so this must happen
    /// before the connection is closed and not on some later tick — there is no
    /// later tick, the connection is gone.
    ///
    /// Bounded by the same per-connection budget the read is: a client that
    /// accepts no bytes costs the daemon its few milliseconds and nothing more.
    void on_request(std::function<std::string(const std::string&)> cb);

    /// Accept and drain every pending connection, then return. Blocks at most
    /// timeout_ms in total, whatever the clients do.
    ///
    /// The daemon is single threaded, so one client that connects and then
    /// stops talking must not be able to hold the loop. Each connection gets a
    /// few milliseconds of its own and is then dropped, along with any bytes it
    /// never terminated with a newline.
    void poll_once(int timeout_ms);

    /// Per-connection read budget in milliseconds. Only worth changing in tests.
    void set_conn_timeout_ms(int ms) { conn_timeout_ms_ = ms; }

    /// The listening fd, or -1 before start(). Exposed so the owner can put it
    /// in a poll set alongside its other fds and do the waiting once, which is
    /// the only way a single-threaded daemon can be sitting on this socket at
    /// the moment a hook connects. Borrowed, never closed by the caller.
    int listen_fd() const { return fd_; }

private:
    /// Read whole lines off an accepted fd until EOF or the deadline, then close
    /// it. Never blocks past `budget_ms`.
    void drain_conn(int conn, int budget_ms);

    /// Hand one line to the callbacks and write back whatever the responder
    /// said. Returns false when the connection is no longer worth holding.
    bool serve_line(int conn, std::string line, long long deadline);

    std::string path_;
    int fd_ = -1;
    int conn_timeout_ms_ = 5;
    std::function<void(std::string)> cb_;
    std::function<std::string(const std::string&)> responder_;
};

}  // namespace ap
