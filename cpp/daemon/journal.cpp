#include "daemon/journal.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <shared_mutex>
#include <string>
#include <vector>

#include "daemon/json.hpp"

namespace ap {
namespace {

void append_field(std::string& out, const char* key, const std::string& value) {
    out += ",\"";
    out += key;
    out += "\":\"";
    append_json_string(out, value);
    out += '"';
}

/// The rung out of a response line. Negative when there is not one, which is
/// what an unanswered request looks like.
int rung_of(const std::string& response) {
    const std::string needle = "\"rung\":";
    const auto pos = response.find(needle);
    if (pos == std::string::npos) return -1;
    const char* start = response.c_str() + pos + needle.size();
    char* end = nullptr;
    const long value = std::strtol(start, &end, 10);
    if (end == start) return -1;
    return static_cast<int>(value);
}

/// Copy whatever landed in `src` at or after `from` onto the end of `dst`,
/// count the lines, and move `from` on to where it stopped.
///
/// The bytes a trim could not have seen, in other words: it read the file up to
/// `from` with nothing locked, so anything past that offset arrived while it
/// was rewriting and would otherwise be dropped by the rename.
///
/// Called twice. Once unlocked, which carries the bulk of whatever a busy
/// machine wrote during the rewrite, and once under the exclusive lock, which
/// carries only what arrived during that first pass. The second call is what
/// makes the rename safe and it is the one that has to be small.
bool splice_tail(const std::string& src, long long& from, const std::string& dst,
                 std::size_t& lines_out) {
    std::ifstream in(src, std::ios::binary);
    if (!in) return true;  // gone from under us; nothing to carry over
    in.seekg(static_cast<std::streamoff>(from));
    if (!in) return true;

    std::string line;
    if (!std::getline(in, line)) return true;  // nothing appended: the common case

    std::ofstream out(dst, std::ios::app | std::ios::binary);
    if (!out) return false;
    do {
        from += static_cast<long long>(line.size()) + 1;
        if (line.empty()) continue;
        out << line << '\n';
        ++lines_out;
    } while (std::getline(in, line));
    out.flush();
    return static_cast<bool>(out);
}

/// Why this decision came out the way it did, in one sentence a human reads.
///
/// Two things and no more: which side of the policy decided, and — when there
/// is one worth naming — the tier the holder took the region at. Between them
/// they answer both halves of "why was I stopped": what rule stopped me, and
/// why is the other agent the one who gets to keep going.
std::string reason_for(int rung, const std::string& response, const PolicyCache& policy) {
    const PolicyCache::Origin origin = policy.explain(rung);

    std::string out = "effect ";
    out += effect_name(origin.effect);
    out += " from ";
    if (origin.from_floor) {
        out += "the org floor";
        if (!origin.source.empty()) {
            out += " (";
            out += origin.source;
            out += ")";
        }
    } else if (origin.source.empty()) {
        out += "the builtin table";
    } else {
        out += origin.source;
    }

    // `normal` is the default every unrostered room runs at, so saying it would
    // be spending a line to report that nothing unusual happened.
    const std::string tier = json_field(response, "holder_priority");
    if (!tier.empty() && tier != "normal") {
        out += "; the holder took it at ";
        out += tier;
    }
    return out;
}

}  // namespace

std::string journal_line(long long at_ms, const std::string& request,
                         const std::string& response, const PolicyCache& policy) {
    const int rung = rung_of(response);
    // Rung 0 is every clean edit, and a negative rung is a line the daemon
    // never answered. Neither is a decision anybody asks why about.
    if (rung <= 0) return {};

    std::string out = "{\"at_ms\":";
    out += std::to_string(at_ms);
    out += ",\"rung\":";
    out += std::to_string(rung);

    append_field(out, "effect", json_field(response, "effect"));
    append_field(out, "path", json_field(request, "path"));
    append_field(out, "agent", json_field(request, "agent"));
    append_field(out, "holder", json_field(response, "holder"));
    append_field(out, "human", json_field(response, "human"));
    append_field(out, "intent", json_field(response, "intent"));
    append_field(out, "reason", reason_for(rung, response, policy));
    out += '}';
    return out;
}

DecisionJournal::DecisionJournal(std::string path) : path_(std::move(path)) {}

DecisionJournal::~DecisionJournal() {
    if (fd_ >= 0) ::close(fd_);
}

bool DecisionJournal::open_locked() {
    // Caller holds the exclusive lock. Another thread may have opened it while
    // this one was waiting for that lock, which is why this re-checks.
    //
    // O_APPEND is what makes a whole-line write atomic between threads, and it
    // is also what makes it safe to hold this open: every write goes to the
    // current end of file, whatever anybody else did to it.
    if (fd_ < 0) {
        fd_ = ::open(path_.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    }
    return fd_ >= 0;
}

void DecisionJournal::record(long long at_ms, const std::string& request,
                             const std::string& response, const PolicyCache& policy) {
    const std::string line = journal_line(at_ms, request, response, policy);
    if (line.empty() || path_.empty()) return;

    const std::string framed = line + "\n";

    // Twice at most: write on the open fd, and if there isn't one, open it and
    // come back round. The two locks are never nested — std::shared_mutex is
    // not recursive, and taking the exclusive one while holding the shared one
    // is a deadlock, not a slow path.
    for (int attempt = 0; attempt < 2; ++attempt) {
        {
            std::shared_lock lock(mu_);
            if (fd_ >= 0) {
                // One syscall, under a shared lock, so eight decision threads
                // write at the same time rather than queueing. O_APPEND means a
                // whole line lands or none of it does. A short write is still
                // possible on a full disk; a torn last line is exactly what
                // journal.py skips.
                if (::write(fd_, framed.data(), framed.size()) > 0) {
                    lines_.fetch_add(1, std::memory_order_relaxed);
                    written_.fetch_add(1, std::memory_order_relaxed);
                }
                return;
            }
        }
        std::unique_lock lock(mu_);
        // Fail open: no journal is not a reason to stall a hook.
        if (!open_locked()) return;
    }
}

bool DecisionJournal::give_up() {
    // Not `lines_ = 0`: the count is the only thing that will ever bring us
    // back here, so it has to keep counting. Move the bar instead.
    gate_.store(lines_.load(std::memory_order_relaxed) + kJournalTrimRetryLines,
                std::memory_order_relaxed);
    return false;
}

bool DecisionJournal::maybe_trim() {
    if (path_.empty()) return false;
    if (lines_.load(std::memory_order_relaxed) <= gate_.load(std::memory_order_relaxed)) {
        // Nothing to cut. Still worth noticing that the file we hold open has
        // been deleted under us — a tmp sweep would otherwise leave every later
        // record going into an unlinked inode, and `ap why` reading an empty
        // directory, with nothing anywhere saying so.
        if (written_.load(std::memory_order_relaxed) > 0) {
            std::error_code ec;
            if (!std::filesystem::exists(path_, ec)) {
                std::unique_lock lock(mu_);
                if (fd_ >= 0) {
                    ::close(fd_);
                    fd_ = -1;  // the next record opens a fresh one
                }
                lines_.store(0, std::memory_order_relaxed);
                gate_.store(kJournalMaxLines, std::memory_order_relaxed);
            }
        }
        return false;
    }

    // One trim at a time. `try_to_lock` and not a wait: this runs on the tick,
    // and a tick that blocks is a tick not on the socket. `record` never takes
    // this mutex, so nothing a decision does can queue behind it.
    std::unique_lock<std::mutex> trim(trim_mu_, std::try_to_lock);
    if (!trim.owns_lock()) return false;
    if (lines_.load(std::memory_order_relaxed) <= gate_.load(std::memory_order_relaxed)) {
        return false;
    }

    // ---- everything from here to the rename runs with `mu_` untaken --------
    // Writers keep writing to the file we are reading. That is fine, and it is
    // the point: the journal is append-only, so every byte below the offset we
    // stop at is stable, and the bytes above it are carried over by splice_tail
    // under the lock at the end.
    scans_.fetch_add(1, std::memory_order_relaxed);

    std::error_code ec;
    const auto size_now = std::filesystem::file_size(path_, ec);
    if (ec) {
        // Somebody took the file away. Nothing to trim, and the count has to
        // come back down or every tick from here on tries again.
        lines_.store(0, std::memory_order_relaxed);
        gate_.store(kJournalMaxLines, std::memory_order_relaxed);
        return false;
    }
    const auto before = static_cast<long long>(size_now);

    std::vector<std::string> kept;
    long long consumed = 0;
    {
        std::ifstream in(path_, std::ios::binary);
        if (!in) {
            lines_.store(0, std::memory_order_relaxed);
            gate_.store(kJournalMaxLines, std::memory_order_relaxed);
            return false;
        }
        std::string line;
        while (consumed < before && std::getline(in, line)) {
            // Counted, not `tellg`ed: libc++ implements tellg as a real seek
            // that throws the read buffer away, which would turn one pass over
            // the file into one syscall per line.
            //
            // `+ 1` for the newline getline ate. A torn last line has none, so
            // this ends up one past the end — which is exactly what we want:
            // splice_tail then finds nothing to carry over, rather than
            // re-emitting the fragment the rewrite has already repaired.
            consumed += static_cast<long long>(line.size()) + 1;
            if (line.empty()) continue;
            kept.push_back(std::move(line));
            line.clear();
            if (kept.size() > kJournalKeepLines * 2) {
                // Keep the tail without holding the whole file: erase from the
                // front in blocks rather than per line, which would be a copy
                // of the vector for every record over the cap.
                kept.erase(kept.begin(), kept.begin() + kJournalKeepLines);
            }
        }
    }
    if (kept.size() > kJournalKeepLines) {
        kept.erase(kept.begin(), kept.end() - kJournalKeepLines);
    }

    // Temp file then rename, like the snapshot: `ap why` may be reading this
    // and must never see a half-written journal.
    const std::string tmp = path_ + ".tmp";
    {
        std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
        if (!out) return give_up();
        for (const auto& line : kept) out << line << '\n';
        out.flush();
        if (!out) {
            std::remove(tmp.c_str());
            return give_up();
        }
    }

    // Records written while we were rewriting. Copied here, with nothing
    // locked, so that the pass that has to happen under the lock is left with
    // only what arrives during this one.
    std::size_t tail = 0;
    if (!splice_tail(path_, consumed, tmp, tail)) {
        std::remove(tmp.c_str());
        return give_up();
    }

    // ---- and only now, for one short read and two syscalls -----------------
    // A writer holds `mu_` for exactly one `write`, so this is the whole of
    // what a decision can ever wait on for a trim.
    std::size_t total = kept.size();
    {
        std::unique_lock lock(mu_);
        if (!splice_tail(path_, consumed, tmp, tail)) {
            std::remove(tmp.c_str());
            return give_up();
        }
        if (std::rename(tmp.c_str(), path_.c_str()) != 0) {
            std::remove(tmp.c_str());
            return give_up();
        }
        total += tail;

        // The rename put a new inode at this path. The fd we hold still points
        // at the old one, so every record from here would go into a file
        // nothing can open — the trim would look like it worked and the journal
        // would stop growing. Drop it; the next record opens the file that is
        // actually there.
        if (fd_ >= 0) {
            ::close(fd_);
            fd_ = -1;
        }
    }

    lines_.store(total, std::memory_order_relaxed);
    gate_.store(kJournalMaxLines, std::memory_order_relaxed);
    return true;
}

}  // namespace ap
