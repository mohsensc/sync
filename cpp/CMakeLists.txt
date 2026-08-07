cmake_minimum_required(VERSION 3.25)
project(agent_presence CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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
