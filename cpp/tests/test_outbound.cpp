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

TEST_CASE("a line bound for the relay keeps only the four permitted fields") {
    const std::string hostile =
        R"({"verb":"edit","agent":"s1","human":"sara","path":"src/auth.py",)"
        R"("content":"AWS_SECRET_ACCESS_KEY=hunter2","diff":"- old\n+ new",)"
        R"("prompt":"rewrite this","env":{"TOKEN":"hunter2"}})";
    const std::string clean = ap::redact_line(hostile);

    REQUIRE(clean.find("hunter2") == std::string::npos);
    REQUIRE(clean.find("content") == std::string::npos);
    REQUIRE(clean.find("diff") == std::string::npos);
    REQUIRE(clean.find("prompt") == std::string::npos);
    REQUIRE(clean.find("env") == std::string::npos);
    REQUIRE(clean ==
            R"({"verb":"edit","agent":"s1","human":"sara","path":"src/auth.py"})");
}

TEST_CASE("redaction does not truncate a path holding an escaped quote") {
    const std::string line =
        R"({"verb":"read","agent":"s1","path":"src/say \"hi\".py","content":"secret"})";
    const std::string clean = ap::redact_line(line);
    REQUIRE(clean.find(R"(src/say \"hi\".py)") != std::string::npos);
    REQUIRE(clean.find("secret") == std::string::npos);
}

TEST_CASE("a missing field forwards as empty rather than dragging in the next one") {
    const std::string line = R"({"agent":"s1","stdout":"whoami -> root"})";
    const std::string clean = ap::redact_line(line);
    REQUIRE(clean == R"({"verb":"","agent":"s1","human":"","path":""})");
}
