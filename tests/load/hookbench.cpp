// The hook's socket phase, measured, against whatever daemon is on the socket.
//
// Deliberately calls ap::run_hook rather than exec'ing ap-hook: the 5ms budget
// is a promise about the socket round trip, and a fork+exec measurement buries
// it under 3-10ms of process setup that the product does not control. The
// separate exit-code proof in the Python harness covers the binary itself.
//
//   hookbench <sock> <iters> [threads] [pace_us] [path_prefix]
//
// Prints one JSON line: latency percentiles, how many calls came back with a
// decision, and how many came back empty. Empty is the number that matters
// under load — an empty answer is the hook allowing an edit it might not have.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "hook/hook.hpp"

namespace {

constexpr int kSocketBudgetMs = 2;  // the value cpp/hook/main.cpp ships with

double pct(std::vector<double>& v, double q) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    size_t i = static_cast<size_t>(q * static_cast<double>(v.size()));
    if (i >= v.size()) i = v.size() - 1;
    return v[i];
}

void spin_us(long us) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::microseconds(us);
    while (std::chrono::steady_clock::now() < until) {
    }
}

std::string payload_for(const std::string& path, const std::string& session) {
    std::string s = R"({"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":")";
    s += path;
    s += R"("},"file_path":")";
    s += path;
    s += R"(","session_id":")";
    s += session;
    s += R"("})";
    return s;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: hookbench <sock> <iters> [threads] [pace_us] [prefix]\n");
        return 2;
    }
    const std::string sock = argv[1];
    const int iters = std::atoi(argv[2]);
    const int threads = argc > 3 ? std::atoi(argv[3]) : 1;
    const long pace_us = argc > 4 ? std::atol(argv[4]) : 0;
    const std::string prefix = argc > 5 ? argv[5] : "/repo/src/hot";

    std::mutex mu;
    std::vector<double> all;
    long long answered = 0;   // came back with something to say
    long long empty = 0;      // came back with nothing, i.e. allowed

    std::vector<std::thread> pool;
    for (int t = 0; t < threads; ++t) {
        pool.emplace_back([&, t] {
            std::vector<double> mine;
            mine.reserve(static_cast<size_t>(iters));
            long long a = 0, e = 0;
            for (int i = 0; i < iters; ++i) {
                const std::string path = prefix + std::to_string(i % 8) + ".py";
                const std::string in = payload_for(path, "bench-" + std::to_string(t));
                const auto t0 = std::chrono::steady_clock::now();
                const std::string out = ap::run_hook(in, sock, kSocketBudgetMs);
                const auto t1 = std::chrono::steady_clock::now();
                mine.push_back(
                    std::chrono::duration<double, std::milli>(t1 - t0).count());
                if (out.empty()) ++e; else ++a;
                if (pace_us > 0) spin_us(pace_us);
            }
            std::lock_guard<std::mutex> lock(mu);
            all.insert(all.end(), mine.begin(), mine.end());
            answered += a;
            empty += e;
        });
    }
    for (auto& th : pool) th.join();

    const double p50 = pct(all, 0.50);
    const double p95 = pct(all, 0.95);
    const double p99 = pct(all, 0.99);
    const double mx = all.empty() ? 0.0 : *std::max_element(all.begin(), all.end());

    // p99 hides a tail that matters: one call over 5ms is one tool call the
    // user waited on. Count them outright.
    long long over5 = 0;
    for (double v : all) if (v > 5.0) ++over5;

    std::printf(
        "{\"n\":%zu,\"threads\":%d,\"p50_ms\":%.3f,\"p95_ms\":%.3f,\"p99_ms\":%.3f,"
        "\"max_ms\":%.3f,\"over_5ms\":%lld,\"answered\":%lld,\"empty\":%lld}\n",
        all.size(), threads, p50, p95, p99, mx, over5, answered, empty);
    return 0;
}
