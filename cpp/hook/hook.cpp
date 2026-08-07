#include "hook/hook.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <string>
#include <string_view>

namespace ap {
namespace {

/// Minimal scalar extractor. A full JSON parser is deliberately avoided: this
/// binary runs before every tool call and its cost must be near zero.
std::string field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":\"";
    auto pos = json.find(needle);
    if (pos == std::string_view::npos) return {};
    pos += needle.size();
    auto end = json.find('"', pos);
    if (end == std::string_view::npos) return {};
    return std::string(json.substr(pos, end - pos));
}

std::string verb_for(const std::string& tool) {
    if (tool == "Edit" || tool == "Write" || tool == "NotebookEdit") return "edit";
    if (tool == "Read") return "read";
    if (tool == "Grep" || tool == "Glob") return "search";
    if (tool == "Bash") return "run";
    return "think";
}

/// Milliseconds left of the budget, floored at zero.
int remaining_ms(std::chrono::steady_clock::time_point start, int budget_ms) {
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - start)
                           .count();
    const long left = static_cast<long>(budget_ms) - static_cast<long>(spent);
    return left > 0 ? static_cast<int>(left) : 0;
}

}  // namespace

std::string build_event(const std::string& hook_json) {
    const std::string tool = field(hook_json, "tool_name");
    const std::string path = field(hook_json, "file_path");
    const std::string session = field(hook_json, "session_id");

    std::string out = "{\"verb\":\"";
    out += verb_for(tool);
    out += "\",\"agent\":\"";
    out += session;
    out += "\",\"path\":\"";
    out += path;
    out += "\"}";
    return out;
}

bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms) {
    if (sock_path.empty() || sock_path.size() >= sizeof(sockaddr_un::sun_path)) return false;

    const auto start = std::chrono::steady_clock::now();

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return false;
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path.c_str());

    // Non-blocking connect. If the daemon is absent we abandon the event rather
    // than delay the agent. A dropped event costs one animation frame; a blocked
    // hook costs the user's patience on every tool call.
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        // A full listen backlog is the one case worth a bounded wait.
        if (errno != EINPROGRESS && errno != EAGAIN) {
            ::close(fd);
            return false;
        }
        pollfd pfd{fd, POLLOUT, 0};
        if (::poll(&pfd, 1, remaining_ms(start, timeout_ms)) != 1 || (pfd.revents & POLLOUT) == 0) {
            ::close(fd);
            return false;
        }
        int err = 0;
        socklen_t len = sizeof(err);
        if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            ::close(fd);
            return false;
        }
    }

    std::string payload = line;
    payload.push_back('\n');

    size_t sent = 0;
    while (sent < payload.size()) {
        ssize_t n = ::write(fd, payload.data() + sent, payload.size() - sent);
        if (n > 0) {
            sent += static_cast<size_t>(n);
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            const int left = remaining_ms(start, timeout_ms);
            if (left == 0) break;
            pollfd pfd{fd, POLLOUT, 0};
            if (::poll(&pfd, 1, left) != 1 || (pfd.revents & POLLOUT) == 0) break;
            continue;
        }
        break;  // EPIPE and friends: drop the event, never signal the agent.
    }

    ::close(fd);
    return sent == payload.size();
}

}  // namespace ap
