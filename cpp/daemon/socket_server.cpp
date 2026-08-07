#include "daemon/socket_server.hpp"

#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdio>
#include <filesystem>
#include <utility>

namespace ap {

SocketServer::SocketServer(std::string path) : path_(std::move(path)) {}
SocketServer::~SocketServer() { stop(); }

void SocketServer::on_line(std::function<void(std::string)> cb) { cb_ = std::move(cb); }

bool SocketServer::start() {
    // A stale socket file from a crashed daemon must never prevent restart.
    std::error_code ec;
    std::filesystem::remove(path_, ec);

    fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd_ < 0) return false;

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

void SocketServer::poll_once(int timeout_ms) {
    if (fd_ < 0) return;
    pollfd p{fd_, POLLIN, 0};
    if (::poll(&p, 1, timeout_ms) <= 0) return;

    int conn = ::accept(fd_, nullptr, nullptr);
    if (conn < 0) return;

    std::string buf;
    char chunk[4096];
    ssize_t n;
    while ((n = ::read(conn, chunk, sizeof(chunk))) > 0) buf.append(chunk, n);
    ::close(conn);

    size_t start = 0;
    while (true) {
        size_t nl = buf.find('\n', start);
        if (nl == std::string::npos) break;
        if (cb_) cb_(buf.substr(start, nl - start));
        start = nl + 1;
    }
}

}  // namespace ap
