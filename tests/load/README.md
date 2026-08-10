# Load and chaos harness

Everything else here is verified at two agents, one room, one machine. This
finds out where that stops holding. It starts real relays and real `presenced`
processes, hammers them, kills things, and prints numbers.

It only measures. It fixes nothing and patches nothing in the product.

## Run it

```
cmake -S cpp -B cpp/build && cmake --build cpp/build   # once
python/.venv/bin/python tests/load/run.py --all
```

`--all` takes about two minutes. One scenario at a time works too, and every
count is tunable:

```
python/.venv/bin/python tests/load/run.py --list
python/.venv/bin/python tests/load/run.py swarm200 --agents-large 500 --rounds 20
python/.venv/bin/python tests/load/run.py hook-latency --storm-lanes 16
python/.venv/bin/python tests/load/run.py --all --json /tmp/load.json
```

Exit code is 1 if anything was found. Scenarios run serially on purpose —
several measure latency against a live socket and running them together would
measure the laptop instead.

## What each one does

| scenario | what it hammers |
| --- | --- |
| `swarm50`, `swarm200` | N agents, one room, a few hot regions. Throughput, latency, fan-out, memory, lease leaks, deadlock |
| `rooms` | R rooms at once with colliding paths. Isolation, and whether dead rooms are ever forgotten |
| `relay-restart` | SIGKILL the relay under connected daemons. Reconnect, buffering, drain, stale leases |
| `daemon-kill` | SIGKILL `presenced` while hooks fire. Exit codes and latency across the kill |
| `flood` | thousands of events a second from one agent. Coalescer cap, snapshot writes, backlog |
| `slow-subscriber` | a peer that completes the handshake and never reads again |
| `hook-latency` | the 5ms budget with a big lease cache, a busy relay, and an event storm on the same socket |
| `lease-churn` | claims abandoned across a short TTL, with the TTL turned down so expiry is observable |
| `lease-takeover` | one region handed from an expired holder to a new one, end to end through a real daemon |

## Notes

`hookbench.cpp` calls `ap::run_hook` directly rather than exec'ing `ap-hook`,
because the budget is a promise about the socket round trip and a fork+exec
buries it under process setup. `daemon-kill` also runs the real binary a few
times to check the exit code, which is the part that needs a real process.

It compiles itself into `tests/load/build/` on first run. `cpp/CMakeLists.txt`
is the product's and the harness has no business editing it.

`_relay_boot.py` starts the shipped relay with `LEASE_TTL_S` optionally patched.
Nothing else about the relay is changed, and with `AP_LOAD_LEASE_TTL_S` unset it
runs exactly as installed. Scenarios that watch a lease expire need it: 90
seconds per lease is not a thing you can churn.

Two shapes of input are load-bearing and easy to get wrong. `event_line` and
`hook_payload` emit compact JSON, because `hook/hook.cpp` and `daemon/json.cpp`
search for the literal `"key":"` — a space after the colon is valid JSON and
extracts nothing at all.

## Known gaps

- Clock pressure is only churn. The relay stamps leases with `time.time()` and
  the daemon expires them on a monotonic clock; a wall clock that steps
  backwards is not exercised here because the harness cannot move the system
  clock.
- One machine. Everything talks over loopback, so nothing here says anything
  about latency or partitions on a real network.
- `swarm200` is 200 websocket clients in one Python process. Past roughly 500
  the harness becomes the bottleneck rather than the relay.
