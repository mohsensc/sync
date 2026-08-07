#include <catch2/catch_test_macros.hpp>
#include "daemon/lease_cache.hpp"

using ap::CachedLease;
using ap::LeaseCache;

namespace {

LeaseCache with_one(long long expires) {
    LeaseCache c;
    c.replace({{"src/auth.py|sign_in", CachedLease{"a1", "sara", "refactor", expires}}});
    return c;
}

}  // namespace

TEST_CASE("reports a conflict held by another agent") {
    auto c = with_one(10'000);
    auto hit = c.conflict_for("src/auth.py|sign_in", "a2", 0);
    REQUIRE(hit.has_value());
    REQUIRE(hit->agent == "a1");
}

TEST_CASE("an agent never conflicts with its own lease") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/auth.py|sign_in", "a1", 0).has_value());
}

TEST_CASE("an expired lease is not a conflict even if still cached") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/auth.py|sign_in", "a2", 20'000).has_value());
}

TEST_CASE("an unknown region is never a conflict, which is the fail-open default") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/other.py|f", "a2", 0).has_value());
}

TEST_CASE("an empty cache blocks nothing") {
    LeaseCache c;
    REQUIRE_FALSE(c.conflict_for("any|thing", "a2", 0).has_value());
}
