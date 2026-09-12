# Agent Sync — Design

**Date:** 2026-08-06
**Status:** Design approved, ready for implementation planning
**Working title:** Agent Sync (product name not yet chosen; slug `agent-sync` used throughout)

## Thesis

When several people in a company each run coding agents against the same repository, two things are missing at once: humans can't see what the agents are collectively doing, and the agents can't see each other at all. Today they collide — duplicating work, overwriting each other, producing merge conflicts nobody noticed until later.

Both gaps are served by the same underlying data. **One protocol, two audiences:** a single event stream rendered as an ambient animated world for humans, and as claims and negotiation messages for agents.

The visualization is the wedge — it installs in one step, costs the user nothing, and is worth looking at. The coordination layer is the substance. They are not two products.

## Scope

Thin vertical slice, entire chain working end to end:

- Hooks → relay → animated world (the human path)
- Hooks → relay → collision ladder → context injection back into the second agent (the agent path)

Deliberately narrow for v1: file- and symbol-level granularity, room membership derived automatically from the git remote (no access control beyond possession of the repo), single repo per room.

**Non-goals for v1:** persistent history, org-wide analytics dashboards, editor extensions, non–Claude Code agent clients, billing, SSO.

## Architecture

Four processes.

```
Claude Code agent
   │
   ├─ hooks (PreToolUse / PostToolUse / SessionStart / SessionEnd)
   │     └──► unix socket ──┐
   │                        │
   └─ MCP server ───────────┤
      (deliberate intent)   │
                            ▼
                   presenced  (one per machine)
                   • debounce + batch
                   • path → repo/room mapping
                   • privacy redaction
                   • cached room snapshot on disk
                            │  one WebSocket per machine
                            ▼
                    relay  (hosted, repo-scoped rooms)
                    • authoritative claim/lease registry
                    • fan-out to all room members
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        web dashboard              statusline segment
```

### Why `presenced` exists

Three constraints force a local daemon rather than hooks talking directly to the relay:

1. **Hooks must be effectively free.** `PreToolUse` runs before every Read/Edit/Grep. A network call there adds latency to every tool call in the session. A unix socket write is microseconds.
2. **The statusline refreshes every second** and must never perform network I/O. It reads a small JSON snapshot the daemon keeps fresh on disk.
3. **One WebSocket per machine, not per agent.** A developer running four parallel agents is one connection, one identity, one room membership.

### Component responsibilities

- **hooks** — observe, emit, exit. The only hook that ever blocks is `PreToolUse` on Edit/Write, and only when the daemon's *local* lease cache already shows a conflict. No network round-trip in the hot path.
- **MCP server** — the deliberate channel: `who_else_is_here`, `claim_work`, `release`, `message_agent`. Carries intent that hooks cannot infer.
- **relay** — the only authoritative stateful component. Owns lease arbitration and fan-out.
- **dashboard / statusline** — pure subscribers. No writes.

Hooks and MCP produce the **same event stream**. The relay does not care which produced an event; hooks contribute observed facts, MCP contributes declared intent, and they differ only by a confidence field.

## Room keying and identity

**Room ID** = truncated `sha256` of the normalized git remote URL. Normalization collapses `git@github.com:acme/api.git` and `https://github.com/acme/api` to one key: lowercased, `.git` stripped, protocol and host-form discarded.

Consequence: anyone who clones the repo joins the correct room with zero configuration — no invites, no room codes, no admin setup. Hashing rather than sending the URL means the relay never learns private repo names. Repos with no remote fall back to local-only mode.

**Identity** has three levels, all of which the visualization needs:

- **human** — derived from `git config user.email`, hashed for display, with a name and colour
- **session** — one agent run (`agent_id`)
- **label** — what the agent calls itself, if declared via MCP

One human may have many concurrent agents; the world must cluster them visually by human.

**Identity is taken from the authenticated connection, never from a client-supplied field.** A connection declares who it is once, when it joins; after that the relay reads `human` and `agent` off the connection and ignores whatever the message body says. Trusting the body would let any room member release, renew or steal a teammate's lease just by naming them. Identity fields in a payload are treated as decoration — fine for logging, never used for a lease decision.

## Event and claim model

### Event

```json
{
  "room": "a3f9…",
  "human": "sara",
  "agent": "sess_01H…",
  "kind": "touch",
  "source": "hook",
  "verb": "read",
  "region": { "path": "src/auth/session.ts", "symbol": "signIn", "lines": [40, 88] },
  "ts": 1754500000
}
```

`source: "hook"` carries high factual confidence and no intent. `source: "mcp"` carries declared intent that may be aspirational. The ladder weights them differently: an **observed** edit outranks a **declared** plan.

### Claim

```json
{
  "scope": { "path": "src/auth/**", "symbol": "signIn" },
  "intent": "refactor session handling to use JWT",
  "state": "held",
  "ttl_s": 90,
  "expires_at": 1754500090
}
```

`presenced` heartbeats renewals every 30s. **Nothing is permanent.** If an agent crashes, a laptop sleeps, or a process is killed, every lease it holds evaporates within 90 seconds. This is the deliberate inverse of a lock file: the failure mode is *losing protection*, never *wedging a teammate*. Presence events carry a shorter 30s TTL, which is what makes a character wander off when its agent moves on.

### Contention

```json
{ "type": "contend", "region": { "path": "src/auth/session.ts", "symbol": null } }
```

Sent by `presenced` when it stops an edit, and by nothing else. It records that this agent wanted the region; it never takes a lease, because taking one is the MCP tools' deliberate job and a daemon has no business doing it on an agent's behalf.

It exists because the blocking path is entirely local: a PreToolUse edit is answered from the daemon's own lease cache with no relay round trip, which is what keeps it inside its budget, and a blocked edit has no PostToolUse. Without this frame the relay never hears that anybody wanted the region, and the deadline below never starts on the path that matters.

Renewals are unbounded only while nobody else wants the region. The moment somebody asks, the holder's lease gets a deadline — one TTL if the asker outranks it, fifteen minutes if it does not — and the holder is told the deadline on the ask, while it still has the region. Nothing is ever taken mid-edit. See §5.2 of `policy-design.md` for why an uncapped renewal made "wait" mean "wait forever".

**All timestamps are assigned by the relay on receipt, never by clients.** Deadlock resolution compares lease ages; client-assigned timestamps plus clock skew would let two agents each believe they are older. Same rule for identity: the relay uses the identity of the connection the message arrived on, not the `agent`/`human` fields in the message.

### Privacy

| Sent | Never sent |
|---|---|
| File paths, symbol names, line ranges | File contents, diffs |
| Verb, timestamps, agent/human identity | Prompts, agent reasoning, model output |
| Declared intent strings (MCP, opt-in) | Env vars, secrets, command output |

**Opaque mode** (org-level toggle): paths are hashed client-side before leaving the machine. The relay still detects collisions and arbitrates leases, because collision detection is equality on region keys and works identically on hashed input. The dashboard renders anonymized shapes. Readability is lost; function is not.

The toggle is a real flag, not a spare function nobody calls: set `AGENT_SYNC_OPAQUE=1` (`true`, `yes`, `on` also count) and every path and symbol is hashed on the way out — the redaction pass, the MCP claim tools, and the last hop before the wire. It's read per call, so flipping it doesn't need a restart. Both channels have to hash the same way or the lease table splits in two, so MCP claims run through the same helper the hook path does. A region that's already hashed carries a marker and isn't hashed twice.

**Retention:** rooms are ephemeral. Events TTL out; nothing is written to durable storage in v1.

## The collision ladder

Governing rule: **attention is the scarce resource.** Each rung spends more of it, so each must earn it.

| Rung | Condition | Response | Interrupts |
|---|---|---|---|
| 0 | Same file/zone, both reading | Characters co-locate in the world | No |
| 1 | A editing, B reading same file | Statusline signal for B | No |
| 2 | Both editing same file, disjoint symbols | Context injected into B describing A's work | No |
| 3 | Overlapping symbol or line range | Structured negotiation, one round | Yes |
| 4 | Declared intents semantically equivalent | Redundant-work interrupt | Yes |

Rungs 0–2 never block anything. Rung 2 carries most of the practical value at zero attention cost — the second agent simply knows, and models route around hazards they can see.

**Injection mechanism.** `PreToolUse` on Edit/Write returns JSON that Claude Code feeds back to the agent: additional context (rungs 2 and 4) or a denial with reason (rung 3). Awareness therefore *pushes* rather than requiring the agent to poll, arriving at the moment before a write. The decision is made against the daemon's locally cached lease table; worst case the cache is ~1s stale and a collision is missed, which is merely the status quo.

**Rung 3 negotiation** is bounded, not free-form conversation. The blocked agent receives a structured brief (who, their declared intent, the contested region) and exactly four moves:

- `DEFER` — wait for their lease, then proceed
- `SPLIT` — claim a disjoint sub-region and continue now
- `HANDOFF` — pass my requirement to them, drop my claim
- `PROCEED` — assert independence, with a logged reason

One round trip, hard timeout, default to `DEFER` for the later claimant. Free-form negotiation between two agents is untestable and they will agree on wrong things at length; four enumerable moves are testable and their failure modes are finite.

**Deadlock** is resolved by **wait-die** on relay-assigned lease timestamps: an older requester waits, a younger one aborts, drops its leases and retries with backoff. The relation is asymmetric by construction — of any two agents exactly one can be the waiter, with ties broken on agent id — so a wait cycle is unreachable and no cycle detection is needed anywhere.

Note which way round it goes: the requester is the one that waits or dies. A lease already held is never taken away, so no agent is preempted mid-edit and no in-progress work is destroyed. Wound-wait would give the opposite behaviour — the older requester preempts the holder — and that's the trade we're not making. Combined with 90s expiry, no team state is permanently stuck.

**Rung 4** requires declared intent plus embedding similarity at the relay. Build the hook now, keep semantic matching behind a flag until there is real traffic to tune against. A noisy rung 4 would poison trust in rungs 0–3.

**Escape hatch, always.** Every block is overridable by the agent (`PROCEED`) and by the human. False positives are certain; a system that cannot be overridden gets removed. Overrides are logged and are the primary signal for tuning the ladder.

## The world

### Art direction

Soft 3D clay diorama. Matte clay and vinyl toy materials, chunky rounded forms with imperfect handmade edges, soft global illumination, warm key light, gentle ambient occlusion, subtle tilt-shift. No outlines, no gloss, no text or iconography in the scene.

Palette is pinned to explicit hex values (muted vintage / spring / coffee), and prompts must specify them literally or generations drift:

```
cream #F0ECE6   sand #E9E0CE     taupe #C3B39B    sage #E5E1D2
butter #F7DFAF  mustard #D6B45C  caramel #C0762A  coffee #B0674F
terracotta #D9714F  salmon #E8946C  dusty rose #D8BDB6  mauve #A5738C
slate blue #8A94A3  navy #35455C  deep plum #4A1F3D
```

No neon, no pure white or black, no bright primaries. Reference renders are in `.superpowers/brainstorm/69985-1786055325/art/`.

### Layout: one office floor, zoned by activity

The world is a single large open-plan office rendered corner to corner, not a per-directory structure. Directory-shaped worlds were rejected: they make every repo look different and become unreadable past a few hundred directories.

Instead, **zones map to kinds of work**, which is a fixed vocabulary that works for any repo at any team size. Characters walk to the zone matching what they are actually doing, so team activity is readable across the room without labels.

| Zone | Meaning |
|---|---|
| Reception desk + queue | Incoming work, tasks waiting to be picked up |
| Vault with padlock | Auth, secrets, credentials |
| Wall of ringing phones | External API and service calls |
| Conveyor belt | CI/CD pipeline; a crate falling off is a failed build |
| Tangled cable ball | The dependency graph |
| Crate towers | Build artifacts and containers |
| Desk on fire + extinguisher | Failing tests or a live incident |
| Rubber ducks | An agent reasoning through a problem |
| Tortoise hauling a crate | A long-running or slow job |
| Whiteboard of scribbles | Planning and design work |
| Hammock | Idle agent — session open, nothing happening |

Layout constraint: no prop may bisect the floor. The room must remain one connected space characters can cross; long props (the conveyor) hug a wall.

### Characters

Per-human identity is carried by **hair colour**, drawn from the palette (terracotta, slate blue, mustard, mauve, coffee, salmon) — legible at thumbnail size and distinguishable with four-plus characters on screen.

Customization: 3 unisex face styles; 4 hairstyles (short, bald, unisex wolf cut, ponytail); garment slots for t-shirt, sweater, pants, shorts, skirt and shoes, each with 5 colour options.

Required actions, shared by all characters regardless of appearance: walk, idle, type, co-read, sleep under desk, carry plank (two-character paired action), stack mugs, collide/reach, negotiate, hammock, climb ladder, haul crate.

### Rendering

Real-time 3D in the browser (Three.js). Matte clay, soft shadows and chunky low-poly forms are cheap to render, so the concept art is achievable live rather than as pre-rendered frames.

This is a decision, not an incidental one. It gives correct depth sorting from the z-buffer (characters walk behind and in front of props with no manual layering), free facing directions, free garment recolouring via material tints, and poses that apply to every character.

The wide shot is the **ambient** view. Reading a specific collision requires the camera to zoom into a zone; the busy wide shot is not the working view. With many characters on screen, a viewer's own agents must be visually distinguished — the chosen device is desaturating everyone else on hover.

### Asset pipeline

**Decision: 2D layered sprites are rejected.** The specified character system as flat sprites requires roughly 3,700 pixel-registered frames (12 actions × 4 facings × ~6 frames × ~13 separable layers). Image generation cannot produce parts that register across that many frames, and baked sprites cannot satisfy "any pose regardless of how the character was made."

**Chosen path:** ~34 3D assets — one rigged base character, 4 hair meshes, 3 face textures, 6 garment meshes, ~20 props. Colours become material tints, facings become rotation, depth becomes the z-buffer, and poses become clips authored once and shared.

Higgsfield's `image_to_3d` supports `enable_rigging`, `pose_mode: a-pose` and texturing, and is the intended generation route. `tripo_h3_1_image_to_3d` is priced at 9 credits per mesh.

Custom actions (sleep under desk, paired plank carry, mug stack) are not available in preset animation libraries and must be hand-authored; the paired action additionally needs a two-character sync mechanism.

**Asset production is deferred to a separate project** and is not part of this design's implementation plan. Implementation proceeds against placeholder primitives.

## Failure modes

The system sits on the critical path of every tool call and therefore **must fail open**. Every failure resolves to "the agent behaves exactly as if nothing were installed."

| Failure | Behaviour |
|---|---|
| Relay unreachable | Daemon buffers locally, hooks stop consulting leases, all agents degrade to solo mode, silently |
| Daemon dead | Hook finds no socket, exits 0 in under 1ms; statusline segment blank |
| Daemon alive but wedged — bound, listening, accepting, processing nothing | Prevented, not tolerated. The accept loop is non-blocking end to end: the listen fd is `O_NONBLOCK`, every accepted connection is `O_NONBLOCK`, and each one gets a few milliseconds of read budget before it's closed. A client that connects, writes half a line and stops is dropped along with its partial line |
| Agent crashes holding leases | 90s TTL expiry; no manual cleanup |
| Event flood (e.g. grep over 10k files) | Daemon coalesces by region and samples; relay never sees the storm |
| Network partition | Relay is sole authority; on reconnect the daemon discards optimistic local state and re-syncs |
| False collision | Override available to both agent and human, and logged |

**Hook latency budget: 5ms hard cap.** If a socket write would block, the event is dropped rather than queued. A dropped event costs one frame of animation; a blocked hook costs the user's patience on every tool call.

**The wedged daemon is the failure the rest of the table doesn't catch.** A dead daemon is fine: there's no socket, the hook exits, everyone degrades to solo mode. A wedged one is worse, because from the outside it looks healthy. The socket file is there, `connect()` succeeds, hooks keep writing — and nothing is ever read, so presence freezes at whatever it happened to be and the lease cache goes stale while still looking live. The daemon is single threaded, so one client that connects and then stops talking is enough to cause it: a blocking read on that connection parks the loop forever. Hence the rule: no blocking read anywhere in the accept path, and a per-connection budget after which the connection is closed and whatever it never terminated with a newline is thrown away. A half-line is never carried into the next connection either; replaying it would corrupt the next client's event.

## Testing

Almost none of this requires real agents.

- **Deterministic simulation** is the backbone: virtual clock, N simulated agents, seeded random schedules. Forty agents colliding runs in milliseconds and a failing seed reproduces exactly.
- **Property tests** over random claim/release schedules asserting the two invariants that matter: no deadlock is reachable, and every lease eventually expires.
- **Table-driven unit tests** for pure functions: room-key normalization (ssh/https/`.git`/case matrix), region overlap, rung classification, wait-die ordering.
- **Chaos tests**: kill the daemon mid-lease, partition the relay, skew clocks, stall a client mid-line against the daemon socket — asserting the fail-open table above, wedge row included. The wedge test runs `poll_once` on a helper thread with a hard deadline, because a wedged daemon never returns and the suite has to report a failure rather than hang.
- **Latency regression test** in `scripts/ci-local.sh` asserting hook p99 under 5ms.
- **One end-to-end integration test** with two real Claude Code sessions and a scripted task, asserting the second agent's injected context contains the first's intent and that no double-edit occurs. Exactly one — it proves the product works but is too slow and flaky to base a suite on.

## Deferred decisions

These are intentionally out of scope for this design and do not block implementation:

1. Product name.
2. Relay hosting and persistence technology (any WebSocket server with a TTL keyed store satisfies the contract).
3. Asset production, per the pipeline section above.
4. Rung 4 semantic-similarity model and threshold, to be tuned against real traffic once rungs 0–3 are in use.
5. Adapters for non–Claude Code agent clients.
