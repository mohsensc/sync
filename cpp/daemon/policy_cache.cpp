#include "daemon/policy_cache.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>

namespace ap {
namespace {

constexpr const char* kNames[kRungs] = {"silent", "notify", "context", "ask", "deny"};

bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::size_t skip_space(std::string_view s, std::size_t i) {
    while (i < s.size() && is_space(s[i])) ++i;
    return i;
}

/// Read one JSON string starting at the opening quote. Effect names have no
/// escapes in them, and a name that needs one is not an effect name, so a
/// backslash here is treated as an ordinary byte and the lookup simply fails.
bool read_string(std::string_view s, std::size_t& i, std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    ++i;
    const std::size_t start = i;
    while (i < s.size() && s[i] != '"') ++i;
    if (i >= s.size()) return false;
    out.assign(s.substr(start, i - start));
    ++i;
    return true;
}

/// The whole file, or empty. Bounded, non-blocking on a regular file, and it
/// never leaves a descriptor behind on an error path.
bool read_all(const std::string& path, std::size_t cap, std::string& out) {
    const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    out.clear();
    char buf[4096];
    for (;;) {
        const ssize_t n = ::read(fd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            ::close(fd);
            return false;
        }
        if (n == 0) break;
        if (out.size() + static_cast<std::size_t>(n) > cap) {
            ::close(fd);
            return false;
        }
        out.append(buf, static_cast<std::size_t>(n));
    }
    ::close(fd);
    return true;
}

}  // namespace

const char* effect_name(Effect e) {
    const int i = static_cast<int>(e);
    if (i < 0 || i >= kRungs) return kNames[0];
    return kNames[i];
}

std::optional<Effect> parse_effect(std::string_view s) {
    for (int i = 0; i < kRungs; ++i) {
        if (s == kNames[i]) return static_cast<Effect>(i);
    }
    return std::nullopt;
}

bool parse_effect_list(std::string_view array, PolicyTable& out, std::string* problem) {
    std::size_t i = skip_space(array, 0);
    if (i >= array.size() || array[i] != '[') return false;
    ++i;

    PolicyTable next = out;
    std::string name;
    std::string unknown;
    for (int rung = 0; rung < kRungs; ++rung) {
        i = skip_space(array, i);
        if (!read_string(array, i, name)) return false;
        if (const auto e = parse_effect(name)) {
            next.rung[rung] = *e;
        } else {
            // One unrecognised word leaves that rung where it was rather than
            // dropping the whole table. A cache written by a newer `ap` with a
            // sixth effect in it must not turn this daemon off.
            if (!unknown.empty()) unknown += ", ";
            unknown += "rung" + std::to_string(rung) + "=" + name;
        }
        i = skip_space(array, i);
        if (rung < kRungs - 1) {
            if (i >= array.size() || array[i] != ',') return false;
            ++i;
        }
    }
    i = skip_space(array, i);
    if (i >= array.size() || array[i] != ']') return false;

    out = next;
    if (!unknown.empty() && problem != nullptr) {
        if (!problem->empty()) *problem += "; ";
        *problem += "unknown effect names kept at their previous value (" + unknown + ")";
    }
    return true;
}

bool parse_effect_array(std::string_view json, std::string_view key, PolicyTable& out,
                        std::string* problem) {
    std::string needle = "\"";
    needle.append(key);
    needle += "\":";
    const auto pos = json.find(needle);
    if (pos == std::string_view::npos) return false;
    return parse_effect_list(json.substr(pos + needle.size()), out, problem);
}

void PolicyCache::note(const std::string& problem) {
    std::unique_lock lock(mu_);
    problem_ = problem;
}

bool PolicyCache::refresh(const std::string& path, long long now_ms) {
    if (path.empty()) return false;
    std::lock_guard<std::mutex> io(io_mu_);

    if (checked_ms_ != kNever && now_ms - checked_ms_ < kRecheckMs) return false;
    checked_ms_ = now_ms;

    struct ::stat st {};
    if (::stat(path.c_str(), &st) != 0) {
        if (!loaded_) return false;  // never had one; kBuiltin is the default, not a fault
        // It was there and now it is not. Keep the table: an agent losing
        // protection because a tmpfs got cleaned is exactly the silent failure
        // this whole design exists to prevent. Say so instead.
        loaded_ = false;
        mtime_ns_ = kNever;
        size_ = kNever;
        {
            std::unique_lock lock(mu_);
            problem_ = "policy cache " + path + " disappeared; keeping the last table";
        }
        return false;
    }

#if defined(__APPLE__)
    const long long mtime = static_cast<long long>(st.st_mtimespec.tv_sec) * 1000000000LL +
                            st.st_mtimespec.tv_nsec;
#else
    const long long mtime =
        static_cast<long long>(st.st_mtim.tv_sec) * 1000000000LL + st.st_mtim.tv_nsec;
#endif
    const long long size = static_cast<long long>(st.st_size);
    if (loaded_ && mtime == mtime_ns_ && size == size_) return false;

    std::string text;
    if (!read_all(path, kMaxBytes, text)) {
        mtime_ns_ = kNever;  // try again next tick rather than latching the failure
        size_ = kNever;
        note("policy cache " + path + " could not be read; keeping the last table");
        return false;
    }

    mtime_ns_ = mtime;
    size_ = size;

    PolicyTable next;
    {
        std::shared_lock lock(mu_);
        next = local_;
    }

    std::string problem;
    const bool ok = parse_effect_array(text, "table", next, &problem);

    std::unique_lock lock(mu_);
    ++parses_;
    if (!ok) {
        // Truncated, empty, or not the file we thought. The previous table
        // stays in force and the daemon says it is degraded. There is no path
        // from here to a quieter product: effect_for() still floors everything
        // at kBuiltinFloor.
        problem_ = "policy cache " + path + " has no usable table; keeping the last one";
        return false;
    }

    const bool moved = next.rung != local_.rung;
    local_ = next;
    source_ = path;
    loaded_ = true;
    problem_ = problem;
    return moved;
}

void PolicyCache::set_floor(const PolicyTable& floor, std::string source) {
    std::unique_lock lock(mu_);
    for (int i = 0; i < kRungs; ++i) {
        floor_.rung[i] = louder(floor.rung[i], kBuiltinFloor.rung[i]);
    }
    floor_source_ = std::move(source);
}

Effect PolicyCache::effect_for(int rung) const {
    if (rung < 0 || rung >= kRungs) return Effect::Silent;
    std::shared_lock lock(mu_);
    return louder(local_.rung[rung], floor_.rung[rung]);
}

PolicyCache::Origin PolicyCache::explain(int rung) const {
    Origin out;
    if (rung < 0 || rung >= kRungs) return out;
    std::shared_lock lock(mu_);
    const Effect local = local_.rung[rung];
    const Effect floor = floor_.rung[rung];
    out.effect = louder(local, floor);
    out.from_floor = floor > local;
    out.source = out.from_floor ? floor_source_ : source_;
    return out;
}

PolicyTable PolicyCache::table() const {
    std::shared_lock lock(mu_);
    return local_;
}

PolicyTable PolicyCache::floor() const {
    std::shared_lock lock(mu_);
    return floor_;
}

bool PolicyCache::degraded() const {
    std::shared_lock lock(mu_);
    return !problem_.empty();
}

std::string PolicyCache::problem() const {
    std::shared_lock lock(mu_);
    return problem_;
}

std::string PolicyCache::source() const {
    std::shared_lock lock(mu_);
    return source_;
}

std::string PolicyCache::floor_source() const {
    std::shared_lock lock(mu_);
    return floor_source_;
}

std::size_t PolicyCache::parses() const {
    std::shared_lock lock(mu_);
    return parses_;
}

}  // namespace ap
