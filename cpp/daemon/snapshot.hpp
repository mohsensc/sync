#pragma once
#include <string>
#include <vector>

namespace ap {

struct Peer {
    std::string human;
    std::string verb;
    std::string path;
};

/// Write atomically: temp file then rename. The statusline reads this file
/// once a second and must never observe a partial write.
void write_snapshot(const std::string& path, const std::vector<Peer>& peers);

}  // namespace ap
