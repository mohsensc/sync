# gohook — spike for issue #23

Not a product. Not built by `cpp/CMakeLists.txt`, not installed by
`install.sh`, not linked from anywhere else in the tree. It exists to answer
one question: does a Go build of `cpp/hook/`'s hot path clear the 5ms budget
once fork+exec is counted. See `docs/gohook-spike.md` for the numbers and the
recommendation.

`main.go` is a straight port of `cpp/hook/hook.cpp` + `main.cpp`: same stdin
read cap, same naive scalar field extractor (no JSON library — allocating a
parser on every tool call is exactly the cost this spike prices), same
two-socket protocol (event socket, `.decide` socket, half-close before read),
same floor table. It does not port the daemon-message prose (handover/lost/
near/blocked wording) — that's policy dressing, not hot-path cost, and out of
scope for "can the runtime meet the budget."

## Build

```
cd spike/gohook && go build -o gohook .
```

## Run the benchmark

Needs the real C++ hook and daemon built first:

```
cmake -S cpp -B cpp/build && cmake --build cpp/build
cd spike/gohook && go build -o gohook .
python3 bench/run.py --iters 1000 --storm-lanes 16 --json /tmp/result.json
```

`bench/run.py` starts a real `presenced` (no relay reachable, empty lease
cache — same "idle" shape `tests/load/scenarios.py`'s `hook_latency` benches
against before any leases are populated), then times `ap-hook` and `gohook`
head to head: one real subprocess per call (fork+exec, not `ap::run_hook`
in-process like `hookbench.cpp`), alternating cpp/go one call at a time so
both eat the same thermal drift and background noise, at idle and under 16
threads hammering the event socket the way `scenarios.py`'s `storm()` does.
`--raw` also dumps the per-call sample arrays for paired-delta analysis.
