#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "hook/hook.hpp"

TEST_CASE("hook p99 stays under the 5ms budget with no daemon listening") {
    const std::string payload =
        R"({"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.py"},"session_id":"s1"})";

    std::vector<double> samples;
    samples.reserve(1000);
    for (int i = 0; i < 1000; ++i) {
        auto t0 = std::chrono::steady_clock::now();
        ap::write_line("/nonexistent/p.sock", ap::build_event(payload), 5);
        auto t1 = std::chrono::steady_clock::now();
        samples.push_back(
            std::chrono::duration<double, std::milli>(t1 - t0).count());
    }

    std::sort(samples.begin(), samples.end());
    REQUIRE(samples[static_cast<size_t>(samples.size() * 0.99)] < 5.0);
}
