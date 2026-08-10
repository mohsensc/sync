// The writer behind `ap why`.
//
// python/src/agent_presence/journal.py is the reader and it says, in its first
// line, "the daemon writes it". Nothing did. `ap why` shipped answering "no
// decisions recorded yet" on a machine that had just blocked an edit, which is
// the worst possible answer: a block you cannot get a reason for is a block you
// stop trusting.
//
// The format is that reader's, exactly: one JSON object per line, oldest first,
// `at_ms` in wall clock milliseconds, capped so it cannot grow without bound.

#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "daemon/decide.hpp"
#include "daemon/journal.hpp"
#include "daemon/json.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/policy_cache.hpp"

namespace {

std::string scratch(const std::string& leaf) {
    const auto dir = std::filesystem::temp_directory_path() / ("ap-journal-" + leaf);
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    std::filesystem::create_directories(dir);
    return (dir / "agent-presence.decisions.jsonl").string();
}

std::vector<std::string> lines_of(const std::string& path) {
    std::vector<std::string> out;
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty()) out.push_back(line);
    }
    return out;
}

const std::string kRequest =
    R"({"verb":"edit","agent":"sess_b","path":"/repo/src/auth.py","want":"decision"})";

/// LeaseCache owns a mutex, so it cannot be returned by value. A prvalue of
/// this is constructed at the call site and converts to the reference
/// decide_response asks for — the same wrapper tests/test_decide.cpp uses.
struct Held {
    ap::LeaseCache cache;

    explicit Held(const std::string& tier) {
        cache.replace({{"/repo/src/auth.py|",
                        ap::CachedLease{"sess_a", "sara", "rotating the signing key",
                                        60'000, tier}}});
    }

    operator const ap::LeaseCache&() const { return cache; }  // NOLINT(google-explicit-constructor)
};

Held held_at(const std::string& tier) { return Held(tier); }

}  // namespace

TEST_CASE("a rung 3 decision lands in the journal in the reader's shape") {
    const std::string path = scratch("shape");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    const std::string reply = ap::decide_response(kRequest, leases, policy, 0);

    ap::DecisionJournal journal(path);
    journal.record(1'786'000'000'000, kRequest, reply, policy);

    const auto lines = lines_of(path);
    REQUIRE(lines.size() == 1);
    const std::string& line = lines[0];

    // Every field journal.py reads, read back with the daemon's own extractor.
    REQUIRE(ap::json_field(line, "path") == "/repo/src/auth.py");
    REQUIRE(ap::json_field(line, "agent") == "sess_b");
    REQUIRE(ap::json_field(line, "holder") == "sess_a");
    REQUIRE(ap::json_field(line, "human") == "sara");
    REQUIRE(ap::json_field(line, "intent") == "rotating the signing key");
    REQUIRE(ap::json_field(line, "effect") == "deny");
    REQUIRE_FALSE(ap::json_field(line, "reason").empty());
    // rung and at_ms are numbers, so they are checked as substrings of the one
    // line rather than through the string extractor.
    REQUIRE(line.find(R"("rung":3)") != std::string::npos);
    REQUIRE(line.find(R"("at_ms":1786000000000)") != std::string::npos);
}

TEST_CASE("the reason says which way the effect was decided") {
    const std::string path = scratch("reason");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");

    ap::DecisionJournal journal(path);
    journal.record(1, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);

    const std::string reason = ap::json_field(lines_of(path)[0], "reason");
    // With nothing configured the shipped table is what denied it, and saying
    // so is the difference between "policy blocked you" and "policy blocked you
    // and here is the file to argue with".
    REQUIRE(reason.find("deny") != std::string::npos);
    REQUIRE(reason.find("builtin") != std::string::npos);
}

TEST_CASE("an org floor that raised the effect is named as the thing that raised it") {
    const std::string path = scratch("floor");

    // A local table this machine compiled that only wanted to be told, and an
    // org floor that insists on a block. The floor is what the agent ran into,
    // so the floor is what the reason has to name — otherwise `ap why` sends
    // somebody to edit a file that is not the one deciding.
    const std::string cache = std::filesystem::path(path).parent_path() / "policy.json";
    std::ofstream(cache) << R"({"schema":1,"digest":"d","table":)"
                            R"(["silent","notify","context","notify","silent"]})";

    ap::PolicyCache policy;
    REQUIRE(policy.refresh(cache, 1'000));
    ap::PolicyTable loud{{ap::Effect::Silent, ap::Effect::Silent, ap::Effect::Silent,
                          ap::Effect::Deny, ap::Effect::Silent}};
    policy.set_floor(loud, "org:/etc/agent-presence/policy.toml");

    ap::DecisionJournal journal(path);
    const auto leases = held_at("normal");
    journal.record(1, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);

    const std::string reason = ap::json_field(lines_of(path)[0], "reason");
    REQUIRE(reason.find("floor") != std::string::npos);
    REQUIRE(reason.find("/etc/agent-presence/policy.toml") != std::string::npos);
}

TEST_CASE("the holder's tier is in the reason when there is one worth naming") {
    const std::string path = scratch("tier");
    ap::PolicyCache policy;
    ap::DecisionJournal journal(path);
    const auto leases = held_at("elevated");
    journal.record(1, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);

    REQUIRE(ap::json_field(lines_of(path)[0], "reason").find("elevated") !=
            std::string::npos);
}

TEST_CASE("rung 0 is not a decision anybody asks why about") {
    // Every clean edit is a rung 0. Recording them would bury the handful of
    // lines somebody actually opens `ap why` to read, and would turn a journal
    // capped at 2000 lines into a two-minute window.
    const std::string path = scratch("rung0");
    ap::PolicyCache policy;
    ap::LeaseCache empty;

    ap::DecisionJournal journal(path);
    journal.record(1, kRequest, ap::decide_response(kRequest, empty, policy, 0), policy);

    REQUIRE(lines_of(path).empty());
}

TEST_CASE("a line the daemon never answered is never journalled") {
    const std::string path = scratch("noanswer");
    ap::PolicyCache policy;
    ap::DecisionJournal journal(path);
    journal.record(1, R"({"verb":"edit","agent":"a","path":"/x.py"})", "", policy);
    REQUIRE(lines_of(path).empty());
}

TEST_CASE("records accumulate oldest first") {
    const std::string path = scratch("order");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal(path);

    for (long long i = 1; i <= 3; ++i) {
        journal.record(i, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);
    }

    const auto lines = lines_of(path);
    REQUIRE(lines.size() == 3);
    REQUIRE(lines[0].find(R"("at_ms":1)") != std::string::npos);
    REQUIRE(lines[2].find(R"("at_ms":3)") != std::string::npos);
}

TEST_CASE("an intent full of quotes and newlines stays one line") {
    // The intent is whatever a teammate's agent typed. One unescaped newline in
    // it and every line after it in the file reads as a torn record.
    const std::string path = scratch("hostile");
    ap::PolicyCache policy;
    ap::LeaseCache cache;
    cache.replace({{"/repo/src/auth.py|",
                    ap::CachedLease{"sess_a", "sa\"ra", "line one\nline \"two\"\\",
                                    60'000, "normal"}}});

    ap::DecisionJournal journal(path);
    journal.record(1, kRequest, ap::decide_response(kRequest, cache, policy, 0), policy);

    const auto lines = lines_of(path);
    REQUIRE(lines.size() == 1);
    REQUIRE(ap::json_field(lines[0], "intent") == "line one\nline \"two\"\\");
    REQUIRE(ap::json_field(lines[0], "human") == "sa\"ra");
}

TEST_CASE("the journal is capped, and the newest records are the ones kept") {
    const std::string path = scratch("cap");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal(path);

    for (long long i = 1; i <= ap::kJournalMaxLines + 50; ++i) {
        journal.record(i, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);
    }
    // Appends never trim: the trim runs on the daemon's tick so a decision
    // never pays for one.
    REQUIRE(lines_of(path).size() == ap::kJournalMaxLines + 50);

    REQUIRE(journal.maybe_trim());
    const auto lines = lines_of(path);
    REQUIRE(lines.size() == ap::kJournalKeepLines);
    // The newest survived and the oldest went.
    REQUIRE(lines.back().find(R"("at_ms":)" +
                              std::to_string(ap::kJournalMaxLines + 50)) !=
            std::string::npos);
    REQUIRE(lines.front().find(R"("at_ms":1,)") == std::string::npos);

    // ...and it is a no-op until the file grows again.
    REQUIRE_FALSE(journal.maybe_trim());
}

TEST_CASE("appending still works after a trim") {
    const std::string path = scratch("aftertrim");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal(path);

    for (long long i = 1; i <= ap::kJournalMaxLines + 1; ++i) {
        journal.record(i, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);
    }
    REQUIRE(journal.maybe_trim());
    journal.record(999'999, kRequest, ap::decide_response(kRequest, leases, policy, 0),
                   policy);

    const auto lines = lines_of(path);
    REQUIRE(lines.size() == ap::kJournalKeepLines + 1);
    REQUIRE(lines.back().find(R"("at_ms":999999)") != std::string::npos);
}

TEST_CASE("a journal that cannot be written is not a fault the daemon dies of") {
    // Every failure here is fail-open: a read-only runtime directory costs the
    // machine `ap why` and costs it nothing else.
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal("/proc/definitely/not/writable/x.jsonl");
    REQUIRE_NOTHROW(
        journal.record(1, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy));
    REQUIRE_NOTHROW(journal.maybe_trim());
}

TEST_CASE("concurrent writers each produce whole lines") {
    // Decisions are answered on DecisionServer's threads, so this is the real
    // access pattern and not a hypothetical one. Interleaved half-lines would
    // make every record after the collision unreadable.
    const std::string path = scratch("threads");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal(path);

    constexpr int kThreads = 8;
    constexpr int kEach = 100;
    std::vector<std::thread> threads;
    threads.reserve(kThreads);
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back([&] {
            for (int i = 0; i < kEach; ++i) {
                journal.record(i + 1, kRequest,
                               ap::decide_response(kRequest, leases, policy, 0), policy);
            }
        });
    }
    for (auto& th : threads) th.join();

    const auto lines = lines_of(path);
    REQUIRE(lines.size() == kThreads * kEach);
    for (const auto& line : lines) {
        REQUIRE(line.front() == '{');
        REQUIRE(line.back() == '}');
        REQUIRE(ap::json_field(line, "holder") == "sess_a");
    }
}

TEST_CASE("a journal deleted under the daemon comes back on the next tick") {
    // The runtime directory is /tmp on a lot of machines and /tmp gets swept.
    // Holding the fd open is what makes the write cheap; it is also what would
    // quietly send every later record into an unlinked inode. The tick notices.
    const std::string path = scratch("swept");
    ap::PolicyCache policy;
    const auto leases = held_at("normal");
    ap::DecisionJournal journal(path);

    journal.record(1, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);
    REQUIRE(lines_of(path).size() == 1);

    std::error_code ec;
    std::filesystem::remove(path, ec);
    REQUIRE_FALSE(journal.maybe_trim());  // nothing to trim, but it looked

    journal.record(2, kRequest, ap::decide_response(kRequest, leases, policy, 0), policy);
    const auto lines = lines_of(path);
    REQUIRE(lines.size() == 1);
    REQUIRE(lines[0].find(R"("at_ms":2)") != std::string::npos);
    REQUIRE(journal.written() == 2);
}
