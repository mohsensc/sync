#include "daemon/snapshot.hpp"

#include <algorithm>
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

PresenceTable::PresenceTable(long long ttl_ms) : ttl_ms_(ttl_ms) {}

bool PresenceTable::touch(const std::string& agent, const std::string& human,
                          const std::string& verb, const std::string& path, long long now_ms) {
    auto it = agents_.find(agent);
    if (it == agents_.end()) {
        agents_.emplace(agent, Entry{human, verb, path, now_ms, seq_++});
        return true;
    }

    Entry& e = it->second;
    const bool changed = e.human != human || e.verb != verb || e.path != path;
    e.human = human;
    e.verb = verb;
    e.path = path;
    e.seen_ms = now_ms;
    // A repeat of the same thing keeps the agent alive but leaves the display
    // alone. Rewriting the file for it would be pure churn.
    return changed;
}

bool PresenceTable::expire(long long now_ms) {
    bool dropped = false;
    for (auto it = agents_.begin(); it != agents_.end();) {
        if (now_ms - it->second.seen_ms >= ttl_ms_) {
            it = agents_.erase(it);
            dropped = true;
        } else {
            ++it;
        }
    }
    return dropped;
}

std::vector<Peer> PresenceTable::peers() const {
    std::vector<const Entry*> ordered;
    ordered.reserve(agents_.size());
    for (const auto& kv : agents_) ordered.push_back(&kv.second);
    std::sort(ordered.begin(), ordered.end(),
              [](const Entry* a, const Entry* b) { return a->seq < b->seq; });

    std::vector<Peer> out;
    out.reserve(ordered.size());
    for (const Entry* e : ordered) out.push_back(Peer{e->human, e->verb, e->path});
    return out;
}

}  // namespace ap
