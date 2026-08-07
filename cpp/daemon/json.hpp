#pragma once
#include <string>
#include <string_view>

namespace ap {

/// The daemon's scalar extractor: the value of a top-level string field, with
/// JSON escapes decoded. Empty for a missing key or an unterminated value.
///
/// Same shape as the hook's, escapes included. Scanning for the next bare '"'
/// is what this used to do, and it quietly truncated every path with a quote in
/// it: the hook wrote valid JSON, the daemon read half of it, and the event went
/// nowhere with nothing logged. Decoding here is what makes the path on this
/// side byte-identical to the path the hook was handed.
///
/// It lives in the library rather than in daemon/main.cpp because the responder
/// reads the same request line the event path does, and two extractors over one
/// wire format is how the two halves drift apart.
std::string json_field(std::string_view json, std::string_view key);

/// Append `v` as the body of a JSON string. Without this a path or an intent
/// holding a quote produces a malformed response line, which the hook parses as
/// "no answer" and silently allows.
void append_json_string(std::string& out, std::string_view v);

}  // namespace ap
