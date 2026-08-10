// The daemon's whole knowledge of policy: five enum values, a floor, and a max.
//
// The thing under test is not really the parsing — it is the pair of promises
// that make it safe to consult policy inside a 5ms budget. Nothing here parses
// TOML, and nothing here can produce an effect below kBuiltinFloor no matter
// what is in the file.

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "daemon/policy_cache.hpp"

namespace {

std::string temp_file(const char* stem) {
    static std::atomic<int> counter{0};
    return (std::filesystem::temp_directory_path() /
            (std::string("ap_policy_") + stem + "_" +
             std::to_string(counter.fetch_add(1)) + ".json"))
        .string();
}

void write(const std::string& path, const std::string& body) {
    std::ofstream f(path, std::ios::trunc);
    f << body;
}

/// A compiled cache with the given five table names. The floor in the blob is
/// the builtin one; the org floor arrives separately, over the relay.
std::string blob(const std::string& table) {
    return R"({"schema":1,"digest":"d","degraded":false,"problem":"","table":)" + table +
           R"(,"floor":["silent","silent","silent","notify","silent"]})";
}

const std::string kAllSilent = R"(["silent","silent","silent","silent","silent"])";

struct Scratch {
    std::string path;
    explicit Scratch(const char* stem) : path(temp_file(stem)) {}
    ~Scratch() {
        std::error_code ec;
        std::filesystem::remove(path, ec);
    }
};

/// The mtime gate only stats once per 100ms, so tests step the clock by more
/// than that between writes rather than sleeping.
long long tick(int n) { return 1000LL * n; }

}  // namespace

TEST_CASE("an untouched cache is the compiled-in table") {
    ap::PolicyCache p;
    REQUIRE(p.effect_for(0) == ap::Effect::Silent);
    REQUIRE(p.effect_for(1) == ap::Effect::Notify);
    REQUIRE(p.effect_for(2) == ap::Effect::Context);
    REQUIRE(p.effect_for(3) == ap::Effect::Deny);
    REQUIRE(p.effect_for(4) == ap::Effect::Context);
    REQUIRE_FALSE(p.degraded());
}

TEST_CASE("a missing cache file leaves the builtin table and is not a degradation") {
    // The daemon may well start before anything has compiled a policy. That is
    // the documented default, not a fault, and calling it degraded would put a
    // permanent warning on the statusline of every machine with no config.
    ap::PolicyCache p;
    REQUIRE_FALSE(p.refresh(temp_file("absent"), tick(1)));
    REQUIRE_FALSE(p.degraded());
    REQUIRE(p.problem().empty());
    REQUIRE(p.effect_for(3) == ap::Effect::Deny);
}

TEST_CASE("a compiled cache replaces the table") {
    Scratch s("load");
    write(s.path, blob(R"(["silent","context","context","ask","notify"])"));

    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));
    REQUIRE(p.effect_for(1) == ap::Effect::Context);
    REQUIRE(p.effect_for(3) == ap::Effect::Ask);
    REQUIRE(p.effect_for(4) == ap::Effect::Notify);
    REQUIRE_FALSE(p.degraded());
    REQUIRE(p.source() == s.path);
}

TEST_CASE("effect_for is the louder of the local table and the floor, over the whole grid") {
    for (int local = 0; local < ap::kRungs; ++local) {
        for (int floor = 0; floor < ap::kRungs; ++floor) {
            Scratch s("grid");
            const std::string name = ap::effect_name(static_cast<ap::Effect>(local));
            write(s.path, blob("[\"" + name + "\",\"" + name + "\",\"" + name + "\",\"" + name +
                               "\",\"" + name + "\"]"));

            ap::PolicyCache p;
            REQUIRE(p.refresh(s.path, tick(1)));

            ap::PolicyTable pushed;
            pushed.rung.fill(static_cast<ap::Effect>(floor));
            p.set_floor(pushed, "org:test");

            for (int rung = 0; rung < ap::kRungs; ++rung) {
                const ap::Effect want = ap::louder(
                    ap::louder(static_cast<ap::Effect>(local), static_cast<ap::Effect>(floor)),
                    ap::kBuiltinFloor.rung[rung]);
                INFO("local " << local << " floor " << floor << " rung " << rung);
                REQUIRE(p.effect_for(rung) == want);
            }
        }
    }
}

TEST_CASE("a pushed floor can never go below the builtin floor") {
    // Anything that can reach the relay can send a policy frame. The one thing
    // it must not be able to do is make a real rung 3 disappear.
    ap::PolicyCache p;
    ap::PolicyTable all_silent;
    all_silent.rung.fill(ap::Effect::Silent);
    p.set_floor(all_silent, "org:hostile");
    REQUIRE(p.floor().rung[3] == ap::Effect::Notify);
    REQUIRE(p.effect_for(3) == ap::Effect::Deny);
}

TEST_CASE("a silent table still cannot resolve below the builtin floor") {
    Scratch s("silence");
    write(s.path, blob(kAllSilent));

    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));
    REQUIRE(p.table().rung[3] == ap::Effect::Silent);  // the file really did say silent
    REQUIRE(p.effect_for(3) == ap::Effect::Notify);    // and it still does not get it
    for (int rung = 0; rung < ap::kRungs; ++rung) {
        REQUIRE(p.effect_for(rung) >= ap::kBuiltinFloor.rung[rung]);
    }
}

TEST_CASE("a truncated cache keeps the previous table and says it is degraded") {
    Scratch s("truncated");
    write(s.path, blob(R"(["silent","notify","notify","ask","silent"])"));

    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));
    REQUIRE(p.effect_for(3) == ap::Effect::Ask);

    write(s.path, R"({"schema":1,"table":["silent","notify",)");
    REQUIRE_FALSE(p.refresh(s.path, tick(2)));

    REQUIRE(p.effect_for(3) == ap::Effect::Ask);  // last good, not builtin, not silence
    REQUIRE(p.degraded());
    REQUIRE_FALSE(p.problem().empty());
}

TEST_CASE("an empty or non-JSON cache keeps the previous table and never drops below the floor") {
    for (const std::string junk : {std::string(), std::string("not json at all"),
                                   std::string("{}"), std::string(R"({"table":"deny"})"),
                                   std::string(R"({"table":["deny","deny"]})")}) {
        Scratch s("junk");
        write(s.path, blob(R"(["silent","notify","notify","ask","silent"])"));

        ap::PolicyCache p;
        REQUIRE(p.refresh(s.path, tick(1)));

        write(s.path, junk);
        p.refresh(s.path, tick(2));

        INFO("junk was " << junk);
        REQUIRE(p.effect_for(3) == ap::Effect::Ask);
        REQUIRE(p.degraded());
        for (int rung = 0; rung < ap::kRungs; ++rung) {
            REQUIRE(p.effect_for(rung) >= ap::kBuiltinFloor.rung[rung]);
        }
    }
}

TEST_CASE("an unknown effect name keeps that rung and records a problem") {
    // A cache written by a newer `ap` that grew a sixth effect must not turn
    // this daemon off. The rungs it does understand still apply.
    Scratch s("unknown");
    write(s.path, blob(R"(["silent","notify","context","deny","silent"])"));
    ap::PolicyCache p;
    p.refresh(s.path, tick(1));

    write(s.path, blob(R"(["silent","shout","context","ask","silent"])"));
    p.refresh(s.path, tick(2));

    REQUIRE(p.effect_for(1) == ap::Effect::Notify);  // held at its previous value
    REQUIRE(p.effect_for(3) == ap::Effect::Ask);     // the understood rungs applied
    REQUIRE(p.degraded());
    REQUIRE(p.problem().find("shout") != std::string::npos);
}

TEST_CASE("a cache that starts parsing again clears the degradation") {
    Scratch s("recover");
    write(s.path, blob(R"(["silent","notify","context","ask","silent"])"));
    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));

    write(s.path, "garbage");
    p.refresh(s.path, tick(2));
    REQUIRE(p.degraded());

    write(s.path, blob(R"(["silent","notify","context","deny","silent"])"));
    p.refresh(s.path, tick(3));
    REQUIRE_FALSE(p.degraded());
    REQUIRE(p.effect_for(3) == ap::Effect::Deny);
}

TEST_CASE("a cache that disappears keeps the table and says so") {
    Scratch s("vanish");
    write(s.path, blob(R"(["silent","notify","context","ask","silent"])"));
    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));

    std::filesystem::remove(s.path);
    p.refresh(s.path, tick(2));

    REQUIRE(p.effect_for(3) == ap::Effect::Ask);
    REQUIRE(p.degraded());
}

TEST_CASE("refresh only parses when the file actually moved") {
    // This is the whole reason live reload is affordable on a 100ms tick: the
    // steady state is one stat, not one parse.
    Scratch s("gate");
    write(s.path, blob(R"(["silent","notify","context","ask","silent"])"));

    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, tick(1)));
    REQUIRE(p.parses() == 1);

    for (int i = 2; i < 12; ++i) REQUIRE_FALSE(p.refresh(s.path, tick(i)));
    REQUIRE(p.parses() == 1);

    write(s.path, blob(R"(["silent","notify","context","deny","silent"])"));
    REQUIRE(p.refresh(s.path, tick(20)));
    REQUIRE(p.parses() == 2);
}

TEST_CASE("refresh does not even stat more often than the recheck interval") {
    Scratch s("recheck");
    write(s.path, blob(R"(["silent","notify","context","ask","silent"])"));

    ap::PolicyCache p;
    REQUIRE(p.refresh(s.path, 0));
    write(s.path, blob(R"(["deny","deny","deny","deny","deny"])"));
    // Inside the window: the change is real but this call does not look.
    REQUIRE_FALSE(p.refresh(s.path, 50));
    REQUIRE(p.effect_for(0) == ap::Effect::Silent);
    // Past it, and the same change lands.
    REQUIRE(p.refresh(s.path, 200));
    REQUIRE(p.effect_for(0) == ap::Effect::Deny);
}

TEST_CASE("refresh reports whether the table moved, not whether a file was read") {
    // A compiled cache that happens to say exactly what the builtin table says
    // is a successful load and not a change, so refresh answers false. Callers
    // use the return value to decide whether to rewrite the snapshot; "the file
    // was read" is not a reason to do that.
    Scratch s("nomove");
    write(s.path, blob(R"(["silent","notify","context","deny","context"])"));

    ap::PolicyCache p;
    REQUIRE_FALSE(p.refresh(s.path, tick(1)));
    REQUIRE(p.parses() == 1);
    REQUIRE(p.source() == s.path);  // it really was loaded
    REQUIRE_FALSE(p.degraded());
}

TEST_CASE("a rung outside the ladder is silent rather than a crash") {
    ap::PolicyCache p;
    REQUIRE(p.effect_for(-1) == ap::Effect::Silent);
    REQUIRE(p.effect_for(5) == ap::Effect::Silent);
    REQUIRE(p.effect_for(9999) == ap::Effect::Silent);
}

TEST_CASE("effect names round trip") {
    for (int i = 0; i < ap::kRungs; ++i) {
        const auto e = static_cast<ap::Effect>(i);
        REQUIRE(ap::parse_effect(ap::effect_name(e)) == e);
    }
    REQUIRE_FALSE(ap::parse_effect("shout").has_value());
    REQUIRE_FALSE(ap::parse_effect("").has_value());
    REQUIRE_FALSE(ap::parse_effect("Silent").has_value());
}

TEST_CASE("parse_effect_list rejects anything that is not five names") {
    ap::PolicyTable t = ap::kBuiltin;
    REQUIRE_FALSE(ap::parse_effect_list("", t, nullptr));
    REQUIRE_FALSE(ap::parse_effect_list("[]", t, nullptr));
    REQUIRE_FALSE(ap::parse_effect_list(R"(["silent"])", t, nullptr));
    REQUIRE_FALSE(ap::parse_effect_list(R"(["a","b","c","d","e","f"])", t, nullptr));
    REQUIRE_FALSE(ap::parse_effect_list(R"([1,2,3,4,5])", t, nullptr));
    REQUIRE_FALSE(ap::parse_effect_list(R"(["silent","notify","context","deny","silent")", t,
                                        nullptr));
    // Untouched by every one of those.
    REQUIRE(t.rung == ap::kBuiltin.rung);

    REQUIRE(ap::parse_effect_list(R"( [ "silent" , "notify" , "context" , "deny" , "silent" ] )", t,
                                  nullptr));
}

TEST_CASE("concurrent refresh and effect_for stay coherent") {
    // The decision threads read this while the event loop reloads it. The
    // answer may be the old table or the new one; it may never be neither.
    Scratch s("race");
    write(s.path, blob(R"(["silent","notify","context","deny","silent"])"));

    ap::PolicyCache p;
    p.refresh(s.path, 0);

    std::atomic<bool> stop{false};
    std::atomic<long long> reads{0};
    // Catch2's assertion macros are not safe off the main thread, so the
    // readers record a verdict and the checking happens after the join.
    std::atomic<bool> below_floor{false};
    std::vector<std::thread> readers;
    for (int i = 0; i < 4; ++i) {
        readers.emplace_back([&] {
            while (!stop.load(std::memory_order_relaxed)) {
                for (int rung = 0; rung < ap::kRungs; ++rung) {
                    if (p.effect_for(rung) < ap::kBuiltinFloor.rung[rung]) {
                        below_floor.store(true, std::memory_order_relaxed);
                    }
                }
                reads.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    for (int i = 1; i <= 200; ++i) {
        write(s.path, blob(i % 2 ? R"(["silent","notify","context","ask","silent"])"
                                 : R"(["silent","notify","context","deny","silent"])"));
        p.refresh(s.path, 1000LL * i);
    }

    stop.store(true, std::memory_order_relaxed);
    for (auto& t : readers) t.join();
    REQUIRE(reads.load() > 0);
    REQUIRE_FALSE(below_floor.load());
}
