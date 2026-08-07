#pragma once
#include <cstddef>
#include <string>

namespace ap {

/// Build a minimal JSON event from a Claude Code hook payload.
/// Extracts only permitted fields; never copies file contents or prompts.
std::string build_event(const std::string& hook_json);

/// Connect to a unix socket and write one line. Returns false on any failure.
/// Never blocks longer than timeout_ms and never throws.
bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms);

/// Read the hook payload off `fd`, buffering at most `max_buffer` bytes and
/// giving up after `timeout_ms` no matter what the writer does.
///
/// Bytes past the cap are read and discarded rather than left in the pipe: the
/// fields we want sit in the first few hundred bytes, but exiting early would
/// hand the parent an EPIPE on a write it is still making, and a hook that can
/// error the process that spawned it is worse than a slow one. The deadline is
/// the backstop for the parent that never closes its end at all.
std::string read_bounded(int fd, std::size_t max_buffer, int timeout_ms);

}  // namespace ap
