#pragma once

// Every test that needs a real path on disk — a unix socket, a journal file, a
// snapshot — used a name fixed at compile time under the system temp dir. That
// is fine for one process. It is not fine for two: this repo lives as several
// worktrees on the same machine, and nothing stops two of them from building
// and running `ap_tests` at once. Two processes racing to bind the same
// "/tmp/ap_dec_block.sock" do not fail cleanly — one wins the bind and the
// other's client traffic lands on a daemon from an unrelated run, which reads
// as a correctness failure with no useful message.
//
// The fix is the same one `getpid()`-tagged log files have used forever:
// make the shared directory not actually shared. Every path this suite touches
// on disk should run through here.

#include <sys/types.h>
#include <unistd.h>

#include <filesystem>
#include <string>

namespace apt {

/// `leaf`, unique to this process. Two `ap_tests` binaries running at once —
/// different worktrees, a stray process from a prior run — get different
/// paths and cannot collide.
inline std::string unique_leaf(const std::string& leaf) {
    return leaf + "." + std::to_string(static_cast<long long>(::getpid()));
}

/// The usual case: a file or socket directly under the system temp dir.
inline std::string unique_temp_path(const std::string& leaf) {
    return (std::filesystem::temp_directory_path() / unique_leaf(leaf)).string();
}

}  // namespace apt
