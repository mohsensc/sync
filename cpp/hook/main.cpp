#include <unistd.h>

#include <csignal>
#include <cstddef>
#include <cstdio>
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

// What the socket phase gets once the payload is in, whether it is a one-way
// event or a full request and response. Kept separate so a slow read cannot eat
// the budget the delivery needs.
//
// Deliberately well under the 5ms cap. The budget is what poll() is asked to
// wait, and poll() overshoots: on macOS a 3ms deadline measured anywhere from
// 3.9 to 4.7ms once timer granularity and a scheduler round trip are paid for,
// which is close enough to 5 to flake. 2ms measures under 4 and is still an
// eternity next to the 0.13ms a local lease lookup actually costs.
// tests/test_latency.cpp measures the real number and asserts the cap.
constexpr int kSocketBudgetMs = 2;

}  // namespace

int main() {
    // Nothing this process writes to is worth dying over: not the socket if the
    // daemon hangs up mid-request, not stdout if Claude Code went away. The
    // default action for SIGPIPE is death, and a hook that dies fails the tool
    // call it was supposed to be invisible to.
    std::signal(SIGPIPE, SIG_IGN);

    // Exit 0 on every path. A hook that can fail is a hook that can break an
    // agent session, which is the one outcome that gets this uninstalled.
    try {
        const std::string input = ap::read_bounded(STDIN_FILENO, kMaxInput, kReadBudgetMs);

        const std::string path = ap::resolve_sock_path();

        // Empty means say nothing, and saying nothing is how a hook allows.
        const std::string out = ap::run_hook(input, path, kSocketBudgetMs);
        if (!out.empty()) {
            std::fwrite(out.data(), 1, out.size(), stdout);
            std::fputc('\n', stdout);
            std::fflush(stdout);
        }
    } catch (...) {
        // Intentionally swallowed.
    }
    return 0;
}
