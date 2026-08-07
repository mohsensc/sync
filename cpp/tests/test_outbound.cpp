#include <catch2/catch_test_macros.hpp>

#include "daemon/outbound.hpp"

using ap::Outbound;

TEST_CASE("messages buffer while disconnected and drain in order on reconnect") {
    Outbound o(10);
    o.push("a");
    o.push("b");
    o.push("c");
    auto out = o.drain();
    REQUIRE(out == std::vector<std::string>{"a", "b", "c"});
    REQUIRE(o.size() == 0);
}

TEST_CASE("an unbounded outage drops the oldest rather than growing forever") {
    Outbound o(3);
    for (char c : {'a', 'b', 'c', 'd', 'e'}) o.push(std::string(1, c));
    REQUIRE(o.size() == 3);
    REQUIRE(o.dropped() == 2);
    // Newest survives: stale presence is worthless, current presence is not.
    REQUIRE(o.drain() == std::vector<std::string>{"c", "d", "e"});
}

TEST_CASE("draining an empty buffer is safe") {
    Outbound o(4);
    REQUIRE(o.drain().empty());
}
