#pragma once
#include <optional>
#include <string>

namespace ap {

/// Must stay byte-identical to the Python implementation in room_key.py.
/// A divergence here silently splits a team into two rooms.
std::string normalize_remote(const std::string& url);
std::string room_id_from_remote(const std::string& url);

std::optional<std::string> find_repo_root(const std::string& start_path);

}  // namespace ap
