#include "daemon/repo.hpp"

#include <openssl/evp.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <iomanip>
#include <regex>
#include <sstream>

namespace ap {
namespace {
const std::regex kScp(R"(^[^/@]+@([^:]+):(.+)$)");
const std::regex kProto(R"(^[a-z+]+://)");
const std::regex kUserinfo(R"(^[^/@]+@)");
}  // namespace

std::string normalize_remote(const std::string& url) {
    std::string s = url;
    // Python's str.strip() with no argument; these are the characters git
    // remotes ever pick up.
    const char* ws = " \t\n\r\f\v";
    const auto first = s.find_first_not_of(ws);
    if (first == std::string::npos) {
        s.clear();
    } else {
        s.erase(0, first);
        s.erase(s.find_last_not_of(ws) + 1);
    }
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

    std::smatch m;
    if (std::regex_match(s, m, kScp)) {
        s = m[1].str() + "/" + m[2].str();
    } else {
        s = std::regex_replace(s, kProto, "");
        s = std::regex_replace(s, kUserinfo, "");
    }

    if (s.size() >= 4 && s.compare(s.size() - 4, 4, ".git") == 0) {
        s.erase(s.size() - 4);
    }
    while (!s.empty() && s.back() == '/') s.pop_back();
    return s;
}

std::string room_id_from_remote(const std::string& url) {
    const std::string n = normalize_remote(url);
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    // EVP rather than the deprecated one-shot SHA256() — same bytes out.
    EVP_Digest(n.data(), n.size(), digest, &len, EVP_sha256(), nullptr);

    std::ostringstream out;
    for (int i = 0; i < 8; ++i) {  // 8 bytes -> 16 hex chars
        out << std::hex << std::setw(2) << std::setfill('0')
            << static_cast<int>(digest[i]);
    }
    return out.str();
}

std::optional<std::string> find_repo_root(const std::string& start_path) {
    std::error_code ec;
    auto p = std::filesystem::absolute(start_path, ec);
    if (ec) return std::nullopt;

    while (true) {
        // A worktree's .git is a file, not a directory, so exists() is the test.
        if (std::filesystem::exists(p / ".git", ec)) return p.string();
        if (!p.has_parent_path() || p.parent_path() == p) return std::nullopt;
        p = p.parent_path();
    }
}

}  // namespace ap
