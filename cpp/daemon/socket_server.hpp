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
    /// Accept and drain any pending connections. Returns after timeout_ms.
    void poll_once(int timeout_ms);

private:
    std::string path_;
    int fd_ = -1;
    std::function<void(std::string)> cb_;
};

}  // namespace ap
