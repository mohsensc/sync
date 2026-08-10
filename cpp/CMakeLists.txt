cmake_minimum_required(VERSION 3.25)
project(agent_presence CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Before any add_test() below, and before FetchContent pulls Catch2 in — a
# subproject that calls enable_testing() of its own does not enable it here.
enable_testing()

add_library(ap_hook_lib hook/hook.cpp)
target_include_directories(ap_hook_lib PUBLIC .)

add_executable(ap-hook hook/main.cpp)
target_link_libraries(ap-hook PRIVATE ap_hook_lib)

add_library(ap_daemon_lib daemon/socket_server.cpp daemon/coalesce.cpp)
target_include_directories(ap_daemon_lib PUBLIC .)

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

# The 5ms budget is the constraint most likely to rot silently. This is its guard.
target_sources(ap_tests PRIVATE tests/test_latency.cpp)

target_sources(ap_daemon_lib PRIVATE daemon/lease_cache.cpp)
target_sources(ap_tests PRIVATE tests/test_lease_cache.cpp)
target_link_libraries(ap_tests PRIVATE ap_daemon_lib)

target_sources(ap_tests PRIVATE tests/test_socket_server.cpp)

target_sources(ap_tests PRIVATE tests/test_coalesce.cpp)

target_sources(ap_daemon_lib PRIVATE daemon/snapshot.cpp)
target_sources(ap_tests PRIVATE tests/test_snapshot.cpp)
target_link_libraries(ap_tests PRIVATE ap_daemon_lib)

find_package(OpenSSL REQUIRED)
target_sources(ap_daemon_lib PRIVATE daemon/repo.cpp)
target_link_libraries(ap_daemon_lib PUBLIC OpenSSL::Crypto)
target_sources(ap_tests PRIVATE tests/test_repo.cpp)

target_sources(ap_daemon_lib PRIVATE daemon/outbound.cpp)
target_sources(ap_tests PRIVATE tests/test_outbound.cpp)

# Compiles daemon/main.cpp a second time with main() off, to test its extractor.
target_sources(ap_tests PRIVATE tests/test_daemon_field.cpp)

add_executable(presenced daemon/main.cpp)
target_link_libraries(presenced PRIVATE ap_daemon_lib)

# The relay transport. Needs SHA-1 for the handshake, which OpenSSL::Crypto
# above already provides, and a thread for the name lookup it must not block on.
find_package(Threads REQUIRED)
target_sources(ap_daemon_lib PRIVATE daemon/relay_client.cpp)
target_link_libraries(ap_daemon_lib PUBLIC Threads::Threads)
target_sources(ap_tests PRIVATE tests/test_relay_client.cpp)

# The daemon's whole knowledge of policy: five enum values read from the blob
# `ap policy compile` writes, plus the org floor the relay pushes. No TOML on
# this side, ever — a decision is a shared lock and an array index.
target_sources(ap_daemon_lib PRIVATE daemon/policy_cache.cpp)
target_sources(ap_tests PRIVATE tests/test_policy_cache.cpp)

# The daemon's half of the hook protocol: the extractor both halves read the
# wire with, and the responder that answers a decision request.
target_sources(ap_daemon_lib PRIVATE daemon/json.cpp daemon/decide.cpp
                                daemon/contend_queue.cpp)
target_sources(ap_tests PRIVATE tests/test_decide.cpp tests/test_decision_path.cpp
                                tests/test_decide_policy.cpp tests/test_handover.cpp)

# The writer behind `ap why`. The reader has always been journal.py; this is
# the half that was missing, so a block can be asked about after the fact.
target_sources(ap_daemon_lib PRIVATE daemon/journal.cpp)
target_sources(ap_tests PRIVATE tests/test_journal.cpp)

# Decisions off the event loop, on their own socket. Its test floods the event
# socket and insists the answers keep coming, which is the thing that used to
# fail silently.
target_sources(ap_daemon_lib PRIVATE daemon/decision_server.cpp)
target_sources(ap_tests PRIVATE tests/test_decision_server.cpp)

# One test, running the whole binary, because `ctest --test-dir cpp/build` used
# to fail with "No test configuration file found" and everyone had to know to
# run ./build/ap_tests instead.
#
# Deliberately not catch_discover_tests: several cases here are latency guards
# that measure a p99 against a live socket, and ctest -j would have them
# competing for the same CPU and failing on the machine rather than on the code.
# One serial invocation is what those numbers mean.
add_test(NAME ap_tests COMMAND ap_tests)
