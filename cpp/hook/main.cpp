#include <cstdlib>
#include <iostream>
#include <iterator>
#include <string>

#include "hook/hook.hpp"

namespace {

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
        std::string input((std::istreambuf_iterator<char>(std::cin)),
                          std::istreambuf_iterator<char>());

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

        ap::write_line(path, ap::build_event(input), 5);
    } catch (...) {
        // Intentionally swallowed.
    }
    return 0;
}
