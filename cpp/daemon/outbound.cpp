#include "daemon/outbound.hpp"

#include <string_view>
#include <utility>

namespace ap {
namespace {

/// The JSON-escaped body of the string at `key`, still escaped. Stops at the
/// first *unescaped* quote, so a value holding \" is not truncated.
std::string raw_field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":\"";
    const auto pos = json.find(needle);
    if (pos == std::string_view::npos) return {};
    const auto start = pos + needle.size();

    for (size_t i = start; i < json.size(); ++i) {
        if (json[i] == '\\') {
            ++i;  // skip whatever it escapes, including a quote
            continue;
        }
        if (json[i] == '"') return std::string(json.substr(start, i - start));
    }
    return {};  // unterminated string: no value worth forwarding
}

void emit(std::string& out, const char* key, const std::string& escaped_value) {
    if (!out.empty() && out.back() != '{') out += ',';
    out += '"';
    out += key;
    out += "\":\"";
    out += escaped_value;
    out += '"';
}

}  // namespace

std::string redact_line(const std::string& line) {
    std::string out = "{";
    emit(out, "verb", raw_field(line, "verb"));
    emit(out, "agent", raw_field(line, "agent"));
    emit(out, "human", raw_field(line, "human"));
    emit(out, "path", raw_field(line, "path"));
    out += '}';
    return out;
}

Outbound::Outbound(std::size_t capacity) : capacity_(capacity) {}

void Outbound::push(std::string msg) {
    if (capacity_ == 0) {
        ++dropped_;
        return;
    }
    if (q_.size() >= capacity_) {
        q_.pop_front();
        ++dropped_;
    }
    q_.push_back(std::move(msg));
}

std::vector<std::string> Outbound::drain() {
    std::vector<std::string> out(q_.begin(), q_.end());
    q_.clear();
    return out;
}

}  // namespace ap
