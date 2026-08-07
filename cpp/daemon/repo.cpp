#include "daemon/repo.hpp"

#include <openssl/evp.h>

#include <cstddef>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <string_view>

namespace ap {
namespace {

// Python's str.strip() over the ASCII range: 0x09-0x0d, 0x1c-0x1f, 0x20.
// (The old set here missed 0x1c-0x1f, so a remote ending in one of those
// normalized differently in each language.)
bool ascii_space(unsigned char c) {
    return c == 0x20 || (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x1f);
}

bool ascii_lower_alpha(unsigned char c) { return c >= 'a' && c <= 'z'; }

/// Python: `re.compile(r"^[a-z+]+://").sub("", s)`.
void strip_proto(std::string& s) {
    size_t i = 0;
    while (i < s.size() && (ascii_lower_alpha(static_cast<unsigned char>(s[i])) || s[i] == '+')) ++i;
    if (i == 0) return;
    if (s.compare(i, 3, "://") != 0) return;
    s.erase(0, i + 3);
}

/// Python: `re.compile(r"^[^/@]+@").sub("", s)`.
void strip_userinfo(std::string& s) {
    const auto at = s.find('@');
    if (at == std::string::npos || at == 0) return;
    if (s.find('/') < at) return;
    s.erase(0, at + 1);
}

/// Python: `re.compile(r"^[^/@]+@([^:]+):(.+)$").match(s)`, rewritten as
/// `group(1) + "/" + group(2)`. Hand-rolled rather than std::regex because
/// std::regex and Python's re disagree on what `.` and `$` mean around \r and
/// \n, and this function has to agree with Python byte for byte.
bool scp_rewrite(std::string& s) {
    const auto at = s.find('@');                       // ^[^/@]+
    if (at == std::string::npos || at == 0) return false;
    if (s.find('/') < at) return false;
    const auto colon = s.find(':', at + 1);            // ([^:]+):
    if (colon == std::string::npos || colon == at + 1) return false;
    if (colon + 1 >= s.size()) return false;           // (.+) is non-empty
    if (s.find('\n', colon + 1) != std::string::npos) return false;  // `.` is not \n
    s = s.substr(at + 1, colon - at - 1) + "/" + s.substr(colon + 1);
    return true;
}

}  // namespace

std::string normalize_remote(const std::string& url) {
    // ASCII-only by contract. C++ has no Unicode case mapping in the standard
    // library and this is not worth a new dependency, so room_key.py restricts
    // itself to ASCII too — see the note there. Both sides work on UTF-8, and no
    // byte of a multi-byte UTF-8 sequence is below 0x80, so doing this per byte
    // here and per code point in Python gives identical output.
    size_t b = 0;
    size_t e = url.size();
    while (b < e && ascii_space(static_cast<unsigned char>(url[b]))) ++b;
    while (e > b && ascii_space(static_cast<unsigned char>(url[e - 1]))) --e;
    std::string s = url.substr(b, e - b);

    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }

    if (!scp_rewrite(s)) {
        strip_proto(s);
        strip_userinfo(s);
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
