#pragma once
#include <optional>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ap {

struct CachedLease {
    std::string agent;
    std::string human;
    std::string intent;
    long long expires_at_ms;
    /// The tier this lease was taken at, by name, exactly as the relay said it.
    /// Empty means the relay did not say — an older one, or a frame that lost
    /// the field — and empty is rendered as nothing rather than as "normal",
    /// because "normal" would be a fact about the room nobody told us.
    std::string priority;

    /// When this lease stops being renewable, on the daemon's monotonic clock.
    /// Negative means nobody has asked for the region, which is the common case:
    /// an uncontended lease renews forever.
    ///
    /// Carried for two readers. The agent blocked on the region needs it to be
    /// told *when*, not just no — "their claim expires within 90 seconds" was a
    /// sentence this hook printed for years and it was not true of any holder
    /// that was still working. And the holder itself needs it to find out its
    /// lease has a deadline while it still has the region and can act.
    long long handover_at_ms = -1;
    std::string handover_to;
    std::string handover_to_human;
    std::string handover_to_priority;
    /// How many agents are queued behind this lease. 0 when the relay said
    /// nothing.
    int waiting = 0;
};

/// A region this agent used to hold and no longer does, and who has it now.
///
/// Kept because losing a region is the one event an agent cannot make sense of
/// on its own. Its lease disappears; the next edit it tries is refused by
/// somebody else's; nothing anywhere says the two are the same event, that it
/// was given a deadline it did not meet, or what to do with the work it has
/// half-finished in that region.
struct HandoverNote {
    std::string to;
    std::string to_human;
    std::string to_priority;
    /// When the region changed hands, monotonic. Stale notes are dropped on
    /// read rather than swept, like everything else here.
    long long at_ms = 0;
};

/// How long a lost region stays worth mentioning. Long enough to cover the
/// agent noticing and coming back to the file, short enough that it is news
/// rather than history. Also the horizon `note_handover` prunes on, so the map
/// is bounded by the handovers of the last half hour rather than by uptime.
constexpr long long kHandoverNoteMs = 30 * 60 * 1000;

/// A read-only snapshot of relay-held leases, refreshed by push.
///
/// This class deliberately contains no protocol logic: no ladder, no
/// wound-wait, no arbitration. It answers exactly one question — "is there a
/// live lease on this region held by somebody else?" — so the C++ side can
/// never drift from the Python authority.
///
/// Safe to read from any thread. DecisionServer answers hooks off the event
/// loop so a flood of events cannot delay a decision, which means the loop's
/// relay frames and the decision threads' lookups land here at the same time.
/// Reads take a shared lock and replace() an exclusive one — the right way
/// round, since replace() happens per lease frame and reads happen per edit.
class LeaseCache {
public:
    void replace(std::vector<std::pair<std::string, CachedLease>> entries);

    std::optional<CachedLease> conflict_for(const std::string& region_key,
                                            const std::string& my_agent,
                                            long long now_ms) const;

    /// The same question asked about a whole file rather than one region.
    ///
    /// A hook request names a path and no symbol, and a whole-file region
    /// contends with every symbol inside that path — see same_region() in
    /// types.py, which is the authority both sides answer to. An exact lookup on
    /// `path + "|"` would miss a live claim on `path|sign_in` and allow an edit
    /// the relay considers a collision, so the whole-file question gets its own
    /// entry point rather than a caller that guesses at keys.
    ///
    /// Region keys are `path + "|" + symbol`, so this matches by that prefix.
    /// A path containing '|' can therefore collide with another path, exactly as
    /// it already can in region_key itself; both resolve toward reporting a
    /// conflict, and a spurious rung 3 is an explained prompt, not a silent loss.
    std::optional<CachedLease> conflict_for_file(const std::string& path,
                                                 const std::string& my_agent,
                                                 long long now_ms) const;

    /// This agent's *own* live lease on the file, when somebody is waiting on
    /// it. The mirror image of conflict_for_file: same prefix match, opposite
    /// agent test, and only ever answers when there is a deadline to report.
    ///
    /// This is how a holder finds out it is on the clock. There is no push
    /// channel to an agent — hooks are the only way in, and they only fire when
    /// the agent does something — so the warning is delivered on its next edit,
    /// which is exactly when it is holding the region and can still act on it.
    std::optional<CachedLease> own_handover(const std::string& path,
                                            const std::string& my_agent,
                                            long long now_ms) const;

    /// Remember that this agent's region went to somebody else.
    void note_handover(const std::string& path, HandoverNote note);

    /// A handover of this file recorded within `within_ms`, if any.
    std::optional<HandoverNote> handover_note(const std::string& path, long long now_ms,
                                              long long within_ms) const;

private:
    mutable std::shared_mutex mu_;
    std::unordered_map<std::string, CachedLease> by_region_;
    /// Keyed on path, not region: an agent that loses `pay.py:charge` wants to
    /// be told when it edits `pay.py`, whichever symbol the hook names — and a
    /// hook request carries no symbol at all.
    std::unordered_map<std::string, HandoverNote> lost_;
};

}  // namespace ap
