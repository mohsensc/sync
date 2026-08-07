#include "daemon/snapshot.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>

namespace ap {
namespace {

std::string escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}

}  // namespace

void write_snapshot(const std::string& path, const std::vector<Peer>& peers) {
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::trunc);
        if (!f) return;  // fail open: a missing snapshot just blanks the statusline
        f << "{\"peers\":[";
        for (size_t i = 0; i < peers.size(); ++i) {
            if (i) f << ",";
            f << "{\"human\":\"" << escape(peers[i].human)
              << "\",\"verb\":\"" << escape(peers[i].verb)
              << "\",\"path\":\"" << escape(peers[i].path) << "\"}";
        }
        f << "]}";
    }
    std::error_code ec;
    std::filesystem::rename(tmp, path, ec);
}

}  // namespace ap
