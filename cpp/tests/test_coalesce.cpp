#include <catch2/catch_test_macros.hpp>
#include "daemon/coalesce.hpp"

using ap::Coalescer;
using ap::Ev;

TEST_CASE("identical events inside the window collapse to one") {
    Coalescer c(1000, 100);
    Ev e{"read", "a.py", "s1"};
    REQUIRE(c.admit(e, 0));
    REQUIRE_FALSE(c.admit(e, 500));
    REQUIRE(c.admit(e, 1500));
}

TEST_CASE("different paths are admitted independently") {
    Coalescer c(1000, 100);
    REQUIRE(c.admit(Ev{"read", "a.py", "s1"}, 0));
    REQUIRE(c.admit(Ev{"read", "b.py", "s1"}, 0));
}

TEST_CASE("a flood is capped and the overflow counted, not queued") {
    Coalescer c(1000, 10);
    for (int i = 0; i < 50; ++i) {
        c.admit(Ev{"search", "f" + std::to_string(i) + ".py", "s1"}, 0);
    }
    REQUIRE(c.dropped() == 40);
}

TEST_CASE("the cap resets when the window rolls") {
    Coalescer c(1000, 2);
    c.admit(Ev{"search", "a.py", "s1"}, 0);
    c.admit(Ev{"search", "b.py", "s1"}, 0);
    REQUIRE_FALSE(c.admit(Ev{"search", "c.py", "s1"}, 0));
    REQUIRE(c.admit(Ev{"search", "c.py", "s1"}, 1500));
}
