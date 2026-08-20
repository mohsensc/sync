cmake_minimum_required(VERSION 3.25)
project(agent_presence CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Before any add_test() below, and before FetchContent pulls Catch2 in — a
# subproject that calls enable_testing() of its own does not enable it here.
enable_testing()

# The hook, and only the hook — see docs/gohook-spike.md for why it stays
# C++ while the daemon (go/) does not. No OpenSSL: the hook's only other
# dependencies were ever the ones the daemon needed. It does call
# pthread_sigmask/sigwait (SigPipeGuard), so Threads is linked below —
# on AppleClang and glibc >= 2.34 that's folded into libc already, but
# older glibc (Ubuntu 20.04, Debian 11) needs it linked explicitly.
find_package(Threads REQUIRED)

add_library(ap_hook_lib hook/hook.cpp)
target_include_directories(ap_hook_lib PUBLIC .)
target_link_libraries(ap_hook_lib PUBLIC Threads::Threads)

add_executable(ap-hook hook/main.cpp)
target_link_libraries(ap-hook PRIVATE ap_hook_lib)

# Tests are never optional. Prefer an installed Catch2, vendor it otherwise.
find_package(Catch2 3 QUIET)
if(NOT Catch2_FOUND)
  include(FetchContent)
  FetchContent_Declare(Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG v3.5.2)
  FetchContent_MakeAvailable(Catch2)
endif()

add_executable(ap_tests tests/test_hook.cpp)
target_link_libraries(ap_tests PRIVATE ap_hook_lib Catch2::Catch2WithMain)

# The 5ms budget is the constraint most likely to rot silently. This is its
# guard. Both files test the hook against FakeDaemon (tests/fake_daemon.hpp),
# a stand-in that speaks the documented wire protocol — not the real daemon,
# in either language. The proof that the real Go presenced binary still
# speaks that protocol byte for byte is tests/load/run.py: it drives this
# same ap-hook binary, unmodified, against the real Go daemon over the real
# unix sockets for every scenario it runs.
target_sources(ap_tests PRIVATE tests/test_latency.cpp)

# One test, running the whole binary, because `ctest --test-dir cpp/build` used
# to fail with "No test configuration file found" and everyone had to know to
# run ./build/ap_tests instead.
#
# Deliberately not catch_discover_tests: several cases here are latency guards
# that measure a p99 against a live socket, and ctest -j would have them
# competing for the same CPU and failing on the machine rather than on the code.
# One serial invocation is what those numbers mean.
add_test(NAME ap_tests COMMAND ap_tests)
