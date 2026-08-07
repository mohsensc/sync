// Test-only shim: drives the daemon's real write_snapshot from the command
// line so the bash statusline can be tested against the actual writer.
//
//   snapshot_writer <path> [human verb path]...
#include <cstdio>
#include <string>
#include <vector>

#include "daemon/snapshot.hpp"

int main(int argc, char** argv) {
    if (argc < 2 || (argc - 2) % 3 != 0) {
        std::fprintf(stderr, "usage: %s <path> [human verb path]...\n", argv[0]);
        return 2;
    }
    std::vector<ap::Peer> peers;
    for (int i = 2; i < argc; i += 3) {
        peers.push_back(ap::Peer{argv[i], argv[i + 1], argv[i + 2]});
    }
    ap::write_snapshot(argv[1], peers);
    return 0;
}
