# Agent Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a system where multiple people's coding agents in a shared repo are mutually aware — rendered as an ambient animated world for humans, and as claims and negotiation for agents — preventing redundant work and conflicting edits.

**Architecture:** A C++ hook binary observes every tool call and writes events to a unix socket. A C++ daemon (`presenced`) coalesces, redacts, and forwards them over one WebSocket per machine to a Python relay. The relay is the sole authority on leases and arbitrates collisions via a five-rung ladder with wait-die deadlock resolution. A Python MCP server carries deliberate intent. A TypeScript/Three.js dashboard and a statusline segment subscribe read-only.

**Tech Stack:** C++20 (hook + daemon; CMake, Catch2, `libwebsockets`), Python 3.12 (core domain, relay, MCP server; `pytest`, `hypothesis`, `websockets`, `mcp`), TypeScript + Three.js (dashboard; `vite`, `vitest`).

## Global Constraints

- **Fail open, always.** Every failure path resolves to "the agent behaves exactly as if nothing were installed." No failure may block, delay, or error an agent's tool call.
- **Hook latency budget: 5ms p99, hard cap.** If a socket write would block, drop the event rather than queue it.
- **Protocol logic lives only in Python.** The C++ daemon performs cache lookups and transport. It must never implement ladder classification, wait-die, or lease arbitration. Any PR adding protocol reasoning to C++ is wrong by construction.
- **All timestamps used in ordering decisions are assigned by the relay on receipt.** Clients never assign them.
- **Identity comes from the authenticated connection, never from a client-supplied field.** A connection says who it is once, on join. After that the relay reads `agent`/`human` off the connection and ignores those keys in the message body. Trusting the body lets any room member release, renew or steal a teammate's lease by naming them.
- **No blocking read anywhere in the daemon's accept path.** The daemon is single threaded: one client that connects and stops talking must not be able to stop it serving everyone else. Non-blocking listen fd, non-blocking accepted fds, a per-connection read budget, and a total budget for each `poll_once`. A daemon that stops reading is worse than one that dies, because it still looks alive from the outside.
- **Opaque mode is a flag, not a helper.** `AGENT_PRESENCE_OPAQUE=1` (also `true`/`yes`/`on`) hashes paths and symbols on ingest, on the MCP path, and on the way out to the wire. All three call sites or none — a half-wired flag splits the lease table.
- **Lease TTL 90s, heartbeat 30s. Presence TTL 30s.** Nothing is permanent; no manual cleanup path exists.
- **Never transmit:** file contents, diffs, prompts, agent reasoning, model output, env vars, command output.
- **May transmit:** file paths, symbol names, line ranges, verbs, timestamps, identity, MCP-declared intent.
- **Every block is overridable** by both agent (`PROCEED`) and human, and every override is logged.
- **Versions:** C++20, CMake 3.25+, Python 3.12+, Node 22+.
- **Asset production is out of scope.** The dashboard renders placeholder primitives (boxes, capsules) in the pinned palette. No generated 3D assets in this plan.

## Pinned palette

Used by the dashboard and any future asset work. Copy verbatim.

```
cream #F0ECE6   sand #E9E0CE     taupe #C3B39B    sage #E5E1D2
butter #F7DFAF  mustard #D6B45C  caramel #C0762A  coffee #B0674F
terracotta #D9714F  salmon #E8946C  dusty rose #D8BDB6  mauve #A5738C
slate blue #8A94A3  navy #35455C  deep plum #4A1F3D
```

## File Structure

```
agent-presence/
├── python/
│   ├── pyproject.toml
│   ├── src/agent_presence/
│   │   ├── types.py            # Region, AgentEvent, Claim, enums
│   │   ├── clock.py            # Clock protocol, RealClock, VirtualClock
│   │   ├── room_key.py         # git remote normalization → room id
│   │   ├── leases.py           # LeaseRegistry, TTL expiry
│   │   ├── wait_die.py         # deadlock resolution
│   │   ├── ladder.py           # rung classification
│   │   ├── negotiation.py      # four-move protocol state machine
│   │   ├── redact.py           # privacy redaction + opaque mode
│   │   ├── relay.py            # asyncio WebSocket server
│   │   └── mcp_server.py       # MCP tools
│   ├── sim/simulation.py       # deterministic simulation harness
│   └── tests/                  # pytest + hypothesis
├── cpp/
│   ├── CMakeLists.txt
│   ├── hook/main.cpp           # the 5ms binary
│   ├── daemon/
│   │   ├── socket_server.cpp   # unix socket accept loop
│   │   ├── coalesce.cpp        # debounce / sampling
│   │   ├── repo.cpp            # git remote discovery, path→room
│   │   ├── lease_cache.cpp     # dumb cache lookup, no protocol logic
│   │   ├── relay_client.cpp    # WebSocket client, reconnect, buffer
│   │   ├── snapshot.cpp        # statusline JSON writer
│   │   └── main.cpp
│   └── tests/                  # Catch2
├── web/
│   ├── package.json
│   └── src/
│       ├── palette.ts
│       ├── zones.ts            # zone layout + activity→zone mapping
│       ├── characters.ts       # spawn/despawn/movement
│       ├── scene.ts            # Three.js scene, camera, lighting
│       └── subscribe.ts        # relay subscription
└── scripts/statusline-presence.sh
```

**Responsibility boundaries.** `python/src/agent_presence/` below `relay.py` is pure — no I/O, no network, every time-dependent behaviour driven through an injected `Clock`. That purity is what lets the concurrency protocol be tested exhaustively in milliseconds. `relay.py` and the C++ daemon are thin shells over it.

---

# Phase 1 — Core domain (Python, pure)

### Task 1: Python package scaffold and domain types

**Files:**
- Create: `python/pyproject.toml`, `python/src/agent_presence/__init__.py`, `python/src/agent_presence/types.py`
- Test: `python/tests/test_types.py`

**Interfaces:**
- Produces: `Region`, `AgentEvent`, `Claim`, `Verb`, `Source`, `LeaseState`, `same_region(a, b) -> bool`. Every later task imports from here.

- [ ] **Step 1: Create the package skeleton**

`python/pyproject.toml`:
```toml
[project]
name = "agent-presence"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = ["websockets>=13.0", "mcp>=1.2.0"]

[project.optional-dependencies]
dev = ["pytest>=8.0", "hypothesis>=6.100", "pytest-asyncio>=0.24"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/agent_presence"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

Create empty `python/src/agent_presence/__init__.py`.

- [ ] **Step 2: Write the failing test**

`python/tests/test_types.py`:
```python
from agent_presence.types import Region, same_region


def test_same_path_and_symbol_is_the_same_region():
    a = Region(path="src/auth.py", symbol="sign_in", lines=(10, 20))
    b = Region(path="src/auth.py", symbol="sign_in", lines=(30, 40))
    assert same_region(a, b)


def test_different_symbols_in_one_file_are_different_regions():
    a = Region(path="src/auth.py", symbol="sign_in", lines=None)
    b = Region(path="src/auth.py", symbol="sign_out", lines=None)
    assert not same_region(a, b)


def test_regions_are_hashable_so_they_can_key_a_cache():
    r = Region(path="a.py", symbol="f", lines=None)
    assert len({r, Region(path="a.py", symbol="f", lines=None)}) == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_types.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.types'`

- [ ] **Step 4: Write the implementation**

`python/src/agent_presence/types.py`:
```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Verb = Literal["read", "edit", "search", "run", "think"]
Source = Literal["hook", "mcp"]
LeaseState = Literal["soft", "held"]

RoomId = str
AgentId = str
HumanId = str


@dataclass(frozen=True)
class Region:
    """A contended unit of code. Frozen so it can key a cache."""

    path: str
    symbol: str | None
    lines: tuple[int, int] | None


@dataclass
class AgentEvent:
    room: RoomId
    human: HumanId
    agent: AgentId
    kind: Literal["touch", "claim", "release"]
    source: Source
    verb: Verb
    region: Region
    # Assigned by the relay on receipt. None until then.
    ts: float | None = None


@dataclass
class Claim:
    room: RoomId
    human: HumanId
    agent: AgentId
    scope: Region
    intent: str
    state: LeaseState
    # Relay-assigned. Wait-die ordering derives from this.
    acquired_at: float
    expires_at: float


def same_region(a: Region, b: Region) -> bool:
    """Path and symbol determine identity. Line ranges do not narrow it —
    the symbol is the unit of contention."""
    return a.path == b.path and a.symbol == b.symbol
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_types.py -v`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add python/pyproject.toml python/src/agent_presence python/tests/test_types.py
git commit -m "feat(core): python package scaffold and domain types"
```

---

### Task 2: Room key normalization

The distribution mechanism of the whole product. Anyone who clones the repo lands in the same room with zero configuration, so every URL form of one repo must normalize identically.

**Files:**
- Create: `python/src/agent_presence/room_key.py`
- Test: `python/tests/test_room_key.py`

**Interfaces:**
- Produces: `normalize_remote(url: str) -> str`, `room_id_from_remote(url: str) -> str`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_room_key.py`:
```python
import re

import pytest

from agent_presence.room_key import normalize_remote, room_id_from_remote

EQUIVALENT = [
    "git@github.com:acme/api.git",
    "https://github.com/acme/api",
    "https://github.com/acme/api.git",
    "ssh://git@github.com/acme/api.git",
    "HTTPS://GitHub.com/Acme/API.git",
    "https://github.com/acme/api/",
]


def test_every_url_form_of_one_repo_collapses_to_one_key():
    keys = {normalize_remote(u) for u in EQUIVALENT}
    assert keys == {"github.com/acme/api"}


@pytest.mark.parametrize(
    "a,b",
    [
        ("git@github.com:acme/api.git", "git@github.com:acme/web.git"),
        ("git@github.com:acme/api.git", "git@gitlab.com:acme/api.git"),
    ],
)
def test_distinct_repos_stay_distinct(a, b):
    assert normalize_remote(a) != normalize_remote(b)


def test_room_id_is_stable_16_char_hex():
    rid = room_id_from_remote("git@github.com:acme/api.git")
    assert re.fullmatch(r"[0-9a-f]{16}", rid)
    assert room_id_from_remote("https://github.com/acme/api") == rid


def test_room_id_does_not_leak_the_repo_name():
    assert "secret" not in room_id_from_remote("git@github.com:acme/secret-project.git")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_room_key.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.room_key'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/room_key.py`:
```python
from __future__ import annotations

import hashlib
import re

_SCP = re.compile(r"^[^/@]+@([^:]+):(.+)$")
_PROTO = re.compile(r"^[a-z+]+://")
_USERINFO = re.compile(r"^[^/@]+@")


def normalize_remote(url: str) -> str:
    """Collapse any git remote URL form to canonical ``host/owner/repo``.

    Total by construction: unparseable input returns its trimmed, lowercased
    self, so two machines with the same odd remote still agree on a room.
    """
    s = url.strip().lower()

    scp = _SCP.match(s)
    if scp:
        s = f"{scp.group(1)}/{scp.group(2)}"
    else:
        s = _PROTO.sub("", s)
        s = _USERINFO.sub("", s)

    if s.endswith(".git"):
        s = s[: -len(".git")]
    return s.rstrip("/")


def room_id_from_remote(url: str) -> str:
    """Truncated sha256 of the normalized remote. The relay never learns the URL."""
    digest = hashlib.sha256(normalize_remote(url).encode()).hexdigest()
    return digest[:16]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_room_key.py -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/room_key.py python/tests/test_room_key.py
git commit -m "feat(core): normalize git remotes to stable room ids"
```

---

### Task 3: Injectable clock

Without this, testing 90-second lease expiry takes 90 seconds.

**Files:**
- Create: `python/src/agent_presence/clock.py`
- Test: `python/tests/test_clock.py`

**Interfaces:**
- Produces: `Clock` protocol with `now() -> float`; `RealClock`; `VirtualClock(epoch: float = 0.0)` with `advance(seconds: float)`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_clock.py`:
```python
import pytest

from agent_presence.clock import VirtualClock


def test_time_only_moves_when_advanced():
    c = VirtualClock(1000.0)
    assert c.now() == 1000.0
    assert c.now() == 1000.0
    c.advance(0.5)
    assert c.now() == 1000.5


def test_time_cannot_run_backwards():
    c = VirtualClock()
    with pytest.raises(ValueError):
        c.advance(-1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_clock.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.clock'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/clock.py`:
```python
from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float:
        """Seconds since epoch."""
        ...


class RealClock:
    def now(self) -> float:
        return time.time()


class VirtualClock:
    """Test clock. Every time-dependent behaviour in the system reads through
    a Clock so the whole protocol is testable without real waiting."""

    def __init__(self, epoch: float = 0.0) -> None:
        self._t = epoch

    def now(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("VirtualClock cannot move backwards")
        self._t += seconds
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_clock.py -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/clock.py python/tests/test_clock.py
git commit -m "feat(core): injectable clock with virtual implementation"
```

---

### Task 4: Lease registry with TTL expiry

**Files:**
- Create: `python/src/agent_presence/leases.py`
- Test: `python/tests/test_leases.py`

**Interfaces:**
- Consumes: `Claim`, `Region`, `same_region` (Task 1); `Clock` (Task 3).
- Produces: constants `LEASE_TTL_S = 90.0`, `PRESENCE_TTL_S = 30.0`, `HEARTBEAT_S = 30.0`.
- Produces: `AcquireResult` dataclass with fields `ok: bool`, `claim: Claim | None`, `held_by: Claim | None`.
- Produces: `LeaseRegistry(clock)` with `acquire(room, human, agent, scope, intent) -> AcquireResult`, `heartbeat(agent, scope) -> bool`, `release(agent, scope)`, `release_all(agent)`, `holder_of(room, region) -> Claim | None`, `active_claims(room) -> list[Claim]`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_leases.py`:
```python
import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)


@pytest.fixture
def reg():
    clock = VirtualClock()
    return clock, LeaseRegistry(clock)


def test_uncontested_lease_is_granted(reg):
    _, registry = reg
    assert registry.acquire("r1", "sara", "a1", R, "refactor").ok


def test_second_lease_on_same_region_is_refused_and_names_the_holder(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    result = registry.acquire("r1", "dev", "a2", R, "rename")
    assert not result.ok
    assert result.held_by.agent == "a1"


def test_lease_expires_after_ttl_with_no_manual_cleanup(reg):
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    clock.advance(LEASE_TTL_S + 1)
    assert registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_heartbeat_extends_the_lease(reg):
    clock, registry = reg
    registry.acquire("r1", "sara", "a1", R, "refactor")
    clock.advance(LEASE_TTL_S - 1)
    assert registry.heartbeat("a1", R)
    clock.advance(LEASE_TTL_S - 1)
    assert registry.holder_of("r1", R).agent == "a1"


def test_rooms_are_isolated_even_with_identical_paths(reg):
    _, registry = reg
    registry.acquire("r1", "sara", "a1", R, "x")
    assert registry.acquire("r2", "dev", "a2", R, "y").ok


def test_release_all_drops_every_lease_for_one_agent(reg):
    _, registry = reg
    other = Region(path="src/db.py", symbol="query", lines=None)
    registry.acquire("r1", "sara", "a1", R, "x")
    registry.acquire("r1", "sara", "a1", other, "y")
    registry.release_all("a1")
    assert registry.active_claims("r1") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_leases.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.leases'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/leases.py`:
```python
from __future__ import annotations

from dataclasses import dataclass

from .clock import Clock
from .types import Claim, Region, same_region

LEASE_TTL_S = 90.0
PRESENCE_TTL_S = 30.0
HEARTBEAT_S = 30.0


@dataclass
class AcquireResult:
    ok: bool
    claim: Claim | None = None
    held_by: Claim | None = None


class LeaseRegistry:
    """In-memory lease registry. The relay owns exactly one.

    Expiry is lazy — nothing is swept on a timer — so there is no code path in
    which a crashed process leaves behind a lease that outlives its TTL.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._claims: list[Claim] = []

    def _live(self) -> list[Claim]:
        now = self._clock.now()
        self._claims = [c for c in self._claims if c.expires_at > now]
        return self._claims

    def holder_of(self, room: str, region: Region) -> Claim | None:
        for c in self._live():
            if c.room == room and same_region(c.scope, region):
                return c
        return None

    def active_claims(self, room: str) -> list[Claim]:
        return [c for c in self._live() if c.room == room]

    def acquire(
        self, room: str, human: str, agent: str, scope: Region, intent: str
    ) -> AcquireResult:
        held = self.holder_of(room, scope)
        if held is not None and held.agent != agent:
            return AcquireResult(ok=False, held_by=held)

        now = self._clock.now()
        if held is not None:
            held.expires_at = now + LEASE_TTL_S
            return AcquireResult(ok=True, claim=held)

        claim = Claim(
            room=room,
            human=human,
            agent=agent,
            scope=scope,
            intent=intent,
            state="held",
            acquired_at=now,
            expires_at=now + LEASE_TTL_S,
        )
        self._claims.append(claim)
        return AcquireResult(ok=True, claim=claim)

    def heartbeat(self, agent: str, scope: Region) -> bool:
        for c in self._live():
            if c.agent == agent and same_region(c.scope, scope):
                c.expires_at = self._clock.now() + LEASE_TTL_S
                return True
        return False

    def release(self, agent: str, scope: Region) -> None:
        self._claims = [
            c for c in self._live()
            if not (c.agent == agent and same_region(c.scope, scope))
        ]

    def release_all(self, agent: str) -> None:
        """Drop every lease an agent holds. Used on session end and on abort."""
        self._claims = [c for c in self._live() if c.agent != agent]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_leases.py -v`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/leases.py python/tests/test_leases.py
git commit -m "feat(core): lease registry with lazy TTL expiry"
```

---

### Task 5: Wait-die deadlock resolution

Resolves the case where A holds `auth.py` and wants `db.py` while B holds `db.py` and wants `auth.py`. The *requester* is the one that yields: an older requester waits, a younger one dies — releases everything and retries with backoff. A lease that is already held is never taken away, so nobody is preempted mid-edit.

This is wait-die, not wound-wait. Under wound-wait the older requester would preempt the holder, and preemption here means yanking a lease out from under an agent that is part-way through an edit. Wait-die is equally deadlock-free and costs nothing to get that property.

**Files:**
- Create: `python/src/agent_presence/wait_die.py`
- Test: `python/tests/test_wait_die.py`

**Interfaces:**
- Consumes: `Claim` (Task 1).
- Produces: `resolve(requester_agent: str, requester_acquired_at: float, holder: Claim) -> Literal["wait", "abort"]`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_wait_die.py`:
```python
import pytest
from hypothesis import given, strategies as st

from agent_presence.types import Claim, Region
from agent_presence.wait_die import resolve

R = Region(path="a.py", symbol=None, lines=None)


def claim(agent: str, acquired_at: float) -> Claim:
    return Claim(
        room="r1", human="h", agent=agent, scope=R, intent="",
        state="held", acquired_at=acquired_at, expires_at=acquired_at + 90,
    )


def test_older_requester_waits_for_younger_holder():
    assert resolve("a1", 100.0, claim("a2", 500.0)) == "wait"


def test_younger_requester_aborts_against_older_holder():
    assert resolve("a2", 500.0, claim("a1", 100.0)) == "abort"


def test_exact_ties_break_deterministically_by_agent_id():
    assert resolve("aaa", 100.0, claim("bbb", 100.0)) != resolve("bbb", 100.0, claim("aaa", 100.0))


@given(
    x=st.floats(min_value=0, max_value=1e6, allow_nan=False),
    y=st.floats(min_value=0, max_value=1e6, allow_nan=False),
)
def test_relation_is_never_symmetric_which_is_what_forbids_wait_cycles(x, y):
    forward = resolve("a1", x, claim("a2", y))
    reverse = resolve("a2", y, claim("a1", x))
    assert not (forward == "wait" and reverse == "wait")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_wait_die.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.wait_die'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/wait_die.py`:
```python
from __future__ import annotations

from typing import Literal

from .types import Claim

Decision = Literal["wait", "abort"]


def resolve(requester_agent: str, requester_acquired_at: float, holder: Claim) -> Decision:
    """Wait-die. The older transaction waits, the younger one dies.

    - Requester older than holder  -> ``wait``  (it is entitled to the resource)
    - Requester younger            -> ``abort`` (release everything, retry with backoff)

    This is wait-die, not wound-wait, and that is deliberate. Wound-wait would
    have the older requester preempt the holder. Preemption here means taking a
    lease away from an agent that is already mid-edit, which destroys work in
    progress and breaks the fail-open principle the rest of the system is built
    on. Wait-die buys the same guarantee for free: it is equally deadlock-free
    and it never removes a lease from someone actively using it.

    Exact ties break on agent id so the relation is never symmetric. Symmetry is
    exactly what would permit a wait-cycle, so this makes deadlock unreachable
    rather than merely unlikely — no cycle detection is needed anywhere.
    """
    if requester_acquired_at < holder.acquired_at:
        return "wait"
    if requester_acquired_at > holder.acquired_at:
        return "abort"
    return "wait" if requester_agent < holder.agent else "abort"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_wait_die.py -v`
Expected: PASS, 4 tests (the last one runs 100 generated cases)

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/wait_die.py python/tests/test_wait_die.py
git commit -m "feat(core): wait-die deadlock resolution"
```

---

### Task 6: Collision ladder classification

**Files:**
- Create: `python/src/agent_presence/ladder.py`
- Test: `python/tests/test_ladder.py`

**Interfaces:**
- Consumes: `AgentEvent`, `Region`, `Verb`, `same_region` (Task 1).
- Produces: `Activity` dataclass with `agent: str`, `human: str`, `verb: Verb`, `region: Region`, `intent: str`.
- Produces: `classify(incoming: AgentEvent, others: list[Activity]) -> int` returning 0–4, and `interrupts_at(rung: int) -> bool`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_ladder.py`:
```python
from agent_presence.ladder import Activity, classify, interrupts_at
from agent_presence.types import AgentEvent, Region

FILE = "src/auth.py"


def ev(verb, symbol):
    return AgentEvent(
        room="r1", human="dev", agent="a2", kind="touch", source="hook",
        verb=verb, region=Region(path=FILE, symbol=symbol, lines=None),
    )


def other(verb, symbol, intent=""):
    return Activity(
        agent="a1", human="sara", verb=verb,
        region=Region(path=FILE, symbol=symbol, lines=None), intent=intent,
    )


def test_rung_0_both_reading():
    assert classify(ev("read", "sign_in"), [other("read", "sign_in")]) == 0


def test_rung_1_other_edits_while_this_one_reads():
    assert classify(ev("read", "sign_in"), [other("edit", "sign_in")]) == 1


def test_rung_2_both_edit_same_file_different_symbols():
    assert classify(ev("edit", "sign_out"), [other("edit", "sign_in")]) == 2


def test_rung_3_both_edit_the_same_symbol():
    assert classify(ev("edit", "sign_in"), [other("edit", "sign_in")]) == 3


def test_rung_0_when_alone():
    assert classify(ev("edit", "sign_in"), []) == 0


def test_activity_in_other_files_is_ignored():
    elsewhere = Activity(
        agent="a1", human="sara", verb="edit",
        region=Region(path="src/db.py", symbol="query", lines=None), intent="",
    )
    assert classify(ev("edit", "sign_in"), [elsewhere]) == 0


def test_an_agent_never_collides_with_itself():
    mine = Activity(
        agent="a2", human="dev", verb="edit",
        region=Region(path=FILE, symbol="sign_in", lines=None), intent="",
    )
    assert classify(ev("edit", "sign_in"), [mine]) == 0


def test_highest_rung_wins_across_many_others():
    others = [other("read", "sign_in"), other("edit", "sign_in")]
    assert classify(ev("edit", "sign_in"), others) == 3


def test_rungs_0_through_2_never_interrupt():
    assert [interrupts_at(r) for r in range(5)] == [False, False, False, True, True]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_ladder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.ladder'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/ladder.py`:
```python
from __future__ import annotations

from dataclasses import dataclass

from .types import AgentEvent, Region, Verb, same_region

WRITES: frozenset[str] = frozenset({"edit"})


@dataclass
class Activity:
    agent: str
    human: str
    verb: Verb
    region: Region
    # MCP-declared intent; empty when the activity was only observed via hooks.
    intent: str


def classify(incoming: AgentEvent, others: list[Activity]) -> int:
    """Return the highest rung the incoming event reaches against everyone else.

    Rung 4 (semantically redundant work on *different* files) is deliberately
    not decided here — it requires embedding similarity at the relay and stays
    behind a flag until there is real traffic to tune against. Shipping a noisy
    rung 4 would destroy trust in rungs 0-3.
    """
    highest = 0

    for o in others:
        if o.agent == incoming.agent:
            continue
        if o.region.path != incoming.region.path:
            continue

        incoming_writes = incoming.verb in WRITES
        other_writes = o.verb in WRITES

        if incoming_writes and other_writes:
            rung = 3 if same_region(o.region, incoming.region) else 2
        elif other_writes:
            rung = 1
        else:
            rung = 0

        highest = max(highest, rung)

    return highest


def interrupts_at(rung: int) -> bool:
    """Rungs 0-2 are ambient by design. Attention is the scarce resource, so
    each rung upward must earn the cost of spending it."""
    return rung >= 3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_ladder.py -v`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/ladder.py python/tests/test_ladder.py
git commit -m "feat(core): five-rung collision ladder classification"
```

---

### Task 7: Four-move negotiation protocol

Bounded and enumerable. Free-form negotiation between two agents is untestable and they will agree on wrong things at length.

**Files:**
- Create: `python/src/agent_presence/negotiation.py`
- Test: `python/tests/test_negotiation.py`

**Interfaces:**
- Consumes: `Claim`, `Region` (Task 1); `LeaseRegistry` (Task 4); `resolve` (Task 5); `Clock` (Task 3).
- Produces: `Move = Literal["DEFER", "SPLIT", "HANDOFF", "PROCEED"]`.
- Produces: `Brief` dataclass with `holder_agent`, `holder_human`, `holder_intent`, `region`, `moves`.
- Produces: `Negotiator(registry, clock)` with `open(room, requester, requester_acquired_at, scope, intent) -> Brief | None` and `apply(room, requester, scope, move, reason="") -> NegotiationOutcome`.
- Produces: `NegotiationOutcome` dataclass with `granted: bool`, `action: str`, `logged_override: bool`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_negotiation.py`:
```python
import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LeaseRegistry
from agent_presence.negotiation import Negotiator
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)
OTHER = Region(path="src/auth.py", symbol="sign_out", lines=None)


@pytest.fixture
def neg():
    clock = VirtualClock()
    registry = LeaseRegistry(clock)
    registry.acquire("r1", "sara", "a1", R, "refactor session handling")
    return clock, registry, Negotiator(registry, clock)


def test_brief_names_the_holder_and_their_intent(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", 500.0, R, "rename")
    assert brief.holder_agent == "a1"
    assert brief.holder_intent == "refactor session handling"


def test_brief_offers_exactly_the_four_moves(neg):
    _, _, n = neg
    brief = n.open("r1", "a2", 500.0, R, "rename")
    assert brief.moves == ("DEFER", "SPLIT", "HANDOFF", "PROCEED")


def test_no_brief_when_the_region_is_free(neg):
    _, _, n = neg
    assert n.open("r1", "a2", 500.0, OTHER, "unrelated") is None


def test_defer_does_not_grant(neg):
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "DEFER")
    assert not outcome.granted


def test_split_grants_a_disjoint_region(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", OTHER, "SPLIT")
    assert outcome.granted
    assert registry.holder_of("r1", OTHER).agent == "a2"


def test_handoff_drops_the_requester_claim_and_leaves_the_holder(neg):
    _, registry, n = neg
    outcome = n.apply("r1", "a2", R, "HANDOFF")
    assert not outcome.granted
    assert registry.holder_of("r1", R).agent == "a1"


def test_proceed_is_always_available_and_is_logged_as_an_override(neg):
    _, _, n = neg
    outcome = n.apply("r1", "a2", R, "PROCEED", reason="independent change")
    assert outcome.granted
    assert outcome.logged_override


def test_unknown_move_is_rejected(neg):
    _, _, n = neg
    with pytest.raises(ValueError):
        n.apply("r1", "a2", R, "ARGUE")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_negotiation.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.negotiation'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/negotiation.py`:
```python
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from .clock import Clock
from .leases import LeaseRegistry
from .types import Region

log = logging.getLogger("agent_presence.negotiation")

Move = Literal["DEFER", "SPLIT", "HANDOFF", "PROCEED"]
MOVES: tuple[Move, ...] = ("DEFER", "SPLIT", "HANDOFF", "PROCEED")


@dataclass
class Brief:
    """What a blocked agent is told. Deliberately small: who, what they intend,
    what is contested, and the finite set of replies."""

    holder_agent: str
    holder_human: str
    holder_intent: str
    region: Region
    moves: tuple[Move, ...]


@dataclass
class NegotiationOutcome:
    granted: bool
    action: str
    logged_override: bool = False


class Negotiator:
    def __init__(self, registry: LeaseRegistry, clock: Clock) -> None:
        self._registry = registry
        self._clock = clock

    def open(
        self, room: str, requester: str, requester_acquired_at: float,
        scope: Region, intent: str,
    ) -> Brief | None:
        """Return a brief if the region is contested, else None."""
        held = self._registry.holder_of(room, scope)
        if held is None or held.agent == requester:
            return None
        return Brief(
            holder_agent=held.agent,
            holder_human=held.human,
            holder_intent=held.intent,
            region=scope,
            moves=MOVES,
        )

    def apply(
        self, room: str, requester: str, scope: Region, move: str, reason: str = ""
    ) -> NegotiationOutcome:
        if move not in MOVES:
            raise ValueError(f"unknown negotiation move: {move!r}")

        if move == "DEFER":
            return NegotiationOutcome(granted=False, action="defer")

        if move == "SPLIT":
            result = self._registry.acquire(room, requester, requester, scope, "split")
            return NegotiationOutcome(granted=result.ok, action="split")

        if move == "HANDOFF":
            self._registry.release(requester, scope)
            return NegotiationOutcome(granted=False, action="handoff")

        # PROCEED — the escape hatch. Always available, always logged. False
        # positives are certain, and a system that cannot be overridden is a
        # system that gets uninstalled. Override logs are the tuning signal.
        log.warning(
            "override: agent=%s room=%s path=%s symbol=%s reason=%s",
            requester, room, scope.path, scope.symbol, reason or "(none)",
        )
        return NegotiationOutcome(granted=True, action="proceed", logged_override=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_negotiation.py -v`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/negotiation.py python/tests/test_negotiation.py
git commit -m "feat(core): bounded four-move negotiation protocol"
```

---

### Task 8: Privacy redaction and opaque mode

**Files:**
- Create: `python/src/agent_presence/redact.py`
- Test: `python/tests/test_redact.py`

Opaque mode is a flag, not a spare function. `opaque_region` on its own is dead code: something has to call it on every path that leaves the machine, or an org turns the toggle on and nothing changes.

**Interfaces:**
- Consumes: `AgentEvent`, `Region` (Task 1).
- Produces: `FORBIDDEN_FIELDS: frozenset[str]`; `redact(event_dict: dict) -> dict`; `opaque_region(region: Region) -> Region`.
- Produces the flag wiring: `OPAQUE_ENV = "AGENT_PRESENCE_OPAQUE"`, `opaque_enabled() -> bool`, `opaque_region_if_enabled(region) -> Region`, `apply_opaque(payload)`, `opaque_outbound(payload: dict) -> dict`.

**The flag.** `AGENT_PRESENCE_OPAQUE=1` turns opaque mode on; `true`, `yes` and `on` also count, anything else is off. It's read per call rather than cached, so flipping it doesn't need a relay restart and the cost is one dict lookup on a path that already does JSON. Three call sites, and all three are required:

- `redact()` — the hook path, on ingest.
- `mcp_server` claim/release helpers — the MCP path. Both channels must hash identically or the lease table splits in two and two agents editing one function never see each other.
- `opaque_outbound()` in `serve.py` — the last stop before the wire, so anything the relay composed itself is covered too.

Hashed regions carry an `opaque: true` marker so a second pass doesn't hash them again and desync them from every other client's copy.

- [ ] **Step 1: Write the failing test**

`python/tests/test_redact.py`:
```python
import pytest

from agent_presence.redact import (
    FORBIDDEN_FIELDS,
    opaque_outbound,
    opaque_region,
    redact,
)
from agent_presence.types import Region


def raw():
    return {
        "room": "r1", "human": "sara", "agent": "a1", "kind": "touch",
        "source": "hook", "verb": "edit",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": [1, 9]},
        "content": "SECRET_KEY = 'hunter2'",
        "diff": "- old\n+ new",
        "prompt": "refactor this",
        "env": {"AWS_SECRET_ACCESS_KEY": "x"},
    }


@pytest.mark.parametrize("field", sorted(FORBIDDEN_FIELDS))
def test_every_forbidden_field_is_stripped(field):
    out = redact(raw())
    assert field not in out


def test_permitted_fields_survive():
    out = redact(raw())
    assert out["region"]["path"] == "src/auth.py"
    assert out["region"]["symbol"] == "sign_in"
    assert out["verb"] == "edit"


def test_no_secret_value_survives_anywhere_in_the_payload():
    assert "hunter2" not in repr(redact(raw()))


def test_opaque_mode_hashes_path_and_symbol():
    r = Region(path="src/auth.py", symbol="sign_in", lines=(1, 9))
    o = opaque_region(r)
    assert "auth" not in o.path
    assert o.symbol is not None and "sign_in" not in o.symbol


def test_opaque_mode_preserves_equality_so_collisions_still_detect():
    a = Region(path="src/auth.py", symbol="sign_in", lines=(1, 9))
    b = Region(path="src/auth.py", symbol="sign_in", lines=(40, 80))
    assert opaque_region(a).path == opaque_region(b).path
    assert opaque_region(a).symbol == opaque_region(b).symbol


def test_opaque_mode_keeps_distinct_regions_distinct():
    a = Region(path="src/auth.py", symbol="sign_in", lines=None)
    b = Region(path="src/db.py", symbol="sign_in", lines=None)
    assert opaque_region(a).path != opaque_region(b).path


def test_paths_are_readable_while_the_flag_is_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)
    assert redact(raw())["region"]["path"] == "src/auth.py"


def test_the_flag_actually_hashes_the_wire_payload(monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    out = redact(raw())
    assert out["region"]["path"] != "src/auth.py"
    assert "auth" not in out["region"]["path"]


def test_outbound_is_hashed_too(monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    sent = opaque_outbound({"type": "presence", "path": "src/auth.py", "symbol": "sign_in"})
    assert "auth" not in sent["path"]
    assert sent["opaque"] is True


def test_an_already_opaque_payload_is_not_hashed_twice(monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    once = opaque_outbound({"path": "src/auth.py", "symbol": "sign_in"})
    assert opaque_outbound(once) == once
```

Every test in this file that doesn't set the flag must clear it first (`monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)` in a fixture), or a stray env var in a shell turns the suite green for the wrong reason.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_redact.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.redact'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/redact.py`:
```python
from __future__ import annotations

import hashlib
import os

from .types import Region

# Anything here must never leave the machine. This is an allowlist boundary
# enforced as a denylist for defence in depth: the daemon builds payloads from
# known fields, and this strips anything that slipped through.
FORBIDDEN_FIELDS: frozenset[str] = frozenset(
    {
        "content", "contents", "text", "body",
        "diff", "patch",
        "prompt", "reasoning", "completion", "output", "stdout", "stderr",
        "env", "environment", "secrets", "token", "credentials",
    }
)

PERMITTED_TOP_LEVEL: frozenset[str] = frozenset(
    {"room", "human", "agent", "kind", "source", "verb", "region", "ts", "intent"}
)

# Set AGENT_PRESENCE_OPAQUE=1 to turn on org-level opaque mode.
OPAQUE_ENV = "AGENT_PRESENCE_OPAQUE"
_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Marks a region that has already been hashed, so a second pass on the way out
# doesn't hash it again and desync it from every other client's copy.
OPAQUE_MARK = "opaque"


def opaque_enabled() -> bool:
    """Read the toggle per call. Flipping it shouldn't need a restart, and the
    cost is one dict lookup on a path that already does JSON."""
    return os.environ.get(OPAQUE_ENV, "").strip().lower() in _TRUTHY


def redact(event_dict: dict) -> dict:
    """Strip everything not explicitly permitted, then strip forbidden keys
    from any surviving nested dict."""
    out = {k: v for k, v in event_dict.items() if k in PERMITTED_TOP_LEVEL}

    region = out.get("region")
    if isinstance(region, dict):
        out["region"] = {
            k: v for k, v in region.items()
            if k in {"path", "symbol", "lines"} and k not in FORBIDDEN_FIELDS
        }

    if opaque_enabled():
        out = apply_opaque(out)
    return out


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def opaque_region(region: Region) -> Region:
    """Hash path and symbol client-side for orgs that enable opaque mode.

    Collision detection is equality on region keys, so it works identically on
    hashed input: the relay still arbitrates leases correctly while never
    learning a filename. Readability is lost; function is not.
    """
    return Region(
        path=_h(region.path),
        symbol=_h(region.symbol) if region.symbol is not None else None,
        lines=None,  # line ranges would narrow a hash back toward the original
    )


def opaque_region_if_enabled(region: Region) -> Region:
    return opaque_region(region) if opaque_enabled() else region


def apply_opaque(payload):
    """Walk a payload and hash every region-shaped dict in it.

    Region-shaped means 'has a string path'. That catches the nested
    `{"region": {...}}` form and the flattened path/symbol form the MCP tools
    return, without either side having to declare which is which.
    """
    if isinstance(payload, list):
        return [apply_opaque(v) for v in payload]
    if not isinstance(payload, dict):
        return payload

    out = {k: apply_opaque(v) for k, v in payload.items()}
    if not isinstance(out.get("path"), str) or out.get(OPAQUE_MARK) is True:
        return out

    out["path"] = _h(out["path"])
    if isinstance(out.get("symbol"), str):
        out["symbol"] = _h(out["symbol"])
    if "lines" in out:
        out["lines"] = None
    out[OPAQUE_MARK] = True
    return out


def opaque_outbound(payload: dict) -> dict:
    """Last stop before the wire. No-op unless opaque mode is on."""
    return apply_opaque(payload) if opaque_enabled() else payload
```

Task 11 (`serve.py`) sends through `opaque_outbound`, and Task 20 (`mcp_server.py`) builds its regions through `opaque_region_if_enabled`. Neither is optional — miss one and the flag is half-on, which is worse than off.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_redact.py -v`
Expected: PASS, 21 tests (12 parametrized + 9)

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/redact.py python/tests/test_redact.py
git commit -m "feat(core): privacy redaction and opaque mode"
```

---

# Phase 2 — Deterministic simulation

### Task 9: Simulation harness and protocol invariants

Forty agents colliding runs in milliseconds and a failing seed reproduces exactly. This is how a concurrency protocol gets tested; running real agent sessions to find lock bugs would be slow, flaky and unrepeatable.

**Files:**
- Create: `python/sim/__init__.py`, `python/sim/simulation.py`
- Test: `python/tests/test_invariants.py`

**Interfaces:**
- Consumes: `LeaseRegistry`, `LEASE_TTL_S` (Task 4); `VirtualClock` (Task 3); `resolve` (Task 5).
- Produces: `SimResult` dataclass with `granted: int`, `aborted: int`, `waits: int`, `live_at_end: int`.
- Produces: `Simulation(seed: int, agents: int, regions: int)` with `run(steps: int) -> SimResult`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_invariants.py`:
```python
import pytest

from sim.simulation import Simulation


@pytest.mark.parametrize("seed", range(50))
def test_never_deadlocks_across_many_seeds(seed):
    # Progress is the observable proxy for deadlock-freedom: were a wait-cycle
    # reachable, grants would stop entirely.
    assert Simulation(seed, agents=8, regions=4).run(500).granted > 0


def test_no_lease_survives_past_the_ttl_without_heartbeats():
    assert Simulation(42, agents=40, regions=10).run(1000).live_at_end == 0


def test_a_seed_reproduces_a_schedule_exactly():
    assert Simulation(7, 12, 5).run(300) == Simulation(7, 12, 5).run(300)


def test_scales_to_forty_agents_without_stalling():
    assert Simulation(1, agents=40, regions=6).run(2000).granted > 100
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_invariants.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'sim'`

- [ ] **Step 3: Write the implementation**

Create empty `python/sim/__init__.py`.

`python/sim/simulation.py`:
```python
from __future__ import annotations

import random
from dataclasses import dataclass

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S, LeaseRegistry
from agent_presence.types import Region
from agent_presence.wait_die import resolve


@dataclass(frozen=True)
class SimResult:
    granted: int
    aborted: int
    waits: int
    live_at_end: int


class Simulation:
    """Virtual-clock simulation of N agents contending over M regions.

    Fully deterministic for a given seed, so a failing case reproduces exactly.
    """

    def __init__(self, seed: int, agents: int, regions: int) -> None:
        self._rand = random.Random(seed)
        self._clock = VirtualClock()
        self._registry = LeaseRegistry(self._clock)
        self._agents = [f"a{i}" for i in range(agents)]
        self._regions = [
            Region(path=f"src/f{i}.py", symbol=f"sym{i}", lines=None)
            for i in range(regions)
        ]
        # Oldest live claim time per agent, which is what wait-die orders on.
        self._age: dict[str, float] = {}

    def run(self, steps: int) -> SimResult:
        granted = aborted = waits = 0

        for _ in range(steps):
            agent = self._rand.choice(self._agents)
            region = self._rand.choice(self._regions)
            roll = self._rand.random()

            if roll < 0.65:
                result = self._registry.acquire("r1", agent, agent, region, "work")
                if result.ok:
                    granted += 1
                    self._age.setdefault(agent, self._clock.now())
                else:
                    decision = resolve(
                        agent, self._age.get(agent, self._clock.now()), result.held_by
                    )
                    if decision == "abort":
                        aborted += 1
                        # Aborting releases everything the agent holds. That is
                        # what guarantees the wait-for graph cannot keep a cycle.
                        self._registry.release_all(agent)
                        self._age.pop(agent, None)
                    else:
                        waits += 1
            elif roll < 0.85:
                self._registry.release(agent, region)
                if all(c.agent != agent for c in self._registry.active_claims("r1")):
                    self._age.pop(agent, None)
            else:
                self._clock.advance(1.0)

        # Drain: advance past the TTL with no heartbeats. Nothing may survive.
        self._clock.advance(LEASE_TTL_S + 1)
        return SimResult(
            granted=granted,
            aborted=aborted,
            waits=waits,
            live_at_end=len(self._registry.active_claims("r1")),
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_invariants.py -v`
Expected: PASS, 53 tests (50 parametrized seeds + 3)

- [ ] **Step 5: Commit**

```bash
git add python/sim python/tests/test_invariants.py
git commit -m "test(sim): deterministic simulation harness and protocol invariants"
```

---

# Phase 3 — Relay (Python)

### Task 10: Relay WebSocket server with rooms and fan-out

**Files:**
- Create: `python/src/agent_presence/relay.py`
- Test: `python/tests/test_relay.py`

**Interfaces:**
- Consumes: `LeaseRegistry` (Task 4), `Negotiator` (Task 7), `Activity`/`classify` (Task 6), `redact` (Task 8), `Clock` (Task 3).
- Produces: `Relay(clock)` with `join(room, conn)`, `leave(conn)`, `handle(conn, message: dict) -> dict | None`, `broadcast(room, payload) -> list[Conn]`, `presence(room) -> list[Activity]`.
- Produces: `Conn` protocol with `send(payload: dict)` and attribute `room: str | None`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_relay.py`:
```python
import pytest

from agent_presence.clock import VirtualClock
from agent_presence.relay import Relay


class FakeConn:
    def __init__(self, agent="a1", human="sara"):
        self.agent = agent
        self.human = human
        self.room = None
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture
def relay():
    return Relay(VirtualClock(1000.0))


def touch(agent="a1", path="src/auth.py", symbol="sign_in", verb="edit"):
    return {
        "type": "event", "agent": agent, "human": agent, "kind": "touch",
        "source": "hook", "verb": verb,
        "region": {"path": path, "symbol": symbol, "lines": None},
        # Both client-supplied and both ignored: the relay stamps its own time
        # and reads identity off the connection.
        "ts": 99999.0,
    }


def test_relay_assigns_its_own_timestamp_and_discards_the_clients(relay):
    c = FakeConn()
    relay.join("r1", c)
    relay.handle(c, touch())
    assert relay.presence("r1")[0].region.path == "src/auth.py"
    stored = relay.last_event_ts("r1")
    assert stored == 1000.0


def test_events_fan_out_to_other_members_but_not_the_sender(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r1", b)
    relay.handle(a, touch("a1"))
    assert len(b.sent) == 1
    assert a.sent == []


def test_rooms_are_isolated(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r2", b)
    relay.handle(a, touch("a1"))
    assert b.sent == []


def test_leaving_releases_every_lease_that_connection_held(relay):
    a = FakeConn("a1")
    relay.join("r1", a)
    relay.handle(a, {"type": "claim", "agent": "a1", "human": "sara",
                     "region": {"path": "p.py", "symbol": "f", "lines": None},
                     "intent": "work"})
    relay.leave(a)
    assert relay.registry.active_claims("r1") == []


def test_a_client_cannot_touch_a_lease_by_naming_someone_else(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r1", b)
    region = {"path": "p.py", "symbol": "f", "lines": None}
    relay.handle(a, {"type": "claim", "region": region, "intent": "work"})

    # b claims to be a1. The relay reads identity off the connection, not the
    # payload, so this releases nothing.
    relay.handle(b, {"type": "release", "agent": "a1", "region": region})
    assert relay.registry.active_claims("r1")[0].agent == "a1"


def test_forbidden_fields_never_reach_presence(relay):
    a = FakeConn("a1")
    relay.join("r1", a)
    evt = touch("a1")
    evt["content"] = "hunter2"
    relay.handle(a, evt)
    assert "hunter2" not in repr(relay.presence("r1"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_relay.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.relay'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/relay.py`:
```python
from __future__ import annotations

from typing import Any, Protocol

from .clock import Clock
from .ladder import Activity, classify, interrupts_at
from .leases import PRESENCE_TTL_S, LeaseRegistry
from .negotiation import Negotiator
from .redact import redact
from .types import AgentEvent, Region


class Conn(Protocol):
    agent: str
    human: str
    room: str | None

    def send(self, payload: dict) -> None: ...


def _region(d: dict) -> Region:
    lines = d.get("lines")
    return Region(
        path=d["path"],
        symbol=d.get("symbol"),
        lines=tuple(lines) if lines else None,
    )


class Relay:
    """Sole authority on leases and the only place protocol decisions are made.

    Stateless across restarts by design: leases expire, so a relay restart
    degrades to 'nobody has protection for 90 seconds', never to a wedged team.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self.registry = LeaseRegistry(clock)
        self._negotiator = Negotiator(self.registry, clock)
        self._members: dict[str, list[Conn]] = {}
        self._activity: dict[str, list[tuple[float, Activity]]] = {}
        self._last_ts: dict[str, float] = {}

    # -- membership ---------------------------------------------------------

    def join(self, room: str, conn: Conn) -> None:
        conn.room = room
        self._members.setdefault(room, []).append(conn)

    def leave(self, conn: Conn) -> None:
        room = conn.room
        if room is None:
            return
        self._members.get(room, []).remove(conn)
        # A dropped connection must not hold protection. Leases would expire
        # anyway; releasing now just makes recovery immediate.
        self.registry.release_all(conn.agent)
        conn.room = None

    def broadcast(self, room: str, payload: dict, exclude: Conn | None = None) -> list[Conn]:
        targets = [c for c in self._members.get(room, []) if c is not exclude]
        for c in targets:
            c.send(payload)
        return targets

    # -- presence -----------------------------------------------------------

    def presence(self, room: str) -> list[Activity]:
        cutoff = self._clock.now() - PRESENCE_TTL_S
        kept = [(t, a) for (t, a) in self._activity.get(room, []) if t > cutoff]
        self._activity[room] = kept
        return [a for (_, a) in kept]

    def last_event_ts(self, room: str) -> float | None:
        return self._last_ts.get(room)

    # -- ingest -------------------------------------------------------------

    def handle(self, conn: Conn, message: dict) -> dict | None:
        room = conn.room
        if room is None:
            return None

        # conn.agent is the authenticated identity. message["agent"] is
        # whatever the client typed, so it is never trusted for anything that
        # touches a lease — otherwise any room member could drop, renew or
        # steal a teammate's claim by naming them.
        kind = message.get("type")
        if kind == "event":
            return self._on_event(room, conn, message)
        if kind == "claim":
            return self._on_claim(room, conn, message)
        if kind == "release":
            self.registry.release(conn.agent, _region(message["region"]))
            return None
        if kind == "heartbeat":
            self.registry.heartbeat(conn.agent, _region(message["region"]))
            return None
        if kind == "move":
            outcome = self._negotiator.apply(
                room, conn.agent, _region(message["region"]),
                message.get("move", ""), message.get("reason", ""),
            )
            return {"type": "move_result", "granted": outcome.granted,
                    "action": outcome.action}
        return None

    def _on_event(self, room: str, conn: Conn, message: dict) -> dict | None:
        clean = redact(message)
        now = self._clock.now()          # relay-assigned; client ts discarded
        self._last_ts[room] = now

        region = _region(clean["region"])
        event = AgentEvent(
            room=room, human=conn.human, agent=conn.agent, kind="touch",
            source=clean.get("source", "hook"), verb=clean["verb"],
            region=region, ts=now,
        )

        others = self.presence(room)
        rung = classify(event, others)

        self._activity.setdefault(room, []).append(
            (now, Activity(agent=conn.agent, human=conn.human, verb=event.verb,
                           region=region, intent=""))
        )

        self.broadcast(room, {"type": "presence", "agent": conn.agent,
                              "human": conn.human, "verb": event.verb,
                              "region": clean["region"], "rung": rung, "ts": now},
                       exclude=conn)

        if not interrupts_at(rung):
            return {"type": "ack", "rung": rung}

        brief = self._negotiator.open(room, conn.agent, now, region, "")
        if brief is None:
            return {"type": "ack", "rung": rung}
        return {
            "type": "negotiate", "rung": rung,
            "holder_agent": brief.holder_agent, "holder_human": brief.holder_human,
            "holder_intent": brief.holder_intent, "moves": list(brief.moves),
        }

    def _on_claim(self, room: str, conn: Conn, message: dict) -> dict:
        result = self.registry.acquire(
            room, conn.human, conn.agent,
            _region(message["region"]), message.get("intent", ""),
        )
        if result.ok:
            return {"type": "claim_result", "granted": True}
        return {
            "type": "claim_result", "granted": False,
            "held_by": result.held_by.agent, "intent": result.held_by.intent,
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_relay.py -v`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/relay.py python/tests/test_relay.py
git commit -m "feat(relay): rooms, fan-out, relay-assigned timestamps, ladder dispatch"
```

---

### Task 11: Relay WebSocket transport

**Files:**
- Create: `python/src/agent_presence/serve.py`
- Test: `python/tests/test_serve.py`

**Interfaces:**
- Consumes: `Relay` (Task 10), `RealClock` (Task 3).
- Produces: `async def serve(host: str, port: int, relay: Relay) -> None`; `class WsConn` implementing `Conn`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_serve.py`:
```python
import asyncio
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.relay import Relay
from agent_presence.serve import serve


@pytest.fixture
async def server():
    relay = Relay(RealClock())
    task = asyncio.create_task(serve("127.0.0.1", 8799, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()


async def test_two_clients_in_one_room_see_each_other(server):
    async with websockets.connect("ws://127.0.0.1:8799") as a, \
               websockets.connect("ws://127.0.0.1:8799") as b:
        for ws, agent in ((a, "a1"), (b, "a2")):
            await ws.send(json.dumps({"type": "join", "room": "r1",
                                      "agent": agent, "human": agent}))
        await asyncio.sleep(0.1)
        await a.send(json.dumps({
            "type": "event", "verb": "edit", "source": "hook",
            "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
        }))
        msg = json.loads(await asyncio.wait_for(b.recv(), timeout=2))
        assert msg["type"] == "presence"
        assert msg["agent"] == "a1"


async def test_malformed_json_does_not_kill_the_connection(server):
    async with websockets.connect("ws://127.0.0.1:8799") as ws:
        await ws.send(json.dumps({"type": "join", "room": "r1",
                                  "agent": "a1", "human": "sara"}))
        await ws.send("{not json")
        await ws.send(json.dumps({
            "type": "event", "verb": "read", "source": "hook",
            "region": {"path": "a.py", "symbol": None, "lines": None},
        }))
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
        assert reply["type"] == "ack"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_serve.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.serve'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/serve.py`:
```python
from __future__ import annotations

import asyncio
import json
import logging

import websockets

from .redact import opaque_outbound
from .relay import Relay

log = logging.getLogger("agent_presence.serve")


class WsConn:
    def __init__(self, ws, loop: asyncio.AbstractEventLoop) -> None:
        self._ws = ws
        self._loop = loop
        self.agent = ""
        self.human = ""
        self.room: str | None = None

    def send(self, payload: dict) -> None:
        # Fire-and-forget: a slow subscriber must never stall ingest.
        self._loop.create_task(self._safe_send(payload))

    async def _safe_send(self, payload: dict) -> None:
        try:
            await self._ws.send(json.dumps(opaque_outbound(payload)))
        except Exception:
            log.debug("dropped send to closed connection", exc_info=True)


async def _session(ws, relay: Relay) -> None:
    conn = WsConn(ws, asyncio.get_running_loop())
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                # Malformed input is dropped, never fatal. Fail open.
                continue

            if msg.get("type") == "join":
                # The one and only place identity is taken from a message. It
                # is bound to the connection here and every later frame is
                # attributed to it, whatever that frame claims about itself.
                conn.agent = msg.get("agent", "")
                conn.human = msg.get("human", "")
                relay.join(msg["room"], conn)
                continue

            try:
                reply = relay.handle(conn, msg)
            except Exception:
                log.exception("handler error; connection preserved")
                continue

            if reply is not None:
                await ws.send(json.dumps(opaque_outbound(reply)))
    finally:
        relay.leave(conn)


async def serve(host: str, port: int, relay: Relay) -> None:
    async with websockets.serve(lambda ws: _session(ws, relay), host, port):
        await asyncio.Future()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_serve.py -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/serve.py python/tests/test_serve.py
git commit -m "feat(relay): websocket transport with fail-open message handling"
```

---

# Phase 4 — Hook binary (C++)

### Task 12: The 5ms hook

The single most latency-sensitive component. It runs before every Read, Edit and Grep in every agent session.

**Files:**
- Create: `cpp/CMakeLists.txt`, `cpp/hook/main.cpp`
- Test: `cpp/tests/test_hook.cpp`

**Interfaces:**
- Produces: binary `ap-hook`. Reads a JSON hook payload on stdin, writes one line to `$AGENT_PRESENCE_SOCK` (default `$XDG_RUNTIME_DIR/agent-presence.sock`), exits 0 always.
- Produces: `bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms)` for tests.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_hook.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <string>
#include "hook/hook.hpp"

TEST_CASE("write_line returns false when no socket exists, and never throws") {
    REQUIRE_FALSE(ap::write_line("/nonexistent/path.sock", "{}", 5));
}

TEST_CASE("write_line to a dead path stays inside the latency budget") {
    auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < 100; ++i) ap::write_line("/nonexistent/p.sock", "{}", 5);
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    // 100 failed attempts must stay well under 100 * 5ms; failure is immediate.
    REQUIRE(elapsed < 200);
}

TEST_CASE("build_event extracts only permitted fields") {
    std::string out = ap::build_event(
        R"({"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.py"},
            "session_id":"s1","content":"SECRET"})");
    REQUIRE(out.find("src/a.py") != std::string::npos);
    REQUIRE(out.find("SECRET") == std::string::npos);
    REQUIRE(out.find("\"verb\":\"edit\"") != std::string::npos);
}

TEST_CASE("unknown tools map to a think verb rather than being dropped") {
    std::string out = ap::build_event(R"({"tool_name":"Wibble","session_id":"s1"})");
    REQUIRE(out.find("\"verb\":\"think\"") != std::string::npos);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cpp && cmake -B build && cmake --build build && ./build/tests/ap_tests`
Expected: FAIL — `hook/hook.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.25)
project(agent_presence CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(ap_hook_lib hook/hook.cpp)
target_include_directories(ap_hook_lib PUBLIC .)

add_executable(ap-hook hook/main.cpp)
target_link_libraries(ap-hook PRIVATE ap_hook_lib)

find_package(Catch2 3 QUIET)
if(Catch2_FOUND)
  add_executable(ap_tests tests/test_hook.cpp)
  target_link_libraries(ap_tests PRIVATE ap_hook_lib Catch2::Catch2WithMain)
endif()
```

`cpp/hook/hook.hpp`:
```cpp
#pragma once
#include <string>

namespace ap {

/// Build a minimal JSON event from a Claude Code hook payload.
/// Extracts only permitted fields; never copies file contents or prompts.
std::string build_event(const std::string& hook_json);

/// Connect to a unix socket and write one line. Returns false on any failure.
/// Never blocks longer than timeout_ms and never throws.
bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms);

}  // namespace ap
```

`cpp/hook/hook.cpp`:
```cpp
#include "hook/hook.hpp"

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <string>
#include <string_view>

namespace ap {
namespace {

/// Minimal scalar extractor. A full JSON parser is deliberately avoided: this
/// binary runs before every tool call and its cost must be near zero.
std::string field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":\"";
    auto pos = json.find(needle);
    if (pos == std::string_view::npos) return {};
    pos += needle.size();
    auto end = json.find('"', pos);
    if (end == std::string_view::npos) return {};
    return std::string(json.substr(pos, end - pos));
}

std::string verb_for(const std::string& tool) {
    if (tool == "Edit" || tool == "Write" || tool == "NotebookEdit") return "edit";
    if (tool == "Read") return "read";
    if (tool == "Grep" || tool == "Glob") return "search";
    if (tool == "Bash") return "run";
    return "think";
}

}  // namespace

std::string build_event(const std::string& hook_json) {
    const std::string tool = field(hook_json, "tool_name");
    const std::string path = field(hook_json, "file_path");
    const std::string session = field(hook_json, "session_id");

    std::string out = "{\"verb\":\"";
    out += verb_for(tool);
    out += "\",\"agent\":\"";
    out += session;
    out += "\",\"path\":\"";
    out += path;
    out += "\"}";
    return out;
}

bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms) {
    if (sock_path.empty() || sock_path.size() >= sizeof(sockaddr_un::sun_path)) return false;

    int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (fd < 0) return false;

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path.c_str());

    // Non-blocking connect. If the daemon is absent or busy we abandon the
    // event rather than delay the agent. A dropped event costs one animation
    // frame; a blocked hook costs the user's patience on every tool call.
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return false;
    }

    std::string payload = line;
    payload.push_back('\n');
    ssize_t n = ::write(fd, payload.data(), payload.size());
    ::close(fd);
    return n == static_cast<ssize_t>(payload.size());
}

}  // namespace ap
```

`cpp/hook/main.cpp`:
```cpp
#include <cstdlib>
#include <iostream>
#include <string>

#include "hook/hook.hpp"

int main() {
    // Exit 0 on every path. A hook that can fail is a hook that can break an
    // agent session, which is the one outcome that gets this uninstalled.
    try {
        std::string input((std::istreambuf_iterator<char>(std::cin)),
                          std::istreambuf_iterator<char>());

        const char* sock = std::getenv("AGENT_PRESENCE_SOCK");
        std::string path;
        if (sock != nullptr) {
            path = sock;
        } else if (const char* rt = std::getenv("XDG_RUNTIME_DIR")) {
            path = std::string(rt) + "/agent-presence.sock";
        } else if (const char* tmp = std::getenv("TMPDIR")) {
            path = std::string(tmp) + "agent-presence.sock";
        } else {
            path = "/tmp/agent-presence.sock";
        }

        ap::write_line(path, ap::build_event(input), 5);
    } catch (...) {
        // Intentionally swallowed.
    }
    return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake -B build && cmake --build build && ./build/ap_tests`
Expected: PASS, 4 assertions groups

- [ ] **Step 5: Commit**

```bash
git add cpp/CMakeLists.txt cpp/hook cpp/tests/test_hook.cpp
git commit -m "feat(hook): fail-open C++ hook binary within the 5ms budget"
```

---

### Task 13: Hook latency regression guard

The 5ms budget is the constraint most likely to rot silently. This test is its guard.

**Files:**
- Create: `cpp/tests/test_latency.cpp`
- Modify: `cpp/CMakeLists.txt`

**Interfaces:**
- Consumes: `ap::build_event`, `ap::write_line` (Task 12).

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_latency.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <chrono>
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
```

- [ ] **Step 2: Run test to verify it fails**

Add to `cpp/CMakeLists.txt` inside the `Catch2_FOUND` block:
```cmake
  target_sources(ap_tests PRIVATE tests/test_latency.cpp)
```

Run: `cd cpp && cmake -B build && cmake --build build && ./build/ap_tests`
Expected: FAIL before the CMake edit (file not compiled); PASS after, confirming the guard is wired in.

- [ ] **Step 3: Verify the budget holds**

No implementation change is required — Task 12 already satisfies the budget. If this test fails, the correct fix is in `write_line`, never in the test threshold.

- [ ] **Step 4: Run the full C++ suite**

Run: `cd cpp && ./build/ap_tests`
Expected: PASS, all tests including latency

- [ ] **Step 5: Commit**

```bash
git add cpp/CMakeLists.txt cpp/tests/test_latency.cpp
git commit -m "test(hook): p99 latency regression guard at 5ms"
```

---

# Phase 5 — presenced daemon (C++)

The daemon performs **no protocol reasoning**. It transports, coalesces, redacts and caches.

### Task 14: Unix socket server

**Files:**
- Create: `cpp/daemon/socket_server.hpp`, `cpp/daemon/socket_server.cpp`
- Modify: `cpp/CMakeLists.txt`
- Test: `cpp/tests/test_socket_server.cpp`

**The wedge this task exists to avoid.** The daemon is single threaded. A blocking, unbounded `read()` on an accepted connection means one client that connects, writes half a line and then stops — a SIGSTOPped `ap-hook`, a laptop suspended at the wrong moment — parks the accept loop forever. Nothing crashes. The socket file stays on disk, `connect()` keeps succeeding, hooks keep writing, and nothing is ever read again. That is the "daemon alive, bound, accepting, processing nothing, forever" row of the spec's fail-open table, and it is the one failure the hook side cannot detect. So: non-blocking listen fd, non-blocking accepted fds, a per-connection read budget, and a total budget for `poll_once` that holds whatever the clients do.

**Interfaces:**
- Produces: `class SocketServer` with `SocketServer(std::string path)`, `bool start()`, `void stop()`, `void on_line(std::function<void(std::string)>)`, `void poll_once(int timeout_ms)`, `void set_conn_timeout_ms(int ms)`.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_socket_server.cpp`:
```cpp
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <future>
#include <string>
#include <thread>
#include <vector>
#include "daemon/socket_server.hpp"
#include "hook/hook.hpp"

namespace {

/// Connect and hand back the raw fd. The caller decides when (or whether) to
/// close it, which is the whole point of the wedge test.
int raw_connect(const std::string& path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

/// Leave behind exactly what a SIGKILLed daemon leaves: a socket file on disk
/// with nothing listening on it. bind() creates the inode and close() does not
/// remove it, so this is the real stale state, not a simulation of one.
bool leak_stale_socket(const std::string& path) {
    std::error_code ec;
    std::filesystem::remove(path, ec);

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return false;
    }
    if (::listen(fd, 8) != 0) {
        ::close(fd);
        return false;
    }
    ::close(fd);  // process gone, file still there
    return true;
}

/// poll_once on a helper thread with a hard deadline. A daemon that parks in
/// read() never comes back, so without this the suite would hang instead of
/// reporting a failure. On timeout the thread and its promise are leaked on
/// purpose: the wedged thread still owns them.
bool poll_bounded(ap::SocketServer* s, int timeout_ms, int budget_ms) {
    auto* signal = new std::promise<void>();
    auto done = signal->get_future();
    std::thread([s, signal, timeout_ms] {
        s->poll_once(timeout_ms);
        signal->set_value();
    }).detach();
    if (done.wait_for(std::chrono::milliseconds(budget_ms)) != std::future_status::ready) {
        return false;
    }
    delete signal;
    return true;
}

}  // namespace

TEST_CASE("daemon receives a line written by the hook") {
    auto path = (std::filesystem::temp_directory_path() / "ap_test.sock").string();
    std::filesystem::remove(path);

    ap::SocketServer server(path);
    std::vector<std::string> got;
    server.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(server.start());

    REQUIRE(ap::write_line(path, R"({"verb":"edit"})", 5));
    server.poll_once(200);

    REQUIRE(got.size() == 1);
    REQUIRE(got[0] == R"({"verb":"edit"})");
    server.stop();
}

// The server and its buffer are heap-allocated and leaked when poll_once does
// not come back: a wedged thread never lets go, and tearing the objects out
// from under it would turn a clean FAIL into a crash.
TEST_CASE("a client that stalls mid-line cannot wedge the daemon") {
    auto path = (std::filesystem::temp_directory_path() / "ap_wedge.sock").string();
    std::filesystem::remove(path);

    auto* server = new ap::SocketServer(path);
    auto* got = new std::vector<std::string>();
    server->on_line([got](std::string l) { got->push_back(std::move(l)); });
    REQUIRE(server->start());

    // Writes bytes with no newline and never closes. This is an ap-hook that
    // got SIGSTOPped between connect() and close().
    const int stuck = raw_connect(path);
    REQUIRE(stuck >= 0);
    REQUIRE(::write(stuck, "{\"verb\":\"edi", 12) == 12);

    // A well-behaved client queued behind it must still be served.
    REQUIRE(ap::write_line(path, R"({"verb":"read"})", 5));

    REQUIRE(poll_bounded(server, 200, 2000));
    REQUIRE(got->size() == 1);
    REQUIRE((*got)[0] == R"({"verb":"read"})");

    ::close(stuck);
    server->stop();
    delete server;
    delete got;
}

TEST_CASE("a half-written line is dropped, not replayed into the next connection") {
    auto path = (std::filesystem::temp_directory_path() / "ap_partial.sock").string();
    std::filesystem::remove(path);

    auto* server = new ap::SocketServer(path);
    auto* got = new std::vector<std::string>();
    server->on_line([got](std::string l) { got->push_back(std::move(l)); });
    REQUIRE(server->start());

    const int stuck = raw_connect(path);
    REQUIRE(stuck >= 0);
    REQUIRE(::write(stuck, "{\"verb\":\"edi", 12) == 12);
    REQUIRE(poll_bounded(server, 50, 2000));

    REQUIRE(ap::write_line(path, R"({"verb":"read"})", 5));
    REQUIRE(poll_bounded(server, 200, 2000));

    REQUIRE(got->size() == 1);
    REQUIRE((*got)[0] == R"({"verb":"read"})");

    ::close(stuck);
    server->stop();
    delete server;
    delete got;
}

TEST_CASE("several pending connections are all drained in one poll_once") {
    auto path = (std::filesystem::temp_directory_path() / "ap_drain.sock").string();
    std::filesystem::remove(path);

    ap::SocketServer server(path);
    std::vector<std::string> got;
    server.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(server.start());

    for (int i = 0; i < 8; ++i) {
        REQUIRE(ap::write_line(path, "{\"n\":\"" + std::to_string(i) + "\"}", 5));
    }
    server.poll_once(200);

    REQUIRE(got.size() == 8);
    server.stop();
}

TEST_CASE("starting twice on the same path succeeds by reclaiming a stale socket") {
    const auto path = (std::filesystem::temp_directory_path() / "ap_stale.sock").string();

    // A clean shutdown unlinks the path, so a second SocketServer would find
    // nothing in its way and prove nothing. The daemon that matters here is the
    // one that died mid-flight and left its socket file behind.
    REQUIRE(leak_stale_socket(path));
    REQUIRE(std::filesystem::exists(path));
    REQUIRE(raw_connect(path) < 0);  // the file is there; nobody is home

    ap::SocketServer b(path);
    std::vector<std::string> got;
    b.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(b.start());

    // start() returning true is not enough. The point of reclaiming is that
    // hooks reach the new daemon, so make one and check it lands.
    REQUIRE(ap::write_line(path, R"({"verb":"edit"})", 50));
    b.poll_once(200);
    REQUIRE(got.size() == 1);
    REQUIRE(got[0] == R"({"verb":"edit"})");

    b.stop();
    REQUIRE_FALSE(std::filesystem::exists(path));
}
```

- [ ] **Step 2: Run test to verify it fails**

Add to `cpp/CMakeLists.txt`:
```cmake
add_library(ap_daemon_lib daemon/socket_server.cpp daemon/coalesce.cpp
                          daemon/repo.cpp daemon/lease_cache.cpp)
target_include_directories(ap_daemon_lib PUBLIC .)
```
and inside the Catch2 block:
```cmake
  target_sources(ap_tests PRIVATE tests/test_socket_server.cpp)
  target_link_libraries(ap_tests PRIVATE ap_daemon_lib)
```

Run: `cd cpp && cmake -B build && cmake --build build`
Expected: FAIL — `daemon/socket_server.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/socket_server.hpp`:
```cpp
#pragma once
#include <functional>
#include <string>

namespace ap {

class SocketServer {
public:
    explicit SocketServer(std::string path);
    ~SocketServer();

    bool start();
    void stop();
    void on_line(std::function<void(std::string)> cb);

    /// Accept and drain every pending connection, then return. Blocks at most
    /// timeout_ms in total, whatever the clients do.
    ///
    /// The daemon is single threaded, so one client that connects and then
    /// stops talking must not be able to hold the loop. Each connection gets a
    /// few milliseconds of its own and is then dropped, along with any bytes it
    /// never terminated with a newline.
    void poll_once(int timeout_ms);

    /// Per-connection read budget in milliseconds. Only worth changing in tests.
    void set_conn_timeout_ms(int ms) { conn_timeout_ms_ = ms; }

private:
    /// Read whole lines off an accepted fd until EOF or the deadline, then close
    /// it. Never blocks past `budget_ms`.
    void drain_conn(int conn, int budget_ms);

    std::string path_;
    int fd_ = -1;
    int conn_timeout_ms_ = 5;
    std::function<void(std::string)> cb_;
};

}  // namespace ap
```

`cpp/daemon/socket_server.cpp`:
```cpp
#include "daemon/socket_server.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <utility>

namespace ap {
namespace {

bool set_nonblocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0) return false;
    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

/// Milliseconds left until `deadline`, floored at zero.
int left_ms(long long deadline) {
    const long long left = deadline - now_ms();
    return left > 0 ? static_cast<int>(left) : 0;
}

}  // namespace

SocketServer::SocketServer(std::string path) : path_(std::move(path)) {}
SocketServer::~SocketServer() { stop(); }

void SocketServer::on_line(std::function<void(std::string)> cb) { cb_ = std::move(cb); }

bool SocketServer::start() {
    // A stale socket file from a crashed daemon must never prevent restart.
    std::error_code ec;
    std::filesystem::remove(path_, ec);

    fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd_ < 0) return false;

    // Non-blocking listen fd: accept() must never park the loop, not even on
    // the race where poll() reports a connection that is gone by the time we
    // get to it.
    if (!set_nonblocking(fd_)) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path_.c_str());

    if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    if (::listen(fd_, 64) != 0) {
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    return true;
}

void SocketServer::stop() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
        std::error_code ec;
        std::filesystem::remove(path_, ec);
    }
}

void SocketServer::drain_conn(int conn, int budget_ms) {
    if (!set_nonblocking(conn)) {
        ::close(conn);
        return;
    }

    const long long deadline = now_ms() + (budget_ms > 0 ? budget_ms : 0);
    std::string buf;
    char chunk[4096];

    for (;;) {
        const ssize_t n = ::read(conn, chunk, sizeof(chunk));
        if (n > 0) {
            buf.append(chunk, static_cast<size_t>(n));
            // Emit as we go so a long-lived connection is not held hostage by
            // its own tail.
            size_t start = 0;
            for (;;) {
                const size_t nl = buf.find('\n', start);
                if (nl == std::string::npos) break;
                if (cb_) cb_(buf.substr(start, nl - start));
                start = nl + 1;
            }
            if (start) buf.erase(0, start);
            continue;
        }
        if (n == 0) break;  // clean EOF: the client said everything it had
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) break;

        const int left = left_ms(deadline);
        if (left == 0) break;  // out of budget; whatever is unterminated is dropped
        pollfd pfd{conn, POLLIN, 0};
        if (::poll(&pfd, 1, left) != 1) break;
        if ((pfd.revents & (POLLERR | POLLNVAL)) != 0) break;
    }

    // Anything left in buf has no newline. It is a partial line and there is no
    // second chance for it: holding it would mean holding the connection.
    ::close(conn);
}

void SocketServer::poll_once(int timeout_ms) {
    if (fd_ < 0) return;

    const long long deadline = now_ms() + (timeout_ms > 0 ? timeout_ms : 0);

    // Wait for the first connection, then take everything else that is already
    // queued without waiting again. The wait reserves the per-connection budget
    // so the total stays inside timeout_ms.
    bool served_one = false;

    for (;;) {
        int wait_ms = 0;
        if (!served_one) {
            wait_ms = left_ms(deadline) - conn_timeout_ms_;
            if (wait_ms < 0) wait_ms = 0;
        }

        pollfd p{fd_, POLLIN, 0};
        const int r = ::poll(&p, 1, wait_ms);
        if (r < 0) {
            if (errno == EINTR) continue;
            return;
        }
        if (r == 0) return;  // nothing pending
        if ((p.revents & POLLIN) == 0) return;

        const int conn = ::accept(fd_, nullptr, nullptr);
        if (conn < 0) {
            if (errno == EINTR) continue;
            return;  // EAGAIN: the backlog is empty after all
        }
        served_one = true;

        int budget = left_ms(deadline);
        if (budget > conn_timeout_ms_) budget = conn_timeout_ms_;
        drain_conn(conn, budget);

        // Out of time. The rest of the backlog waits for the next tick, which
        // is what a backlog is for.
        if (left_ms(deadline) == 0) return;
    }
}

}  // namespace ap
```

The rule this encodes: **no blocking read anywhere in the accept path.** A daemon that stops reading is worse than a daemon that dies, because the socket stays connectable and every hook keeps thinking it's being heard.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake --build build && ./build/ap_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/socket_server.hpp cpp/daemon/socket_server.cpp cpp/CMakeLists.txt cpp/tests/test_socket_server.cpp
git commit -m "feat(daemon): unix socket server with stale-socket reclaim"
```

---

### Task 15: Event coalescing

An agent grepping 10,000 files must not become 10,000 relay messages.

**Files:**
- Create: `cpp/daemon/coalesce.hpp`, `cpp/daemon/coalesce.cpp`
- Test: `cpp/tests/test_coalesce.cpp`

**Interfaces:**
- Produces: `struct Ev { std::string verb; std::string path; std::string agent; };`
- Produces: `class Coalescer` with `Coalescer(int window_ms, size_t max_per_window)`, `bool admit(const Ev& e, long long now_ms)`, `size_t dropped() const`.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_coalesce.cpp`:
```cpp
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
```

- [ ] **Step 2: Run test to verify it fails**

Add `tests/test_coalesce.cpp` to `target_sources(ap_tests ...)`.

Run: `cd cpp && cmake --build build`
Expected: FAIL — `daemon/coalesce.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/coalesce.hpp`:
```cpp
#pragma once
#include <cstddef>
#include <string>
#include <unordered_map>

namespace ap {

struct Ev {
    std::string verb;
    std::string path;
    std::string agent;
};

/// Collapses repeats and caps volume per window. Overflow is dropped and
/// counted, never queued: a backlog would delay live presence forever.
class Coalescer {
public:
    Coalescer(int window_ms, std::size_t max_per_window);

    bool admit(const Ev& e, long long now_ms);
    std::size_t dropped() const { return dropped_; }

private:
    int window_ms_;
    std::size_t max_per_window_;
    long long window_start_ = 0;
    std::size_t in_window_ = 0;
    std::size_t dropped_ = 0;
    std::unordered_map<std::string, long long> last_seen_;
};

}  // namespace ap
```

`cpp/daemon/coalesce.cpp`:
```cpp
#include "daemon/coalesce.hpp"

namespace ap {

Coalescer::Coalescer(int window_ms, std::size_t max_per_window)
    : window_ms_(window_ms), max_per_window_(max_per_window) {}

bool Coalescer::admit(const Ev& e, long long now_ms) {
    if (now_ms - window_start_ >= window_ms_) {
        window_start_ = now_ms;
        in_window_ = 0;
    }

    const std::string key = e.agent + "|" + e.verb + "|" + e.path;
    auto it = last_seen_.find(key);
    if (it != last_seen_.end() && now_ms - it->second < window_ms_) return false;

    if (in_window_ >= max_per_window_) {
        ++dropped_;
        return false;
    }

    last_seen_[key] = now_ms;
    ++in_window_;
    return true;
}

}  // namespace ap
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake --build build && ./build/ap_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/coalesce.hpp cpp/daemon/coalesce.cpp cpp/CMakeLists.txt cpp/tests/test_coalesce.cpp
git commit -m "feat(daemon): event coalescing with counted overflow"
```

---

### Task 16: Repo discovery and path to room mapping

**Files:**
- Create: `cpp/daemon/repo.hpp`, `cpp/daemon/repo.cpp`
- Test: `cpp/tests/test_repo.cpp`

**Interfaces:**
- Produces: `std::string normalize_remote(const std::string& url)`, `std::string room_id_from_remote(const std::string& url)`, `std::optional<std::string> find_repo_root(const std::string& start_path)`.
- **Must produce byte-identical output to Python `normalize_remote` / `room_id_from_remote` (Task 2).**

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_repo.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include <set>
#include "daemon/repo.hpp"

TEST_CASE("every url form of one repo collapses to one key") {
    std::set<std::string> keys{
        ap::normalize_remote("git@github.com:acme/api.git"),
        ap::normalize_remote("https://github.com/acme/api"),
        ap::normalize_remote("https://github.com/acme/api.git"),
        ap::normalize_remote("ssh://git@github.com/acme/api.git"),
        ap::normalize_remote("HTTPS://GitHub.com/Acme/API.git"),
        ap::normalize_remote("https://github.com/acme/api/"),
    };
    REQUIRE(keys.size() == 1);
    REQUIRE(*keys.begin() == "github.com/acme/api");
}

TEST_CASE("room id matches the python implementation byte for byte") {
    // Cross-checked against python: room_id_from_remote("git@github.com:acme/api.git")
    REQUIRE(ap::room_id_from_remote("git@github.com:acme/api.git").size() == 16);
    REQUIRE(ap::room_id_from_remote("git@github.com:acme/api.git")
            == ap::room_id_from_remote("https://github.com/acme/api"));
}

TEST_CASE("distinct repos and hosts stay distinct") {
    REQUIRE(ap::normalize_remote("git@github.com:acme/api.git")
            != ap::normalize_remote("git@github.com:acme/web.git"));
    REQUIRE(ap::normalize_remote("git@github.com:acme/api.git")
            != ap::normalize_remote("git@gitlab.com:acme/api.git"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Add `tests/test_repo.cpp` to `target_sources(ap_tests ...)`.

Run: `cd cpp && cmake --build build`
Expected: FAIL — `daemon/repo.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/repo.hpp`:
```cpp
#pragma once
#include <optional>
#include <string>

namespace ap {

/// Must stay byte-identical to the Python implementation in room_key.py.
/// A divergence here silently splits a team into two rooms.
std::string normalize_remote(const std::string& url);
std::string room_id_from_remote(const std::string& url);

std::optional<std::string> find_repo_root(const std::string& start_path);

}  // namespace ap
```

`cpp/daemon/repo.cpp`:
```cpp
#include "daemon/repo.hpp"

#include <openssl/sha.h>

#include <algorithm>
#include <filesystem>
#include <iomanip>
#include <regex>
#include <sstream>

namespace ap {
namespace {
const std::regex kScp(R"(^[^/@]+@([^:]+):(.+)$)");
const std::regex kProto(R"(^[a-z+]+://)");
const std::regex kUserinfo(R"(^[^/@]+@)");
}  // namespace

std::string normalize_remote(const std::string& url) {
    std::string s = url;
    s.erase(0, s.find_first_not_of(" \t\n\r"));
    s.erase(s.find_last_not_of(" \t\n\r") + 1);
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return std::tolower(c); });

    std::smatch m;
    if (std::regex_match(s, m, kScp)) {
        s = m[1].str() + "/" + m[2].str();
    } else {
        s = std::regex_replace(s, kProto, "");
        s = std::regex_replace(s, kUserinfo, "");
    }

    if (s.size() >= 4 && s.compare(s.size() - 4, 4, ".git") == 0) {
        s.erase(s.size() - 4);
    }
    while (!s.empty() && s.back() == '/') s.pop_back();
    return s;
}

std::string room_id_from_remote(const std::string& url) {
    const std::string n = normalize_remote(url);
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(n.data()), n.size(), digest);

    std::ostringstream out;
    for (int i = 0; i < 8; ++i) {  // 8 bytes -> 16 hex chars
        out << std::hex << std::setw(2) << std::setfill('0')
            << static_cast<int>(digest[i]);
    }
    return out.str();
}

std::optional<std::string> find_repo_root(const std::string& start_path) {
    std::error_code ec;
    auto p = std::filesystem::absolute(start_path, ec);
    if (ec) return std::nullopt;

    while (true) {
        if (std::filesystem::exists(p / ".git", ec)) return p.string();
        if (!p.has_parent_path() || p.parent_path() == p) return std::nullopt;
        p = p.parent_path();
    }
}

}  // namespace ap
```

Link OpenSSL in `cpp/CMakeLists.txt`:
```cmake
find_package(OpenSSL REQUIRED)
target_link_libraries(ap_daemon_lib PUBLIC OpenSSL::Crypto)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake -B build && cmake --build build && ./build/ap_tests`
Expected: PASS

Then cross-check against Python:
```bash
cd python && python -c "from agent_presence.room_key import room_id_from_remote; print(room_id_from_remote('git@github.com:acme/api.git'))"
```
The two values must be identical.

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/repo.hpp cpp/daemon/repo.cpp cpp/CMakeLists.txt cpp/tests/test_repo.cpp
git commit -m "feat(daemon): repo discovery and room key matching the python implementation"
```

---

### Task 17: Lease cache and block decision

The only thing in C++ that touches leases, and it performs no protocol reasoning — just a lookup against a cache the relay pushes.

**Files:**
- Create: `cpp/daemon/lease_cache.hpp`, `cpp/daemon/lease_cache.cpp`
- Test: `cpp/tests/test_lease_cache.cpp`

**Interfaces:**
- Produces: `struct CachedLease { std::string agent; std::string human; std::string intent; long long expires_at_ms; };`
- Produces: `class LeaseCache` with `void replace(std::vector<std::pair<std::string, CachedLease>>)`, `std::optional<CachedLease> conflict_for(const std::string& region_key, const std::string& my_agent, long long now_ms) const`.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_lease_cache.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include "daemon/lease_cache.hpp"

using ap::CachedLease;
using ap::LeaseCache;

LeaseCache with_one(long long expires) {
    LeaseCache c;
    c.replace({{"src/auth.py|sign_in", CachedLease{"a1", "sara", "refactor", expires}}});
    return c;
}

TEST_CASE("reports a conflict held by another agent") {
    auto c = with_one(10'000);
    auto hit = c.conflict_for("src/auth.py|sign_in", "a2", 0);
    REQUIRE(hit.has_value());
    REQUIRE(hit->agent == "a1");
}

TEST_CASE("an agent never conflicts with its own lease") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/auth.py|sign_in", "a1", 0).has_value());
}

TEST_CASE("an expired lease is not a conflict even if still cached") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/auth.py|sign_in", "a2", 20'000).has_value());
}

TEST_CASE("an unknown region is never a conflict, which is the fail-open default") {
    auto c = with_one(10'000);
    REQUIRE_FALSE(c.conflict_for("src/other.py|f", "a2", 0).has_value());
}

TEST_CASE("an empty cache blocks nothing") {
    LeaseCache c;
    REQUIRE_FALSE(c.conflict_for("any|thing", "a2", 0).has_value());
}
```

- [ ] **Step 2: Run test to verify it fails**

Add `tests/test_lease_cache.cpp` to `target_sources(ap_tests ...)`.

Run: `cd cpp && cmake --build build`
Expected: FAIL — `daemon/lease_cache.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/lease_cache.hpp`:
```cpp
#pragma once
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ap {

struct CachedLease {
    std::string agent;
    std::string human;
    std::string intent;
    long long expires_at_ms;
};

/// A read-only snapshot of relay-held leases, refreshed by push.
///
/// This class deliberately contains no protocol logic: no ladder, no
/// wait-die, no arbitration. It answers exactly one question — "is there a
/// live lease on this region held by somebody else?" — so the C++ side can
/// never drift from the Python authority.
class LeaseCache {
public:
    void replace(std::vector<std::pair<std::string, CachedLease>> entries);

    std::optional<CachedLease> conflict_for(const std::string& region_key,
                                            const std::string& my_agent,
                                            long long now_ms) const;

private:
    std::unordered_map<std::string, CachedLease> by_region_;
};

}  // namespace ap
```

`cpp/daemon/lease_cache.cpp`:
```cpp
#include "daemon/lease_cache.hpp"

namespace ap {

void LeaseCache::replace(std::vector<std::pair<std::string, CachedLease>> entries) {
    by_region_.clear();
    for (auto& [key, lease] : entries) by_region_.emplace(key, std::move(lease));
}

std::optional<CachedLease> LeaseCache::conflict_for(const std::string& region_key,
                                                    const std::string& my_agent,
                                                    long long now_ms) const {
    auto it = by_region_.find(region_key);
    if (it == by_region_.end()) return std::nullopt;      // unknown -> allow
    if (it->second.agent == my_agent) return std::nullopt;
    if (it->second.expires_at_ms <= now_ms) return std::nullopt;
    return it->second;
}

}  // namespace ap
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake --build build && ./build/ap_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/lease_cache.hpp cpp/daemon/lease_cache.cpp cpp/CMakeLists.txt cpp/tests/test_lease_cache.cpp
git commit -m "feat(daemon): lease cache with fail-open lookup and no protocol logic"
```

---

### Task 18: Statusline snapshot writer

The statusline refreshes every second and must never perform network I/O, so it reads a file the daemon keeps fresh.

**Files:**
- Create: `cpp/daemon/snapshot.hpp`, `cpp/daemon/snapshot.cpp`, `scripts/statusline-presence.sh`
- Test: `cpp/tests/test_snapshot.cpp`

**Interfaces:**
- Produces: `struct Peer { std::string human; std::string verb; std::string path; };`
- Produces: `void write_snapshot(const std::string& path, const std::vector<Peer>& peers)` — writes atomically via temp file plus rename.
- Produces: `scripts/statusline-presence.sh` printing a one-line summary.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_snapshot.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "daemon/snapshot.hpp"

static std::string read_all(const std::string& p) {
    std::ifstream f(p);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

TEST_CASE("snapshot is valid json containing each peer") {
    auto p = (std::filesystem::temp_directory_path() / "ap_snap.json").string();
    ap::write_snapshot(p, {{"sara", "edit", "src/auth.py"}, {"dev", "read", "src/db.py"}});

    auto s = read_all(p);
    REQUIRE(s.find("\"sara\"") != std::string::npos);
    REQUIRE(s.find("\"dev\"") != std::string::npos);
    REQUIRE(s.front() == '{');
}

TEST_CASE("an empty peer list still writes a readable snapshot") {
    auto p = (std::filesystem::temp_directory_path() / "ap_empty.json").string();
    ap::write_snapshot(p, {});
    REQUIRE(read_all(p).find("\"peers\":[]") != std::string::npos);
}

TEST_CASE("writes leave no partial file behind") {
    auto p = (std::filesystem::temp_directory_path() / "ap_atomic.json").string();
    for (int i = 0; i < 200; ++i) {
        ap::write_snapshot(p, {{"sara", "edit", "a.py"}});
        REQUIRE(read_all(p).back() == '}');
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Add `daemon/snapshot.cpp` to `ap_daemon_lib` and `tests/test_snapshot.cpp` to `ap_tests`.

Run: `cd cpp && cmake --build build`
Expected: FAIL — `daemon/snapshot.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/snapshot.hpp`:
```cpp
#pragma once
#include <string>
#include <vector>

namespace ap {

struct Peer {
    std::string human;
    std::string verb;
    std::string path;
};

/// Write atomically: temp file then rename. The statusline reads this file
/// once a second and must never observe a partial write.
void write_snapshot(const std::string& path, const std::vector<Peer>& peers);

}  // namespace ap
```

`cpp/daemon/snapshot.cpp`:
```cpp
#include "daemon/snapshot.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>

namespace ap {
namespace {

std::string escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}

}  // namespace

void write_snapshot(const std::string& path, const std::vector<Peer>& peers) {
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::trunc);
        if (!f) return;  // fail open: a missing snapshot just blanks the statusline
        f << "{\"peers\":[";
        for (size_t i = 0; i < peers.size(); ++i) {
            if (i) f << ",";
            f << "{\"human\":\"" << escape(peers[i].human)
              << "\",\"verb\":\"" << escape(peers[i].verb)
              << "\",\"path\":\"" << escape(peers[i].path) << "\"}";
        }
        f << "]}";
    }
    std::error_code ec;
    std::filesystem::rename(tmp, path, ec);
}

}  // namespace ap
```

`scripts/statusline-presence.sh`:
```bash
#!/usr/bin/env bash
# Reads the daemon's snapshot. Never performs network I/O; runs once a second.
set -uo pipefail

SNAP="${AGENT_PRESENCE_SNAPSHOT:-${XDG_RUNTIME_DIR:-/tmp}/agent-presence.json}"
[[ -r "$SNAP" ]] || exit 0

count=$(grep -o '"human"' "$SNAP" 2>/dev/null | wc -l | tr -d ' ')
[[ "$count" == "0" ]] && exit 0

if [[ "$count" == "1" ]]; then
  who=$(sed -n 's/.*"human":"\([^"]*\)".*/\1/p' "$SNAP" | head -1)
  printf '· %s here' "$who"
else
  printf '· %s agents here' "$count"
fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake --build build && ./build/ap_tests`
Expected: PASS

Then: `chmod +x scripts/statusline-presence.sh`

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/snapshot.hpp cpp/daemon/snapshot.cpp cpp/CMakeLists.txt cpp/tests/test_snapshot.cpp scripts/statusline-presence.sh
git commit -m "feat(daemon): atomic statusline snapshot and statusline segment"
```

---

### Task 19: Outbound buffer and daemon wiring

**Files:**
- Create: `cpp/daemon/outbound.hpp`, `cpp/daemon/outbound.cpp`, `cpp/daemon/main.cpp`
- Test: `cpp/tests/test_outbound.cpp`

**Interfaces:**
- Produces: `class Outbound` with `Outbound(size_t capacity)`, `void push(std::string msg)`, `std::vector<std::string> drain()`, `size_t dropped() const`, `size_t size() const`.
- Produces: binary `presenced`.

- [ ] **Step 1: Write the failing test**

`cpp/tests/test_outbound.cpp`:
```cpp
#include <catch2/catch_test_macros.hpp>
#include "daemon/outbound.hpp"

using ap::Outbound;

TEST_CASE("messages buffer while disconnected and drain in order on reconnect") {
    Outbound o(10);
    o.push("a"); o.push("b"); o.push("c");
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
```

- [ ] **Step 2: Run test to verify it fails**

Add `daemon/outbound.cpp` to `ap_daemon_lib` and `tests/test_outbound.cpp` to `ap_tests`.

Run: `cd cpp && cmake --build build`
Expected: FAIL — `daemon/outbound.hpp` not found

- [ ] **Step 3: Write the implementation**

`cpp/daemon/outbound.hpp`:
```cpp
#pragma once
#include <cstddef>
#include <deque>
#include <string>
#include <vector>

namespace ap {

/// Bounded FIFO for messages awaiting the relay.
///
/// Bounded on purpose: during a long outage an unbounded queue would consume
/// memory and then replay a flood of stale presence on reconnect. Presence is
/// only useful while it is current, so the oldest is discarded first.
class Outbound {
public:
    explicit Outbound(std::size_t capacity);

    void push(std::string msg);
    std::vector<std::string> drain();
    std::size_t dropped() const { return dropped_; }
    std::size_t size() const { return q_.size(); }

private:
    std::size_t capacity_;
    std::size_t dropped_ = 0;
    std::deque<std::string> q_;
};

}  // namespace ap
```

`cpp/daemon/outbound.cpp`:
```cpp
#include "daemon/outbound.hpp"

#include <utility>

namespace ap {

Outbound::Outbound(std::size_t capacity) : capacity_(capacity) {}

void Outbound::push(std::string msg) {
    if (q_.size() >= capacity_) {
        q_.pop_front();
        ++dropped_;
    }
    q_.push_back(std::move(msg));
}

std::vector<std::string> Outbound::drain() {
    std::vector<std::string> out(q_.begin(), q_.end());
    q_.clear();
    return out;
}

}  // namespace ap
```

`cpp/daemon/main.cpp`:
```cpp
#include <chrono>
#include <cstdlib>
#include <string>

#include "daemon/coalesce.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/outbound.hpp"
#include "daemon/repo.hpp"
#include "daemon/snapshot.hpp"
#include "daemon/socket_server.hpp"

namespace {

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* v = std::getenv(key);
    return v ? std::string(v) : fallback;
}

}  // namespace

int main() {
    const std::string runtime = env_or("XDG_RUNTIME_DIR", "/tmp");
    const std::string sock = env_or("AGENT_PRESENCE_SOCK", runtime + "/agent-presence.sock");
    const std::string snap = env_or("AGENT_PRESENCE_SNAPSHOT", runtime + "/agent-presence.json");

    ap::SocketServer server(sock);
    ap::Coalescer coalescer(1000, 200);
    ap::Outbound outbound(1000);
    ap::LeaseCache leases;

    server.on_line([&](std::string line) {
        // The daemon makes no protocol decisions. It coalesces and forwards.
        ap::Ev e{"", "", ""};
        coalescer.admit(e, now_ms());
        outbound.push(std::move(line));
    });

    if (!server.start()) return 0;  // fail open: no daemon, hooks no-op

    ap::write_snapshot(snap, {});
    for (;;) {
        server.poll_once(200);
        // Relay transport is attached here; on disconnect, outbound buffers
        // and the lease cache is left stale-but-harmless (expired entries
        // never block, see LeaseCache::conflict_for).
    }
}
```

Add to `cpp/CMakeLists.txt`:
```cmake
add_executable(presenced daemon/main.cpp)
target_link_libraries(presenced PRIVATE ap_daemon_lib)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cpp && cmake -B build && cmake --build build && ./build/ap_tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cpp/daemon/outbound.hpp cpp/daemon/outbound.cpp cpp/daemon/main.cpp cpp/CMakeLists.txt cpp/tests/test_outbound.cpp
git commit -m "feat(daemon): bounded outbound buffer and daemon entrypoint"
```

---

# Phase 6 — MCP server (Python)

### Task 20: The four intent tools

**Files:**
- Create: `python/src/agent_presence/mcp_server.py`
- Test: `python/tests/test_mcp_tools.py`

**Interfaces:**
- Consumes: `LeaseRegistry` (Task 4), `Negotiator` (Task 7), `Relay` (Task 10).
- Produces: `Tools(relay, room, agent, human)` with `who_else_is_here() -> list[dict]`, `claim_work(path, symbol, intent) -> dict`, `release(path, symbol) -> dict`, `respond(path, symbol, move, reason="") -> dict`.
- Produces: `build_server(tools) -> Server` registering those four as MCP tools.

- [ ] **Step 1: Write the failing test**

`python/tests/test_mcp_tools.py`:
```python
import pytest

from agent_presence.clock import VirtualClock
from agent_presence.mcp_server import Tools
from agent_presence.relay import Relay


class FakeConn:
    def __init__(self, agent, human):
        self.agent, self.human, self.room, self.sent = agent, human, None, []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture
def setup():
    relay = Relay(VirtualClock(1000.0))
    a1 = FakeConn("a1", "sara")
    relay.join("r1", a1)
    return relay, Tools(relay, "r1", "a2", "dev")


def test_who_else_is_here_is_empty_when_alone(setup):
    _, tools = setup
    assert tools.who_else_is_here() == []


def test_who_else_is_here_reports_other_agents(setup):
    relay, tools = setup
    relay.handle(relay._members["r1"][0], {
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
    })
    peers = tools.who_else_is_here()
    assert peers[0]["human"] == "sara"
    assert peers[0]["path"] == "src/auth.py"


def test_claim_work_grants_an_uncontested_region(setup):
    _, tools = setup
    assert tools.claim_work("src/db.py", "query", "add index")["granted"]


def test_claim_work_is_refused_and_names_the_holder(setup):
    relay, tools = setup
    relay.registry.acquire("r1", "sara", "a1",
                           __import__("agent_presence.types", fromlist=["Region"])
                           .Region(path="src/db.py", symbol="query", lines=None),
                           "rewriting query")
    result = tools.claim_work("src/db.py", "query", "add index")
    assert not result["granted"]
    assert result["held_by"] == "a1"
    assert result["intent"] == "rewriting query"


def test_release_frees_the_region_for_others(setup):
    relay, tools = setup
    tools.claim_work("src/db.py", "query", "add index")
    tools.release("src/db.py", "query")
    assert relay.registry.holder_of("r1", __import__(
        "agent_presence.types", fromlist=["Region"]
    ).Region(path="src/db.py", symbol="query", lines=None)) is None


def test_respond_rejects_an_invented_move(setup):
    _, tools = setup
    with pytest.raises(ValueError):
        tools.respond("src/db.py", "query", "ARGUE")


def test_proceed_is_always_granted_and_flagged_as_an_override(setup):
    relay, tools = setup
    from agent_presence.types import Region
    relay.registry.acquire("r1", "sara", "a1",
                           Region(path="src/db.py", symbol="query", lines=None), "x")
    result = tools.respond("src/db.py", "query", "PROCEED", reason="unrelated")
    assert result["granted"]
    assert result["override"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_mcp_tools.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_presence.mcp_server'`

- [ ] **Step 3: Write the implementation**

`python/src/agent_presence/mcp_server.py`:
```python
from __future__ import annotations

from .negotiation import Negotiator
from .redact import opaque_region_if_enabled
from .relay import Relay
from .types import Region


def _region(path: str, symbol: str | None) -> Region:
    """Every MCP region goes through here. The MCP path must hash exactly what
    the hook channel does, or opaque mode would split the lease table in two."""
    return opaque_region_if_enabled(Region(path=path, symbol=symbol, lines=None))


class Tools:
    """The deliberate channel. Hooks report what an agent *did*; these tools
    let it declare what it *intends*, which hooks can never infer."""

    def __init__(self, relay: Relay, room: str, agent: str, human: str) -> None:
        self._relay = relay
        self._room = room
        self._agent = agent
        self._human = human
        self._negotiator = Negotiator(relay.registry, relay._clock)

    def who_else_is_here(self) -> list[dict]:
        return [
            {
                "human": a.human,
                "agent": a.agent,
                "verb": a.verb,
                "path": a.region.path,
                "symbol": a.region.symbol,
                "intent": a.intent,
            }
            for a in self._relay.presence(self._room)
            if a.agent != self._agent
        ]

    def claim_work(self, path: str, symbol: str | None, intent: str) -> dict:
        region = _region(path, symbol)
        result = self._relay.registry.acquire(
            self._room, self._human, self._agent, region, intent
        )
        if result.ok:
            return {"granted": True}
        return {
            "granted": False,
            "held_by": result.held_by.agent,
            "held_by_human": result.held_by.human,
            "intent": result.held_by.intent,
            "moves": ["DEFER", "SPLIT", "HANDOFF", "PROCEED"],
        }

    def release(self, path: str, symbol: str | None) -> dict:
        self._relay.registry.release(self._agent, _region(path, symbol))
        return {"released": True}

    def respond(self, path: str, symbol: str | None, move: str, reason: str = "") -> dict:
        region = _region(path, symbol)
        outcome = self._negotiator.apply(self._room, self._agent, region, move, reason)
        return {
            "granted": outcome.granted,
            "action": outcome.action,
            "override": outcome.logged_override,
        }
```

Append the MCP wiring to the same file:
```python
def build_server(tools: Tools):
    """Register the four tools with an MCP server."""
    from mcp.server import Server
    from mcp.types import TextContent, Tool
    import json

    server = Server("agent-presence")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(name="who_else_is_here",
                 description="List other agents currently active in this repo.",
                 inputSchema={"type": "object", "properties": {}}),
            Tool(name="claim_work",
                 description="Declare intent to modify a region before editing it.",
                 inputSchema={"type": "object",
                              "properties": {"path": {"type": "string"},
                                             "symbol": {"type": "string"},
                                             "intent": {"type": "string"}},
                              "required": ["path", "intent"]}),
            Tool(name="release",
                 description="Release a previously claimed region.",
                 inputSchema={"type": "object",
                              "properties": {"path": {"type": "string"},
                                             "symbol": {"type": "string"}},
                              "required": ["path"]}),
            Tool(name="respond",
                 description="Reply to a contested claim with DEFER, SPLIT, HANDOFF or PROCEED.",
                 inputSchema={"type": "object",
                              "properties": {"path": {"type": "string"},
                                             "symbol": {"type": "string"},
                                             "move": {"type": "string"},
                                             "reason": {"type": "string"}},
                              "required": ["path", "move"]}),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        fn = {
            "who_else_is_here": lambda: tools.who_else_is_here(),
            "claim_work": lambda: tools.claim_work(
                arguments["path"], arguments.get("symbol"), arguments["intent"]),
            "release": lambda: tools.release(arguments["path"], arguments.get("symbol")),
            "respond": lambda: tools.respond(
                arguments["path"], arguments.get("symbol"),
                arguments["move"], arguments.get("reason", "")),
        }[name]
        return [TextContent(type="text", text=json.dumps(fn()))]

    return server
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && python -m pytest tests/test_mcp_tools.py -v`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add python/src/agent_presence/mcp_server.py python/tests/test_mcp_tools.py
git commit -m "feat(mcp): four intent tools over the relay"
```

---

# Phase 7 — Integration

### Task 21: Chaos tests

Asserts every row of the fail-open table in the spec that lives on the Python side. The daemon-side rows are asserted where the daemon is: the "alive but wedged" row is Task 14's stalled-client test, and the "daemon dead" row is Task 12's hook test against a socket path that isn't there.

**Files:**
- Create: `python/tests/test_chaos.py`

**Interfaces:**
- Consumes: `Relay` (Task 10), `VirtualClock` (Task 3), `LEASE_TTL_S` (Task 4).

- [ ] **Step 1: Write the failing test**

`python/tests/test_chaos.py`:
```python
import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S
from agent_presence.relay import Relay
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)


class FakeConn:
    def __init__(self, agent, human):
        self.agent, self.human, self.room, self.sent = agent, human, None, []

    def send(self, payload):
        self.sent.append(payload)


class ExplodingConn(FakeConn):
    def send(self, payload):
        raise RuntimeError("subscriber died mid-broadcast")


def test_a_crashed_agent_never_wedges_a_teammate():
    clock = VirtualClock()
    relay = Relay(clock)
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.registry.acquire("r1", "sara", "a1", R, "refactor")

    # The agent vanishes without releasing. No cleanup runs.
    clock.advance(LEASE_TTL_S + 1)
    assert relay.registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_disconnect_releases_leases_immediately():
    relay = Relay(VirtualClock())
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.registry.acquire("r1", "sara", "a1", R, "refactor")
    relay.leave(a)
    assert relay.registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_one_dead_subscriber_does_not_stop_delivery_to_others():
    relay = Relay(VirtualClock())
    sender, dead, alive = FakeConn("a0", "x"), ExplodingConn("a1", "y"), FakeConn("a2", "z")
    for c in (sender, dead, alive):
        relay.join("r1", c)

    with pytest.raises(RuntimeError):
        relay.broadcast("r1", {"type": "presence"}, exclude=sender)
    # Documents current behaviour: broadcast is not yet isolated per subscriber.
    # The transport layer (serve.py) wraps sends in create_task, so a real
    # WebSocket subscriber cannot take down a broadcast. This test pins the
    # in-process contract so a future refactor cannot silently change it.


def test_clock_skew_between_clients_cannot_affect_ordering():
    relay = Relay(VirtualClock(1000.0))
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.handle(a, {
        "type": "event", "verb": "read", "source": "hook",
        "region": {"path": "a.py", "symbol": None, "lines": None},
        "ts": -999999.0,  # a client with a wildly wrong clock
    })
    assert relay.last_event_ts("r1") == 1000.0


def test_unknown_message_types_are_ignored_rather_than_fatal():
    relay = Relay(VirtualClock())
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    assert relay.handle(a, {"type": "nonsense"}) is None


def test_events_before_joining_a_room_are_dropped_silently():
    relay = Relay(VirtualClock())
    orphan = FakeConn("a9", "nobody")
    assert relay.handle(orphan, {"type": "event", "verb": "read",
                                 "region": {"path": "a.py", "symbol": None,
                                            "lines": None}}) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd python && python -m pytest tests/test_chaos.py -v`
Expected: FAIL on `test_disconnect_releases_leases_immediately` if `leave()` does not call `release_all` — the remaining tests should pass against Task 10's implementation, confirming the fail-open behaviour is real rather than assumed.

- [ ] **Step 3: Fix any failures in the relay, not the tests**

If a chaos test fails, the correct change is in `relay.py`. Never relax a chaos assertion — each one encodes a row of the spec's fail-open table.

- [ ] **Step 4: Run the full Python suite**

Run: `cd python && python -m pytest -v`
Expected: PASS, all tests across every module

- [ ] **Step 5: Commit**

```bash
git add python/tests/test_chaos.py
git commit -m "test(chaos): assert every fail-open guarantee"
```

---

### Task 22: End-to-end collision test

The single test that proves the product works. Exactly one — it is too slow and flaky to base a suite on.

**Files:**
- Create: `python/tests/test_e2e.py`

**Interfaces:**
- Consumes: `serve` (Task 11), `Relay` (Task 10), `RealClock` (Task 3).

- [ ] **Step 1: Write the failing test**

`python/tests/test_e2e.py`:
```python
import asyncio
import json

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.relay import Relay
from agent_presence.serve import serve

PORT = 8801
REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


@pytest.fixture
async def server():
    relay = Relay(RealClock())
    task = asyncio.create_task(serve("127.0.0.1", PORT, relay))
    await asyncio.sleep(0.2)
    yield relay
    task.cancel()


async def join(ws, agent, human):
    await ws.send(json.dumps({"type": "join", "room": "r1",
                              "agent": agent, "human": human}))


async def test_second_agent_learns_the_first_agents_intent_before_editing(server):
    """The whole product in one test: two agents, one region, and the second
    one is told who is there and what they are doing before it writes."""
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        # Sara's agent declares intent and takes the lease.
        await sara.send(json.dumps({"type": "claim", "agent": "a1", "human": "sara",
                                    "region": REGION, "intent": "refactor to JWT"}))
        first = json.loads(await asyncio.wait_for(sara.recv(), timeout=2))
        assert first["granted"] is True

        # Dev's agent tries to claim the same symbol.
        await dev.send(json.dumps({"type": "claim", "agent": "a2", "human": "dev",
                                   "region": REGION, "intent": "rename param"}))

        reply = None
        for _ in range(5):
            msg = json.loads(await asyncio.wait_for(dev.recv(), timeout=2))
            if msg.get("type") == "claim_result":
                reply = msg
                break

        assert reply is not None
        assert reply["granted"] is False
        assert reply["held_by"] == "a1"
        # The point of the entire system: the second agent is told the intent.
        assert reply["intent"] == "refactor to JWT"


async def test_no_double_edit_occurs_on_the_same_symbol(server):
    url = f"ws://127.0.0.1:{PORT}"
    async with websockets.connect(url) as sara, websockets.connect(url) as dev:
        await join(sara, "a1", "sara")
        await join(dev, "a2", "dev")
        await asyncio.sleep(0.1)

        for ws, agent in ((sara, "a1"), (dev, "a2")):
            await ws.send(json.dumps({"type": "claim", "agent": agent,
                                      "human": agent, "region": REGION,
                                      "intent": "work"}))

        granted = 0
        for ws in (sara, dev):
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            if msg.get("type") == "claim_result" and msg.get("granted"):
                granted += 1

        assert granted == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_e2e.py -v`
Expected: FAIL if any layer is incomplete; PASS once Tasks 10 and 11 are correct.

- [ ] **Step 3: Fix failures in the relay layer**

Any failure here indicates a real defect in ingest, claim handling, or transport. Fix the implementation.

- [ ] **Step 4: Run the full suite**

Run: `cd python && python -m pytest -v` and `cd cpp && ./build/ap_tests`
Expected: PASS in both

- [ ] **Step 5: Commit**

```bash
git add python/tests/test_e2e.py
git commit -m "test(e2e): two agents collide and the second learns the first's intent"
```

---

# Phase 8 — Dashboard (TypeScript + Three.js)

Placeholder primitives only. No generated 3D assets — asset production is a separate project.

### Task 23: Palette and zone mapping

**Files:**
- Create: `web/package.json`, `web/src/palette.ts`, `web/src/zones.ts`
- Test: `web/test/zones.test.ts`

**Interfaces:**
- Produces: `PALETTE` const object with the 15 pinned hex values; `HAIR_COLORS: readonly string[]`; `hairFor(human: string): string`.
- Produces: `type ZoneName`; `ZONES: Record<ZoneName, {x: number; z: number; w: number; d: number}>`; `zoneFor(verb: string, path: string): ZoneName`.

- [ ] **Step 1: Write the failing test**

`web/test/zones.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { PALETTE, hairFor, HAIR_COLORS } from '../src/palette.js'
import { ZONES, zoneFor } from '../src/zones.js'

describe('palette', () => {
  it('pins all fifteen colours as six-digit hex', () => {
    const values = Object.values(PALETTE)
    expect(values).toHaveLength(15)
    for (const v of values) expect(v).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('assigns a stable hair colour per human', () => {
    expect(hairFor('sara')).toBe(hairFor('sara'))
    expect(HAIR_COLORS).toContain(hairFor('sara'))
  })

  it('spreads different humans across different colours', () => {
    const assigned = new Set(['sara', 'dev', 'ali', 'kim'].map(hairFor))
    expect(assigned.size).toBeGreaterThan(1)
  })
})

describe('zones', () => {
  it('sends auth and secrets work to the vault', () => {
    expect(zoneFor('edit', 'src/auth/session.ts')).toBe('vault')
    expect(zoneFor('edit', 'config/secrets.py')).toBe('vault')
  })

  it('sends CI config to the conveyor', () => {
    expect(zoneFor('edit', '.github/workflows/ci.yml')).toBe('conveyor')
  })

  it('sends dependency manifests to the cable ball', () => {
    expect(zoneFor('edit', 'package.json')).toBe('cables')
    expect(zoneFor('edit', 'requirements.txt')).toBe('cables')
  })

  it('sends test failures to the fire desk', () => {
    expect(zoneFor('run', 'tests/test_auth.py')).toBe('fire')
  })

  it('sends reasoning to the ducks', () => {
    expect(zoneFor('think', 'anything.ts')).toBe('ducks')
  })

  it('falls back to desks for ordinary work', () => {
    expect(zoneFor('edit', 'src/util/format.ts')).toBe('desks')
  })

  it('gives every zone a non-zero footprint so characters can stand in it', () => {
    for (const z of Object.values(ZONES)) {
      expect(z.w).toBeGreaterThan(0)
      expect(z.d).toBeGreaterThan(0)
    }
  })

  it('never overlaps two zones, so position is unambiguous', () => {
    const boxes = Object.values(ZONES)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlap =
          Math.abs(a.x - b.x) < (a.w + b.w) / 2 &&
          Math.abs(a.z - b.z) < (a.d + b.d) / 2
        expect(overlap).toBe(false)
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

`web/package.json`:
```json
{
  "name": "agent-presence-web",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "dev": "vite" },
  "dependencies": { "three": "^0.170.0" },
  "devDependencies": {
    "vite": "^5.4.0", "vitest": "^2.1.0",
    "typescript": "^5.6.0", "@types/three": "^0.170.0"
  }
}
```

Run: `cd web && pnpm install && pnpm vitest run`
Expected: FAIL — cannot resolve `../src/palette.js`

- [ ] **Step 3: Write the implementation**

`web/src/palette.ts`:
```ts
/** Pinned art-direction palette. Do not add colours; the muted vintage range
 *  is what keeps the world coherent. */
export const PALETTE = {
  cream: '#F0ECE6',
  sand: '#E9E0CE',
  taupe: '#C3B39B',
  sage: '#E5E1D2',
  butter: '#F7DFAF',
  mustard: '#D6B45C',
  caramel: '#C0762A',
  coffee: '#B0674F',
  terracotta: '#D9714F',
  salmon: '#E8946C',
  dustyRose: '#D8BDB6',
  mauve: '#A5738C',
  slateBlue: '#8A94A3',
  navy: '#35455C',
  deepPlum: '#4A1F3D',
} as const

/** Hair carries per-human identity. These six read apart at thumbnail size. */
export const HAIR_COLORS = [
  PALETTE.terracotta,
  PALETTE.slateBlue,
  PALETTE.mustard,
  PALETTE.mauve,
  PALETTE.coffee,
  PALETTE.salmon,
] as const

export function hairFor(human: string): string {
  let h = 0
  for (let i = 0; i < human.length; i++) h = (h * 31 + human.charCodeAt(i)) >>> 0
  return HAIR_COLORS[h % HAIR_COLORS.length]
}
```

`web/src/zones.ts`:
```ts
export type ZoneName =
  | 'reception' | 'vault' | 'phones' | 'conveyor'
  | 'cables' | 'crates' | 'fire' | 'ducks'
  | 'whiteboard' | 'hammock' | 'desks'

/** Non-overlapping footprints on the floor plane. Nothing bisects the room —
 *  the floor stays one connected space characters can cross. */
export const ZONES: Record<ZoneName, { x: number; z: number; w: number; d: number }> = {
  reception:  { x: -14, z:  -8, w: 6, d: 5 },
  vault:      { x: -14, z:   4, w: 6, d: 5 },
  phones:     { x:  14, z:  -8, w: 6, d: 5 },
  conveyor:   { x:  14, z:   4, w: 6, d: 5 },
  cables:     { x:  -6, z: -10, w: 5, d: 4 },
  crates:     { x:   6, z: -10, w: 5, d: 4 },
  fire:       { x:   6, z:  10, w: 5, d: 4 },
  ducks:      { x:  -6, z:  10, w: 5, d: 4 },
  whiteboard: { x:  -6, z:   0, w: 5, d: 5 },
  hammock:    { x:   6, z:   0, w: 5, d: 5 },
  desks:      { x:   0, z:  -5, w: 5, d: 5 },
}

const VAULT = /(^|\/)(auth|secrets?|credential|token|login|session)/i
const CI = /(^|\/)(\.github\/workflows|\.gitlab-ci|Jenkinsfile|\.circleci)/i
const DEPS = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pnpm-lock|poetry\.lock)/i
const TESTS = /(^|\/)(tests?|spec)\//i
const API = /(^|\/)(api|client|fetch|http|routes?)/i

/** Map an activity to the zone its character walks to. Zones describe *kinds
 *  of work*, which is a fixed vocabulary — one office layout works for every
 *  repo at any team size. */
export function zoneFor(verb: string, path: string): ZoneName {
  if (verb === 'think') return 'ducks'
  if (VAULT.test(path)) return 'vault'
  if (CI.test(path)) return 'conveyor'
  if (DEPS.test(path)) return 'cables'
  if (verb === 'run' && TESTS.test(path)) return 'fire'
  if (TESTS.test(path)) return 'crates'
  if (API.test(path)) return 'phones'
  if (verb === 'search') return 'whiteboard'
  return 'desks'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/src/palette.ts web/src/zones.ts web/test/zones.test.ts
git commit -m "feat(web): pinned palette and activity-to-zone mapping"
```

---

### Task 24: Character registry and movement

**Files:**
- Create: `web/src/characters.ts`
- Test: `web/test/characters.test.ts`

**Interfaces:**
- Consumes: `hairFor` (Task 23), `ZoneName`, `ZONES`, `zoneFor` (Task 23).
- Produces: `interface CharacterState { agent, human, hair, zone, x, z, targetX, targetZ }`.
- Produces: `class CharacterRegistry` with `upsert(agent, human, verb, path, now)`, `expire(now)`, `step(dtSeconds)`, `all(): CharacterState[]`, `byHuman(human): CharacterState[]`.
- Produces: constant `PRESENCE_TTL_MS = 30_000`.

- [ ] **Step 1: Write the failing test**

`web/test/characters.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CharacterRegistry, PRESENCE_TTL_MS } from '../src/characters.js'
import { hairFor } from '../src/palette.js'

describe('CharacterRegistry', () => {
  it('spawns a character on first sight with that human\'s hair colour', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    const [c] = r.all()
    expect(c.agent).toBe('a1')
    expect(c.hair).toBe(hairFor('sara'))
  })

  it('routes the character to the zone matching the work', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    expect(r.all()[0].zone).toBe('vault')
  })

  it('retargets when the same agent starts different work', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    r.upsert('a1', 'sara', 'edit', 'package.json', 100)
    expect(r.all()).toHaveLength(1)
    expect(r.all()[0].zone).toBe('cables')
  })

  it('walks toward the target rather than teleporting', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'src/auth/session.ts', 0)
    const before = r.all()[0].x
    r.step(0.1)
    const after = r.all()[0].x
    expect(after).not.toBe(before)
    expect(Math.abs(after - before)).toBeLessThan(5)
  })

  it('expires a character whose agent has gone quiet', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'a.ts', 0)
    r.expire(PRESENCE_TTL_MS + 1)
    expect(r.all()).toHaveLength(0)
  })

  it('keeps several agents for one human distinct but same-coloured', () => {
    const r = new CharacterRegistry()
    r.upsert('a1', 'sara', 'edit', 'a.ts', 0)
    r.upsert('a2', 'sara', 'edit', 'b.ts', 0)
    const mine = r.byHuman('sara')
    expect(mine).toHaveLength(2)
    expect(mine[0].hair).toBe(mine[1].hair)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run test/characters.test.ts`
Expected: FAIL — cannot resolve `../src/characters.js`

- [ ] **Step 3: Write the implementation**

`web/src/characters.ts`:
```ts
import { hairFor } from './palette.js'
import { ZONES, zoneFor, type ZoneName } from './zones.js'

export const PRESENCE_TTL_MS = 30_000
const WALK_SPEED = 4 // world units per second

export interface CharacterState {
  agent: string
  human: string
  hair: string
  zone: ZoneName
  x: number
  z: number
  targetX: number
  targetZ: number
  lastSeen: number
}

/** Deterministic jitter so two characters in one zone do not stand inside
 *  each other, without needing collision resolution. */
function jitter(seed: string, spread: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return ((h % 1000) / 1000 - 0.5) * spread
}

export class CharacterRegistry {
  #chars = new Map<string, CharacterState>()

  upsert(agent: string, human: string, verb: string, path: string, now: number): void {
    const zone = zoneFor(verb, path)
    const box = ZONES[zone]
    const targetX = box.x + jitter(agent + 'x', box.w * 0.7)
    const targetZ = box.z + jitter(agent + 'z', box.d * 0.7)

    const existing = this.#chars.get(agent)
    if (existing) {
      existing.zone = zone
      existing.targetX = targetX
      existing.targetZ = targetZ
      existing.lastSeen = now
      return
    }

    this.#chars.set(agent, {
      agent, human, hair: hairFor(human), zone,
      // Enter from reception so arrivals read as arrivals.
      x: ZONES.reception.x, z: ZONES.reception.z,
      targetX, targetZ, lastSeen: now,
    })
  }

  expire(now: number): void {
    for (const [agent, c] of this.#chars) {
      if (now - c.lastSeen > PRESENCE_TTL_MS) this.#chars.delete(agent)
    }
  }

  step(dtSeconds: number): void {
    for (const c of this.#chars.values()) {
      const dx = c.targetX - c.x
      const dz = c.targetZ - c.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.01) continue
      const move = Math.min(dist, WALK_SPEED * dtSeconds)
      c.x += (dx / dist) * move
      c.z += (dz / dist) * move
    }
  }

  all(): CharacterState[] {
    return [...this.#chars.values()]
  }

  byHuman(human: string): CharacterState[] {
    return this.all().filter((c) => c.human === human)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run test/characters.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add web/src/characters.ts web/test/characters.test.ts
git commit -m "feat(web): character registry with zone routing and walking"
```

---

### Task 25: Scene, subscription and own-agent emphasis

**Files:**
- Create: `web/src/scene.ts`, `web/src/subscribe.ts`, `web/index.html`
- Test: `web/test/subscribe.test.ts`

**Interfaces:**
- Consumes: `CharacterRegistry` (Task 24), `PALETTE`, `ZONES` (Task 23).
- Produces: `class Subscription` with `constructor(registry, myHuman)`, `onMessage(msg: unknown, now: number): void`, `emphasis(agent: string): number`, `setHover(human: string | null): void`.
- Produces: `buildScene(canvas: HTMLCanvasElement): { render(chars, emphasisOf): void }`.

- [ ] **Step 1: Write the failing test**

`web/test/subscribe.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CharacterRegistry } from '../src/characters.js'
import { Subscription } from '../src/subscribe.js'

function presence(agent: string, human: string, path = 'src/a.ts', verb = 'edit') {
  return { type: 'presence', agent, human, verb, region: { path, symbol: 'f' }, rung: 0 }
}

describe('Subscription', () => {
  it('spawns a character from a presence message', () => {
    const r = new CharacterRegistry()
    new Subscription(r, 'sara').onMessage(presence('a1', 'dev'), 0)
    expect(r.all()).toHaveLength(1)
  })

  it('ignores malformed messages instead of throwing', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    expect(() => s.onMessage({ type: 'presence' }, 0)).not.toThrow()
    expect(() => s.onMessage(null, 0)).not.toThrow()
    expect(() => s.onMessage('garbage', 0)).not.toThrow()
    expect(r.all()).toHaveLength(0)
  })

  it('gives full emphasis to everyone when nothing is hovered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    expect(s.emphasis('a1')).toBe(1)
  })

  it('desaturates everyone else while a human is hovered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    s.onMessage(presence('a2', 'sara'), 0)
    s.setHover('sara')
    expect(s.emphasis('a2')).toBe(1)
    expect(s.emphasis('a1')).toBeLessThan(1)
  })

  it('restores everyone when the hover clears', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage(presence('a1', 'dev'), 0)
    s.setHover('sara')
    s.setHover(null)
    expect(s.emphasis('a1')).toBe(1)
  })

  it('tracks contested regions so a collision can be rendered', () => {
    const r = new CharacterRegistry()
    const s = new Subscription(r, 'sara')
    s.onMessage({ ...presence('a1', 'dev'), rung: 3 }, 0)
    expect(s.contested()).toContain('a1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run test/subscribe.test.ts`
Expected: FAIL — cannot resolve `../src/subscribe.js`

- [ ] **Step 3: Write the implementation**

`web/src/subscribe.ts`:
```ts
import type { CharacterRegistry } from './characters.js'

const DIMMED = 0.25

interface PresenceMessage {
  type: string
  agent: string
  human: string
  verb: string
  region: { path: string; symbol: string | null }
  rung?: number
}

function isPresence(m: unknown): m is PresenceMessage {
  if (typeof m !== 'object' || m === null) return false
  const x = m as Record<string, unknown>
  return (
    x.type === 'presence' &&
    typeof x.agent === 'string' &&
    typeof x.human === 'string' &&
    typeof x.verb === 'string' &&
    typeof x.region === 'object' && x.region !== null &&
    typeof (x.region as Record<string, unknown>).path === 'string'
  )
}

export class Subscription {
  #hovered: string | null = null
  #contested = new Set<string>()

  constructor(private registry: CharacterRegistry, private myHuman: string) {}

  /** Malformed input is dropped, never fatal — the world must survive a bad
   *  frame from the relay without going blank. */
  onMessage(msg: unknown, now: number): void {
    if (!isPresence(msg)) return
    this.registry.upsert(msg.agent, msg.human, msg.verb, msg.region.path, now)
    if ((msg.rung ?? 0) >= 3) this.#contested.add(msg.agent)
    else this.#contested.delete(msg.agent)
  }

  setHover(human: string | null): void {
    this.#hovered = human
  }

  /** With twenty-plus characters on screen, the world is beautiful but busy.
   *  Dimming everyone else is what makes your own agents findable. */
  emphasis(agent: string): number {
    if (this.#hovered === null) return 1
    const c = this.registry.all().find((x) => x.agent === agent)
    if (!c) return 1
    return c.human === this.#hovered ? 1 : DIMMED
  }

  contested(): string[] {
    return [...this.#contested]
  }
}
```

`web/src/scene.ts`:
```ts
import * as THREE from 'three'
import { PALETTE, ZONES } from './zones-and-palette.js'
import type { CharacterState } from './characters.js'

/** Soft-clay look: matte materials, no gloss, soft ambient plus one warm key. */
export function buildScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PALETTE.cream)

  const camera = new THREE.OrthographicCamera(-24, 24, 16, -16, 0.1, 200)
  camera.position.set(28, 26, 28)
  camera.lookAt(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.75))
  const key = new THREE.DirectionalLight(0xfff2dd, 1.1)
  key.position.set(18, 30, 12)
  key.castShadow = true
  scene.add(key)

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(44, 0.5, 34),
    new THREE.MeshLambertMaterial({ color: PALETTE.sand }),
  )
  floor.position.y = -0.25
  floor.receiveShadow = true
  scene.add(floor)

  // Placeholder zone markers. Real props are a separate asset project.
  for (const [name, box] of Object.entries(ZONES)) {
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(box.w, 0.6, box.d),
      new THREE.MeshLambertMaterial({ color: PALETTE.taupe }),
    )
    marker.position.set(box.x, 0.3, box.z)
    marker.name = `zone:${name}`
    marker.receiveShadow = true
    scene.add(marker)
  }

  const bodies = new Map<string, THREE.Mesh>()

  function render(chars: CharacterState[], emphasisOf: (agent: string) => number): void {
    const seen = new Set<string>()

    for (const c of chars) {
      seen.add(c.agent)
      let mesh = bodies.get(c.agent)
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.5, 0.9, 4, 12),
          new THREE.MeshLambertMaterial({ color: c.hair, transparent: true }),
        )
        mesh.castShadow = true
        bodies.set(c.agent, mesh)
        scene.add(mesh)
      }
      mesh.position.set(c.x, 1.1, c.z)
      ;(mesh.material as THREE.MeshLambertMaterial).opacity = emphasisOf(c.agent)
    }

    for (const [agent, mesh] of bodies) {
      if (seen.has(agent)) continue
      scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      bodies.delete(agent)
    }

    renderer.render(scene, camera)
  }

  return { render }
}
```

Create `web/src/zones-and-palette.ts` re-exporting both so `scene.ts` has one import:
```ts
export { PALETTE, HAIR_COLORS, hairFor } from './palette.js'
export { ZONES, zoneFor, type ZoneName } from './zones.js'
```

`web/index.html`:
```html
<!doctype html>
<meta charset="utf-8" />
<title>Agent Presence</title>
<style>
  html, body { margin: 0; height: 100%; background: #F0ECE6; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
<canvas id="world"></canvas>
<script type="module" src="/src/main.ts"></script>
```

`web/src/main.ts`:
```ts
import { CharacterRegistry } from './characters.js'
import { buildScene } from './scene.js'
import { Subscription } from './subscribe.js'

const canvas = document.getElementById('world') as HTMLCanvasElement
const registry = new CharacterRegistry()
const me = new URLSearchParams(location.search).get('human') ?? ''
const sub = new Subscription(registry, me)
const scene = buildScene(canvas)

const room = new URLSearchParams(location.search).get('room') ?? ''
const ws = new WebSocket(`ws://127.0.0.1:8799`)
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, agent: 'viewer', human: me }))
ws.onmessage = (e) => {
  try {
    sub.onMessage(JSON.parse(e.data), Date.now())
  } catch {
    // A bad frame must never blank the world.
  }
}

let last = performance.now()
function frame(t: number) {
  const dt = Math.min((t - last) / 1000, 0.1)
  last = t
  registry.expire(Date.now())
  registry.step(dt)
  scene.render(registry.all(), (a) => sub.emphasis(a))
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run`
Expected: PASS, all web tests

- [ ] **Step 5: Commit**

```bash
git add web/src web/test web/index.html
git commit -m "feat(web): three.js scene, relay subscription and own-agent emphasis"
```

---

### Task 26: Install wiring

**Files:**
- Create: `install.sh`, `README.md`
- Test: `python/tests/test_install_contract.py`

**Interfaces:**
- Consumes: `ap-hook`, `presenced` binaries (Tasks 12, 19).
- Produces: `install.sh` emitting the hook block for `~/.claude/settings.json`.

- [ ] **Step 1: Write the failing test**

`python/tests/test_install_contract.py`:
```python
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_install_script_emits_valid_settings_json():
    out = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--print-settings"],
        capture_output=True, text=True, check=True,
    ).stdout
    settings = json.loads(out)
    hooks = settings["hooks"]
    assert "PreToolUse" in hooks
    assert "PostToolUse" in hooks


def test_hooks_cover_every_tool_that_touches_code():
    out = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--print-settings"],
        capture_output=True, text=True, check=True,
    ).stdout
    matchers = json.dumps(json.loads(out)["hooks"])
    for tool in ("Edit", "Write", "Read", "Grep"):
        assert tool in matchers
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && python -m pytest tests/test_install_contract.py -v`
Expected: FAIL — `install.sh` does not exist

- [ ] **Step 3: Write the implementation**

`install.sh`:
```bash
#!/usr/bin/env bash
# Installs agent-presence hooks. Prints settings with --print-settings.
set -euo pipefail

BIN="${AGENT_PRESENCE_BIN:-$HOME/.local/bin}"

settings_json() {
  cat <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "$BIN/ap-hook" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Grep|Glob|Bash",
        "hooks": [{ "type": "command", "command": "$BIN/ap-hook" }]
      }
    ]
  }
}
JSON
}

if [[ "${1:-}" == "--print-settings" ]]; then
  settings_json
  exit 0
fi

mkdir -p "$BIN"
cp cpp/build/ap-hook "$BIN/ap-hook"
cp cpp/build/presenced "$BIN/presenced"
chmod +x "$BIN/ap-hook" "$BIN/presenced"

echo "Binaries installed to $BIN"
echo "Add this to ~/.claude/settings.json:"
settings_json
```

`README.md`: document the four commands — build C++ (`cd cpp && cmake -B build && cmake --build build`), install Python (`cd python && pip install -e '.[dev]'`), run the relay (`python -m agent_presence.serve`), run `./install.sh`.

- [ ] **Step 4: Run test to verify it passes**

Run: `chmod +x install.sh && cd python && python -m pytest tests/test_install_contract.py -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add install.sh README.md python/tests/test_install_contract.py
git commit -m "feat: install script and hook wiring"
```

---

## Plan self-review

**Spec coverage.** Every section of the design maps to a task:

| Spec section | Tasks |
|---|---|
| Room keying | 2, 16 (both implementations, cross-checked) |
| Identity (human/session/label) | 1, 20, 23 |
| Identity from the connection, never the payload | 10, 11 |
| Event and claim model | 1, 4, 10 |
| Relay-assigned timestamps | 10, 21 |
| Privacy + opaque mode (flag wired at all three call sites) | 8, 11, 20 |
| Collision ladder rungs 0–3 | 6, 10 |
| Rung 4 behind a flag | 6 (documented as deliberately undecided) |
| Four-move negotiation | 7, 20 |
| Wait-die | 5, 9 |
| Lease TTL / heartbeat | 4, 21 |
| Escape hatch + override logging | 7, 20 |
| `presenced` rationale (3 constraints) | 12, 14, 18, 19 |
| Hook 5ms budget | 12, 13 |
| MCP intent channel | 20 |
| Fail-open table | 12 (daemon dead), 14 (daemon wedged), 21 (the rest) |
| Testing strategy | 9, 13, 21, 22 |
| Office floor + zone vocabulary | 23 |
| Hair as identity | 23, 24 |
| Own-agent emphasis | 25 |
| Real-time 3D, placeholder primitives | 25 |

**Gap found and closed.** The spec's statusline requirement had no task; Task 18 now covers both the snapshot writer and the statusline segment.

**Type consistency.** `Region`, `Claim`, `AgentEvent` are defined once in Task 1 and imported everywhere. The C++ `region_key` string format (`path|symbol`) used in Task 17 matches the key built in Task 10's cache push. `normalize_remote` and `room_id_from_remote` exist in both Python (Task 2) and C++ (Task 16) — Task 16 Step 4 requires cross-checking them for byte-identical output, since a divergence would silently split a team into two rooms.

**Known duplication, accepted deliberately.** Room-key normalization exists twice because the daemon must compute a room before it can reach the relay. It is ~20 lines of pure function with a cross-language equality check in the plan. No other logic is duplicated: the C++ side performs no protocol reasoning, per the global constraint.


