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

TEST_CASE("the dedup map does not grow without bound") {
    Coalescer c(1000, 10);
    // 500 windows, 10 fresh paths each. Nothing repeats, so nothing may be
    // remembered past its window.
    for (int w = 0; w < 500; ++w) {
        const long long now = static_cast<long long>(w) * 1000;
        for (int i = 0; i < 10; ++i) {
            c.admit(Ev{"read", "f" + std::to_string(w) + "_" + std::to_string(i) + ".py", "s1"},
                    now);
        }
        REQUIRE(c.tracked() <= 20);
    }
}

TEST_CASE("an entry older than the window is forgotten") {
    Coalescer c(1000, 10);
    REQUIRE(c.admit(Ev{"read", "a.py", "s1"}, 0));
    REQUIRE(c.tracked() == 1);
    c.admit(Ev{"read", "b.py", "s1"}, 5000);
    REQUIRE(c.tracked() == 1);  // a.py aged out, b.py took its place
}

TEST_CASE("the cap resets when the window rolls") {
    Coalescer c(1000, 2);
    c.admit(Ev{"search", "a.py", "s1"}, 0);
    c.admit(Ev{"search", "b.py", "s1"}, 0);
    REQUIRE_FALSE(c.admit(Ev{"search", "c.py", "s1"}, 0));
    REQUIRE(c.admit(Ev{"search", "c.py", "s1"}, 1500));
}
