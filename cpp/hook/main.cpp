#include <unistd.h>

#include <cstddef>
#include <cstdlib>
#include <string>

#include "hook/hook.hpp"

namespace {

// build_event wants three short scalars, and they live in the first few hundred
// bytes. Everything past this cap is a tool_input blob we are forbidden from
// forwarding anyway, so it is read and thrown away rather than buffered. A Write
// of a 50MB file used to be held in memory in full to extract a path.
constexpr std::size_t kMaxInput = 1u << 20;  // 1 MiB

// Reading stdin used to be the one unbounded step in a binary whose whole point
// is a 5ms cap. A parent that never closed its end held the tool call until
// Claude Code's own hook timeout fired, which is tens of seconds of an agent
// sitting still. This is the ceiling on that wait now. It is thousands of times
// any honest payload's cost, because cutting off a parent that is still writing
// hands it an EPIPE, and that is a worse way to fail than being slow.
constexpr int kReadBudgetMs = 1000;

// Left for the socket write once the payload is in. Kept separate so a slow
// read cannot eat the budget the delivery needs.
constexpr int kWriteBudgetMs = 5;

std::string join_path(std::string dir, const char* leaf) {
    if (!dir.empty() && dir.back() == '/') dir.pop_back();
    dir += '/';
    dir += leaf;
    return dir;
}

}  // namespace

int main() {
    // Exit 0 on every path. A hook that can fail is a hook that can break an
    // agent session, which is the one outcome that gets this uninstalled.
    try {
        const std::string input = ap::read_bounded(STDIN_FILENO, kMaxInput, kReadBudgetMs);

        const char* sock = std::getenv("AGENT_PRESENCE_SOCK");
        std::string path;
        if (sock != nullptr) {
            path = sock;
        } else if (const char* rt = std::getenv("XDG_RUNTIME_DIR")) {
            path = join_path(rt, "agent-presence.sock");
        } else if (const char* tmp = std::getenv("TMPDIR")) {
            path = join_path(tmp, "agent-presence.sock");
        } else {
            path = "/tmp/agent-presence.sock";
        }

        ap::write_line(path, ap::build_event(input), kWriteBudgetMs);
    } catch (...) {
        // Intentionally swallowed.
    }
    return 0;
}
