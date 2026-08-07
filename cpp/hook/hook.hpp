#pragma once
#include <string>

namespace ap {

/// Build a minimal JSON event from a Claude Code hook payload.
/// Extracts only permitted fields; never copies file contents or prompts.
std::string build_event(const std::string& hook_json);

/// Connect to a unix socket and write one line. Returns false on any failure.
/// Never blocks longer than timeout_ms and never throws.
bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms);

}  // namespace ap
