#pragma once
#include <atomic>
#include <cstddef>
#include <shared_mutex>
#include <string>

#include "daemon/policy_cache.hpp"

namespace ap {

// ===========================================================================
// The decision journal — the writer behind `ap why`
// ===========================================================================
//
// python/src/agent_presence/journal.py is the reader, and its first line says
// "the daemon writes it". This is that. One JSON object per line, oldest first,
// in `$XDG_RUNTIME_DIR/agent-presence.decisions.jsonl`.
//
// Only decisions an agent was actually told about are recorded. Every clean
// edit is a rung 0 and there are thousands of them; writing those would bury
// the handful of lines somebody opens `ap why` to read, and would turn a
// bounded file into a two-minute window.
//
// Cost, because this sits in the hook's budget: one formatted string and one
// `write` on an fd that is already open. `O_APPEND` makes a write of a whole
// line atomic against the other decision threads, which is what lets those
// threads write *concurrently* — they take a shared lock, and the only thing
// that ever takes it exclusively is the trim.
//
// That is not a micro-optimisation. Decisions are answered on DecisionServer's
// thread pool, so a plain mutex here serialises eight threads across an open,
// a write and a close; measured on tests/load/run.py hook-latency, that took
// the loaded p99 from 0.9ms to 2.2ms. One shared lock and one syscall puts it
// back.
//
// The trim is the only expensive thing here and it does not happen on this
// path — `maybe_trim` runs on the daemon's 100ms tick.
//
// Every failure is silent and open. A read-only runtime directory costs the
// machine `ap why` and costs it nothing else; a daemon that refused to answer
// a hook because it could not write a log would be strictly worse than one
// that never logged.

/// Records past this many trigger a trim on the next tick.
inline constexpr std::size_t kJournalMaxLines = 2000;
/// How many survive it. Trimming to the cap would mean a rewrite per record
/// from then on; halving it buys a thousand records of quiet.
inline constexpr std::size_t kJournalKeepLines = 1000;

class DecisionJournal {
public:
    /// Nothing is opened here and nothing is created. The file appears with the
    /// first record worth writing, so a machine that has never been stopped
    /// does not grow a file to say so.
    explicit DecisionJournal(std::string path);

    DecisionJournal(const DecisionJournal&) = delete;
    DecisionJournal& operator=(const DecisionJournal&) = delete;

    /// Record one answered decision.
    ///
    /// `request` and `response` are the two lines of the hook protocol exactly
    /// as they went over the socket — the journal is a record of what was said,
    /// so it is written from what was said rather than from a parallel set of
    /// variables that can drift from it.
    ///
    /// `at_ms` is wall clock milliseconds, not the daemon's monotonic clock:
    /// `ap why` prints a time of day, and the daemon's clock has no relation to
    /// one. An unanswered line, or a rung nobody was told about, writes nothing.
    ///
    /// Thread-safe. Never throws.
    void record(long long at_ms, const std::string& request, const std::string& response,
                const PolicyCache& policy);

    /// Cut the file back to `kJournalKeepLines` if it has grown past the cap,
    /// and notice a file that has been deleted out from under the open fd.
    /// Returns whether it trimmed.
    ///
    /// Called from the daemon's tick and never from `record`, so no hook ever
    /// waits on a file rewrite. Nearly free when there is nothing to do: an
    /// atomic read, and one stat once the journal has anything in it.
    bool maybe_trim();

    /// How many records this process has written. The daemon logs nothing, so
    /// this is the only way to tell a working journal from a decorative one.
    std::size_t written() const { return written_.load(std::memory_order_relaxed); }

    ~DecisionJournal();

private:
    /// Open the append fd. The caller holds `mu_` exclusively; returns whether
    /// there is a usable fd afterwards.
    bool open_locked();

    std::string path_;
    /// Shared by every writer, exclusive only for the trim and for opening.
    mutable std::shared_mutex mu_;
    int fd_ = -1;
    std::atomic<std::size_t> lines_{0};    // as far as this process knows
    std::atomic<std::size_t> written_{0};
};

/// The one line `record` would write, or empty when there is nothing to record.
/// Split out because a format two halves of a system have to agree on deserves
/// to be testable without a filesystem.
std::string journal_line(long long at_ms, const std::string& request,
                         const std::string& response, const PolicyCache& policy);

}  // namespace ap
