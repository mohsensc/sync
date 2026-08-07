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

private:
    /// Read whole lines off an accepted fd until EOF or the deadline, then close
    /// it. Never blocks past `budget_ms`.
    void drain_conn(int conn, int budget_ms);

    std::string path_;
    int fd_ = -1;
    int conn_timeout_ms_ = 5;
    std::function<void(std::string)> cb_;
};

}  // namespace ap
