# Policy engine and priority arbitration

**Superseded — read this first:** this spec cites `cpp/daemon/*` files that
no longer exist — the C++ daemon was replaced by the Go one. See
`docs/go-daemon.md` for the current architecture. The policy design itself
(priority tiers, the line between policy and lease grants) is kept because
it's still the reasoning behind the code, not because the file paths still
resolve.

Branch: `feat/policy-engine`, worktree `/Users/mohsen-agentai/src-2/sync-policy`.
Base: `fix/lease-protection` (transport wiring plus the load fixes).

This is one spec built from three proposals. Where they disagreed, the call is made
here and the losing option is not carried along as a flag.

---

## 0. The line that makes everything else safe

**Policy governs presentation and blocking. It never governs lease grants.**

`LeaseRegistry.acquire`, `wait_die.resolve` and `same_region` keep running exactly as
they do now, for every rung, under every policy. A room configured to `rung3 = "notify"`
still refuses the second claim, still returns `decision: wait|abort`, still publishes the
lease — it just doesn't stop the edit. The lease table stays a truthful record of who
holds what; the effect decides how loudly that truth is told.

Two consequences worth stating up front:

- No policy value can corrupt arbitration. The deadlock argument survives the whole
  effect lattice untouched.
- The one thing that *does* touch arbitration is priority (§4), and it is a single
  change to one ordering key, argued separately in §5.

Corollary for rung 4: a `silent` effect at rung 4 also short-circuits the similarity
computation, so the volume knob doubles as a way to stop paying for the comparison.

Rung 4 landed while this branch was open (`feat/rung-4`, merged in), so the original
plan of "ships as still off, `silent` by default" no longer holds. It has its own off
switch — `AGENT_PRESENCE_RUNG4`, down unless you set it — and a `silent` default behind
that flag would mean turning the feature on and getting nothing. So the default is
`context`: the flag decides whether rung 4 runs, the effect decides how loudly a hit is
reported.

---

## 1. Effects

Five, totally ordered by attention spent. `silent < notify < context < ask < deny`.

| effect | hook (PreToolUse) | statusline / world | relay reply | MCP `claim_work` |
|---|---|---|---|---|
| `silent` | nothing | peer shown, no collision marker | `ack` | `granted` as usual |
| `notify` | nothing | peer shown with rung marker | `ack` + `rung` | brief in `who_else_is_here` only |
| `context` | `additionalContext` | as notify | `notice` frame (holder, intent) | brief on the result |
| `ask` | `permissionDecision: "ask"` | as notify | `negotiate` + `decision` | brief + moves, `granted: false` |
| `deny` | `permissionDecision: "deny"` | as notify | `negotiate` + `decision` | brief + moves, `granted: false` |

The ordering is what floors and ceilings clamp on. `max` is "stricter", `min` is "quieter".

Note `notify` renders nothing on the hook. Today's `hook_output` emits
`additionalContext` for any rung in 1..2, but the daemon can only ever return rung 0 or
rung 3 (`decide.cpp` has no symbol to key rungs 1-2 on), so that branch is unreachable
and no behaviour changes. Rungs 1-2 reach a human through the relay's presence fan-out,
which is where `notify` lands.

---

## 2. Layers

Five, by authority, least to most. Path globs are **not** a layer — they are a selector
inside a layer. One axis of authority, one axis of specificity, resolved in a fixed
order. Two axes would produce a lattice and then somebody has to rule on whether a
repo-level glob beats a user-level blanket, which is a question with no good answer.

| layer | file | owner | parsed by |
|---|---|---|---|
| `builtin` | compiled in | us | client and relay |
| `org` | `$AGENT_PRESENCE_ORG_POLICY`, else `/etc/agent-presence/policy.toml` | whoever runs the relay | relay only |
| `repo` | `<repo_root>/.agent-presence/policy.toml`, committed | the team, via PR review | client only |
| `user` | `$XDG_CONFIG_HOME/agent-presence/policy.toml`, else `~/.config/agent-presence/policy.toml` | the person | client only |
| `session` | `$AGENT_PRESENCE_POLICY` file, then `AGENT_PRESENCE_POLICY_RUNG<N>` env | this run | client only |

Effects: `session > user > repo > org > builtin`. The personal file beats the committed
one on effects, because it's your machine and there is no enforcement — pretending
otherwise is theatre.

Floors are the exception, and they are declarable only in `org` and `repo`. A `[floor]`
block in a `user` or `session` file parses, warns, and is ignored; silently dropping it
would let someone believe they'd hardened their own setup.

There is deliberately no ceiling mechanism other than `mode = "observer"` (§3, step 2).
Anyone must always be able to make their own agent stricter.

### Who enforces what

- **Org floors** are the only floors the relay enforces. It resolves them itself and
  pushes the resulting table to every daemon in the room.
- **Repo floors** are resolved client-side by every honest client from the committed
  file. They are a coordination device, not enforcement. A client that deletes the file
  only lowers its own protection, which is the same power it already has by not
  installing anything.
- **Hook floor** is compiled into `hook.cpp` and is a last resort against a hostile local
  writer on the decision socket — see §8.

---

## 3. Resolution

```
resolve(rung, path, ctx) -> Resolution

  1. effect = the winning rule's effect, where the winner is:
       highest layer in (session, user, repo, org, builtin) that has a match;
       within that layer, a path rule beats the blanket rule;
       among path rules, longest literal prefix wins;
       exact tie -> later in file order, and `ap policy check` warns.

  2. ceiling = notify   if the winning layer's mode is "observer", else none
     effect  = min(effect, ceiling)

  3. floor   = max(BUILTIN_FLOOR[rung], org.floor(rung, path), repo.floor(rung, path))
     effect  = max(effect, floor)                # floors beat ceilings, always

  4. if ctx.unattended and effect == "ask": effect = "deny"
```

Step 3 beating step 2 is the one place the two orderings meet, and it has to be that way
round: `mode = "observer"` is a personal preference and a floor is a statement by the
people responsible for the code.

Step 4: `ask` means "interrupt the human". An unsupervised agent has no human, so `ask`
degrades to a hang or a silent auto-answer. Promoting it to `deny` gives the model the
structured brief and four moves instead, which it can act on. `unattended` is
self-declarable because it can only ever tighten.

`Resolution` carries every input to this calculation, not just the answer. That is what
`ap policy explain` and `why_was_i_blocked` print (§7, req 4).

---

## 4. Priority

### 4.1 Where it comes from — not the client

`conn.agent` and `conn.human` come straight off the join frame (`serve.py:186-187`) and
`human_id()` is `git config user.email`'s local part. Both are attacker-controlled in the
only threat model that matters: an agent that reads `CLAUDE.md`, notices the roster, and
sets `AGENT_PRESENCE_HUMAN=sara`. Any scheme keyed on the declared name is decoration.

So priority never appears in `policy.toml`. It lives in a separate roster the relay reads
and the client does not.

**`.agent-presence/principals.toml`**, committed at repo root, read only by the relay:

```toml
version = 1
default_tier = "normal"

[[principal]]
id           = "sara"
display      = "Sara"
attended     = "normal"      # a human is at the keyboard
unattended   = "elevated"    # nobody is
token_sha256 = "9f2c…"       # 64 hex

[[principal]]
id           = "release-bot"
attended     = "critical"
unattended   = "critical"
token_sha256 = "1ab4…"
```

The secret lives at `~/.config/agent-presence/token` (0600) or `$AGENT_PRESENCE_TOKEN`,
never in the repo. The roster holds only the hash, so a leaked roster leaks nothing.
Plain sha256, not argon2: the token is 32 random bytes from `secrets.token_urlsafe`, not
a password. There is no dictionary to defend against and a KDF would be a dependency for
zero benefit. `tomllib` is stdlib on 3.12, so the whole feature adds no dependency.

### 4.2 Tiers

Four named rungs, not an open integer. An open range is an arms race; four names force a
conversation.

```
background = 0   normal = 1   elevated = 2   critical = 3
```

`normal` is the default and the identity element: a room with no roster behaves exactly
as it does today.

### 4.3 The supervision band

A principal's roster entry is a band `[attended, unattended]`. The client-supplied
`unattended` flag selects *within* that band. It can never exceed `unattended`.

A lying client can therefore only impersonate itself at its own ceiling. Sara's attended
session claiming to be unattended gets Sara's unattended tier, which Sara owns. That is a
mislabelling, not an escalation, and it costs nobody but Sara. The general rule, worth
stating because it makes the whole surface easy to check:

> Client-supplied fields may only select within a verified band. Verified data sets the
> ceiling.

Why unattended ranks *above* attended, which reads backwards at first: an unattended
agent has nobody to notice a block and re-drive it. A blocked attended session costs a
human ten seconds; a blocked unattended one costs the whole run. Higher cost of losing,
higher priority.

Nothing detects supervision. `AGENT_PRESENCE_UNATTENDED=1` is set by whatever launches
the run — cron, CI, a wrapper. Default is attended, the lower tier, so winning is opt-in.

### 4.4 Failure modes, all fail open

| situation | result | log |
|---|---|---|
| no roster file | everyone `normal`, feature inert | INFO once at startup |
| no principal/token in join | `default_tier` | nothing |
| principal unknown | `default_tier` | INFO |
| token wrong or missing | `default_tier` | WARNING with principal + room |
| roster unparseable | whole roster inert, everyone `normal` | ERROR at startup, relay still serves |
| `attended > unattended` for a principal | that principal drops to `default_tier` | WARNING, relay still starts |

A bad token is never a join refusal. Refusing would make the relay a hard dependency and
break the fail-open principle the C++ side is built on end to end. Losing a rung is the
right punishment.

### 4.5 The trust assumption that remains — stated plainly

Describes the relay as it was before #11. `docs/threat-model.md` is the
current version: join is now authenticated once and latched per connection,
which closes the per-message re-declaration gap below, but room membership
itself is still unauthenticated — see that doc for what changed and what
didn't.

The relay has no transport authentication and this does not add any.

- Anyone who can reach the relay port can join any room whose id they can guess or
  derive, and get `default_tier`. Priority does not gatekeep membership.
- The bearer token authenticates one thing: the claim "I am principal X". It is a shared
  secret in a 0600 file. Anyone who can read that file becomes that principal — same
  boundary as an SSH key, no better.
- The room id itself is unverified. The relay believes it.
- The roster is committed, so anyone who can push to the repo can add themselves at
  `critical`. That is the intended control point: priority is reviewed in a PR like any
  other code.

So priority is a **seniority ordering among cooperating principals**, not a security
boundary. It reliably makes a senior person's unsupervised agents win contention against
teammates who are playing along. It does nothing against an adversary on the box, and it
is not sold as if it does. Real transport auth is a separate piece of work; this design
does not block it, since `Grant` is already the only thing arbitration reads.

---

## 5. Arbitration, and why deadlock stays unreachable

### 5.1 The change

One ordering key, from two parts to three:

```
(acquired_at, agent_id)  ->  (-priority, acquired_at, agent_id)
```

Priority is negated so the same `<` that means "older" also means "higher tier". There is
exactly one comparison in the whole system.

### 5.2 No preemption, but a deadline

Preemption is **not** in this design. Not as a knob, not behind a flag. A lease is never
taken from an agent that is mid-edit, at any tier gap. That invariant predates this work
and is worth more than the latency it costs.

What priority buys: a fresh senior agent contending with an older junior holder used to be
told to `abort` and retry. With priority in the key the senior is "older" in the order, so
it is told to `wait` — it keeps its place.

That was the whole design, and it did not work. `wait` meant wait indefinitely. A claim
frame from the holder reset its lease to a fresh 90 s and presenced sends one every 30 s,
so the sentence this section used to end with — "the senior waits out at most one 90 s TTL
and then wins" — was true only of a holder that had already stopped working. Measured: a
critical, roster-authenticated requester asking every five seconds for eight virtual hours
got 5760 refusals and zero grants.

So the ask now carries a deadline. Being asked for a region caps the holder's renewals:

| the asker | grace | why |
|---|---|---|
| outranks the holder (`wait`) | 90 s | one TTL, which is what the docs always claimed |
| does not (`abort`) | 15 min | the anti-starvation bound — see below |
| unauthenticated, in a room with an enforcing roster | none | #167 — see below |

When the cap is reached the lease ends on the ordinary lazy expiry, and the region is kept
for the agent that waited for 10 s so the ex-holder's next heartbeat cannot take it
straight back. Nothing is revoked; the holder is told its deadline on the ask, while it
still has the region and time to finish. Measured after: first critical grant at t = 95 s.

The 15 minute arm is the starvation guard, and it is the half that is easy to miss. A
junior contending a critical holder is told to `abort`, so it never reaches `wait` — but it
has still *asked*, and the ask still counts. Without it, priority would mean a normal-tier
agent behind a busy senior one waits forever, which is the same defect wearing the other
hat.

The third row is the answer to #167. Arming a deadline is the one thing an ask does *to*
somebody else — it decides when their lease ends — so it takes a rostered principal, in a
room that has a roster to be rostered in. An unauthenticated ask in such a room is still
recorded and still ranked; it just doesn't set the clock. Room membership and roster
membership are different gates (`threat-model.md`), and this is the line between them
drawn where it costs something: knowing a room id gets you in and gets you seen, it does
not get you a say in when a teammate stops editing.

Note the row is on the deadline, not on the 15-minute grace it was reported against. An
anonymous connection older than a normal-tier holder sorts *below* it in the order above
and so takes the `wait` branch — a 90 s cap. Gating the 15 minutes alone would have left
the shorter, sharper lever untouched.

Nothing here changes without a roster. A room with no `principals.toml` is one where
nobody can authenticate, so the bound stays exactly as the two rows above describe it.

### 5.3 The argument

Deadlock requires a cycle in the wait-for graph. There is an edge `x -> y` exactly when
`resolve` tells `x` to wait on `y`, which happens exactly when `key(x) < key(y)`.

1. `key(a) = (-priority(a), acquired_at(a), a)` is a tuple of three totally ordered
   components, so `<` on it is a strict total order over *distinct* agents. Agent id is
   the final component and agent ids are distinct, so `key(x) == key(y)` implies `x == y`.
2. `resolve` is never called with `x == y` (`acquire` and `Negotiator.open` both guard on
   `held.agent != requester`).
3. Therefore the edge relation is irreflexive, antisymmetric and transitive — it *is* the
   strict total order. A strict total order has no cycles. Deadlock is unreachable, not
   merely unlikely, and no cycle detection exists anywhere.

Step 1 holds only while both sides of a comparison are ordered on the same quantity. Two
invariants keep them so, and both are structural, not merely tested:

- **`acquired_at` is the agent's age, not the lease's.** Already true: `acquire` stamps
  `acquired_at=self.age_of(agent)` so a second lease inherits the first's timestamp. The
  comment in `leases.py` explains the bug this fixed and it applies verbatim to priority.
- **`priority` is the agent's tier, latched once.** Same trick, same reason: `acquire`
  stamps `priority=self.priority_of(agent, default=requested)`, where `priority_of`
  returns the tier already on the agent's live claims if there are any. An agent whose
  tier somehow changed mid-session cannot end up with two claims at two tiers, so it
  cannot read as senior when it asks and junior when it is asked.

The relay latches the `Grant` on the connection at join, exactly as it latches identity,
so a second join frame cannot re-rate a live connection.

### 5.4 The property test that catches a regression

`python/tests/test_priority_order.py` and an extension of
`python/tests/test_wait_die_cycle.py`:

1. **Order is total and strict.** Hypothesis over `(priority, acquired_at, agent)`
   triples: irreflexive, antisymmetric, transitive, and `resolve(x, y) == "wait"` iff
   `key(x) < key(y)`. Twenty lines, catches any future "special case" inside `resolve`.
2. **Stamps never diverge.** Extend the existing loop in
   `test_random_schedules_never_produce_a_wait_for_cycle` to assert
   `(c.priority, c.acquired_at) == registry.key_of(c.agent)` for every live claim, at
   every step. This is the exact test that already exists for `acquired_at`; the
   regression it would catch is "priority read from the connection instead of from the
   claim".
3. **No cycle, with priority.** Same randomised multi-room schedule, agents now drawn
   from a mix of tiers, `_wait_for_edges` rebuilt from the three-part key,
   `_find_cycle` asserted `None` at every step. 200 seeds × 300 steps.
4. **Priority cannot make both sides wait.** Targeted: a `critical` agent holding two
   leases of different ages against an `elevated` agent, the two-lease standoff from
   `test_wait_die_cycle.py`, asserted never to produce `wait`/`wait`.
5. **Simulation invariant.** `sim/simulation.py` gains a per-agent tier; the existing
   `Deadlock` check in `test_invariants.py` runs against a mixed-tier population and must
   still finish inside the TTL, so expiry is never what unjams a run.

---

## 6. Defaults

```
BUILTIN         rung0 = silent   rung1 = notify   rung2 = context   rung3 = deny    rung4 = context
BUILTIN_FLOOR   rung0 = silent   rung1 = silent   rung2 = silent    rung3 = notify  rung4 = silent
HOOK_FLOOR      rung0 = silent   rung1 = silent   rung2 = silent    rung3 = notify  rung4 = silent
PRIORITY        everyone normal, roster absent
```

Installing the policy engine and configuring nothing is a no-op. There is a golden test
for exactly that (§10).

**Rung 3 defaults to `deny`, not `ask`**, in order of weight:

1. Rung 3 is a fact — a relay-granted lease on a contending region under `same_region` —
   not an inference. Rung 4 is the inference and it defaults to off.
2. `ask` spends a human's attention. `deny` spends the model's, and the model gets a brief
   with four moves and a `PROCEED` escape hatch. Cheaper and more actionable.
3. For the unattended agents this feature exists to serve, `ask` has nobody to ask.
4. Bounded blast radius: the ask caps the holder's lease at 90 s (§5.2) and wait-die
   guarantees exactly one side backs off. The block carries that number, so the agent is
   told when to come back rather than only that it cannot pass.

**The floor at rung 3 is `notify`, not `silent`.** A silent rung 3 is the product lying:
two agents editing the same symbol with nothing said anywhere is the pre-install world. If
that is what you want, uninstall — and `mode = "observer"` says it honestly, in one word,
at zero interruption cost, while keeping the statusline and the world truthful.

**Rungs 0-2 are non-interrupting under every default** (requirement 5). `silent`, `notify`
and `context` all leave `permissionDecision` unset; only `ask` and `deny` set it, and
neither is a default below rung 3. A policy may raise rung 1 to `deny`; nothing in the
shipped tables does.

**`lease.ttl_s` is deliberately not configurable.** Three places hardcode 90 —
`leases.LEASE_TTL_S`, `RelayConfig.lease_ttl_ms`, and `hook.cpp:474`, which tells the
agent in prose *"Their claim expires on its own within 90 seconds."* Making it a knob
turns that sentence into a lie. Ship it fixed; revisit when the number is on the wire.

---

## 7. Terminal control

**A live-reloaded TOML file is the state. A small `ap` CLI is the verb surface. No slash
commands, no TUI, no MCP write path.**

- A TUI is for exploration and per-session tweaking. There is nothing to watch at 3am
  while agents run. Wrong lifetime.
- Env vars alone die with the shell, don't survive a reboot, and can't answer "what is my
  policy" from another terminal. They stay as the `session` layer, never as the store.
- MCP natural-language control is a loop with no damping: the agent that gets blocked
  would be the one that can turn blocking off. So the MCP surface is **read-only**, which
  is where most of its value is anyway — the blocked agent is exactly who needs the reason.
- CLI over a daemon or a db is opaque. You can't diff it, review it, or read it in one
  screen. Somebody who wants to *trust* a policy needs to read the whole thing at once.

TOML, because it takes comments — a policy file people read needs a *why* next to each
number — and `tomllib` is stdlib.

`$EDITOR $(ap policy path)` and `ap policy set …` are both first class and both live-reload.

### 7.1 Schema

```toml
# agent-presence policy. Saved is applied; nothing to restart.
schema = 1
mode   = "normal"            # normal | observer. observer caps this layer at notify.

[effects]                    # blanket rules for this layer
rung0 = "silent"
rung1 = "notify"
rung2 = "context"
rung3 = "deny"
rung4 = "context"            # silent here also skips the rung-4 similarity computation

[[path]]                     # selector inside this layer; longest literal prefix wins
match = "src/generated/**"
rung2 = "silent"
rung3 = "notify"

[floor]                      # org and repo layers only; warns and is ignored elsewhere
rung3 = "notify"

[[floor.path]]
match = "src/payments/**"
rung3 = "deny"
```

Priority is not in this file. It is in `principals.toml` and the relay owns it (§4).

### 7.2 CLI surface

`ap`, installed as a console script (`ap = "agent_presence.cli:main"`).

```
ap policy show [--effective] [--layer L] [--json]
      # --effective prints the resolved 5-rung table plus, per rung, the layer,
      # the rule, any ceiling and any floor. This is requirement 4's "inspect".

ap policy path [--layer user|session|repo|org]
      # prints the path; `$EDITOR $(ap policy path)` is the intended edit flow

ap policy set   rung3=ask [--layer user] [--path 'src/pay/**']
ap policy unset rung3       [--layer user] [--path 'src/pay/**']
      # surgical, line-oriented writes through policy_edit.py: comments and key
      # order survive, write is temp-file-plus-rename

ap policy check [--layer L]
      # parse every layer, print problems, warn on exact-specificity ties and on
      # floors declared where they are ignored. Exit 1 if anything is degraded.

ap policy compile [-o PATH]
      # resolve the client-side layers to the runtime cache the daemon reads (§8)

ap policy explain PATH --rung N [--unattended]
      # one decision, fully traced: layer, rule, ceiling, floor, promotion

ap why [-n N] [--json]
      # the last N real decisions from the daemon's journal, each with rung,
      # effect, holder, and the resolution trace. Requirement 4's "reason".

ap who
      # the snapshot, as the statusline sees it

ap principals list
ap principals add ID --attended TIER --unattended TIER   # prints the token once
ap token mint | ap token hash
ap doctor
      # sockets, daemon, relay, roster, every policy layer, the runtime cache,
      # and whether anything is degraded. Exit 1 when it is.
```

### 7.3 MCP, read-only

Two tools added to `tool_descriptors()`:

- `effective_policy` — the resolved table and its sources, for this room and path.
- `why_was_i_blocked` — the last decision that concerned this agent, with the full
  `Resolution` trace and the holder's brief.

Neither writes. `claim_work`, `release` and `respond` are unchanged.

---

## 8. Where policy is evaluated — the 5 ms budget

Requirement 6. The hot path is `hook -> decision socket -> decide_response -> hook`, with
a 5 ms per-connection budget (`kConnBudgetMs`) served off the event loop by
`DecisionServer`. Nothing in this design adds work to it beyond an array index and one
`max`.

**Nothing parses TOML in the hot path, and the daemon never parses TOML at all.**

```
policy.toml (repo, user, session)
        │  ap policy compile  /  SessionStart hook  /  MCP server startup
        ▼
$XDG_RUNTIME_DIR/agent-presence.policy.json     one line, atomic temp+rename
        │  daemon stats it on the 100 ms tick, parses only on mtime/size change
        ▼
PolicyCache.local_   ── 5 enum values
                                                 max()
PolicyCache.floor_   ── 5 enum values  ◄── relay `policy` frame (org floors)
        │
        ▼
decide_response()  ->  policy.effect_for(rung)   one shared_lock, one array index
        │
        ▼
hook  ->  effect = max(daemon_effect, HOOK_FLOOR[rung])   one array index
```

The compiled cache is written by:

- `ap policy compile`, run by `install.sh` and available by hand;
- the `SessionStart` hook, so a fresh session always has a current table;
- `agent_presence.mcp_server.main`, at startup, for the same reason.

If the file is missing or unparseable the daemon uses `kBuiltin` and marks itself
degraded (§9). It never blocks, never forks, never reads TOML, and never touches the disk
inside a decision.

The relay resolves org floors once at startup (and on mtime change on its own 1 s tick)
and pushes `{"type":"policy","floor":[...],"source":"…","digest":"…"}` on join and on
change. A daemon with no relay keeps `kBuiltin` floors.

Relay-side effect stamping is advisory: the relay stamps `effect` and `effect_source` on
`claim_result` and `negotiate` for the MCP and web surfaces, computed from builtin plus
org floors, since it does not have the client's local layers. The daemon's table is what
decides blocking. They can differ by the client's own local strictness; that is fine and
`ap doctor` reports the digest mismatch when it is not.

**Latency budget check** is a test, not a claim: `cpp/tests/test_latency.cpp` gains a case
that runs the existing p99 harness with a loaded `PolicyCache` and a `PolicyCache` under
concurrent `load_file` churn, asserting the same p99 bound the file already asserts.

---

## 9. Fail open and fail safe

They are different and both matter (requirement 3).

- **Fail open**: our machinery breaking must never block an agent or wedge a session.
- **Fail safe**: nothing may silently drop protection below the documented floor. A
  degradation is always announced.

| situation | table used | degraded? | how it is said |
|---|---|---|---|
| no policy file anywhere | `BUILTIN` | no | this is the documented default, `ap policy show` names `<builtin>` |
| policy file present, unparseable | last good, else `BUILTIN` | yes | `ap doctor` exit 1; `problems` in `ap policy show`; snapshot flag; extra sentence in the rung-3 brief naming the file and line |
| one key bad, rest fine | that key falls to its default, rest applied | yes | one line per bad key in `problems` |
| runtime cache missing or stale | `kBuiltin` | yes | snapshot flag, `ap doctor` names the file |
| relay unreachable | last floor table, then `kBuiltin` floors after one TTL | no | `ap doctor` reports the relay state; leases already degrade this way |
| roster missing | everyone `normal` | no | INFO once at relay startup |
| roster unparseable | everyone `normal` | yes | ERROR at relay startup, `ap doctor` reports it |

Two hard rules, both testable:

1. **A degraded policy never resolves below `BUILTIN_FLOOR`.** Falling back is always to
   the builtin table, never to `silent`, never to "off". There is no code path from a
   parse error to a quieter product.
2. **Degradation is loud.** `write_snapshot` gains a top-level `"policy_degraded":true`
   and `"policy_problem":"<one line>"`. `scripts/statusline-presence.sh` appends `!` to
   its segment when it sees the flag, and prints `· policy degraded` when there are no
   peers to report. `ap doctor` exits non-zero. The rung-3 brief gains one sentence.

`parse` never raises. Every bad field falls back to its default and appends exactly one
line to `problems`. This is the same discipline `redact.py` and `serve.py` already use.

---

## 10. Files

### New — Python

| Path | What |
|---|---|
| `python/src/agent_presence/policy.py` | Effects, layers, rules, resolution, compile |
| `python/src/agent_presence/policy_edit.py` | Line-oriented TOML writer, preserves comments |
| `python/src/agent_presence/priority.py` | Tiers, names, parsing |
| `python/src/agent_presence/principals.py` | Roster, grants, token hashing |
| `python/src/agent_presence/journal.py` | Decision journal reader (the daemon writes it) |
| `python/src/agent_presence/cli.py` | The `ap` binary |

### New — C++

| Path | What |
|---|---|
| `cpp/daemon/policy_cache.hpp` / `.cpp` | `Effect`, `PolicyTable`, `PolicyCache` |
| `cpp/daemon/journal.hpp` / `.cpp` | Bounded ring buffer + tick-time flush |

### Modified

`ladder.py`, `wait_die.py`, `leases.py`, `types.py`, `negotiation.py`, `relay.py`,
`serve.py`, `mcp_server.py`, `sim/simulation.py`, `pyproject.toml`;
`cpp/daemon/{decide,relay_client,snapshot,main}.{hpp,cpp}`, `cpp/hook/{hook,protocol}.hpp`,
`cpp/hook/hook.cpp`; `scripts/statusline-presence.sh`; `install.sh`.

---

## 11. Signatures

### `policy.py`

```python
SCHEMA_VERSION = 1
RECHECK_S = 1.0
RUNGS = range(5)

Effect = Literal["silent", "notify", "context", "ask", "deny"]
EFFECTS: tuple[Effect, ...] = ("silent", "notify", "context", "ask", "deny")
RANK: Mapping[Effect, int]                 # index into EFFECTS
LayerName = Literal["builtin", "org", "repo", "user", "session"]

@dataclass(frozen=True)
class EffectTable:
    rungs: tuple[Effect, Effect, Effect, Effect, Effect]
    def __getitem__(self, rung: int) -> Effect: ...
    def raised_to(self, floor: "EffectTable") -> "EffectTable": ...   # elementwise max
    def capped_at(self, ceiling: Effect) -> "EffectTable": ...        # elementwise min

BUILTIN: EffectTable
BUILTIN_FLOOR: EffectTable

@dataclass(frozen=True)
class Rule:
    match: str | None                      # None = blanket
    effects: Mapping[int, Effect]
    is_floor: bool
    order: int                             # position in file, for tie warnings
    def matches(self, path: str) -> bool: ...
    def specificity(self) -> int: ...      # literal prefix length; -1 for blanket

@dataclass(frozen=True)
class Layer:
    name: LayerName
    source: str                            # path, or "<builtin>"
    mode: Literal["normal", "observer"]
    rules: tuple[Rule, ...]
    problems: tuple[str, ...]
    def rule_for(self, rung: int, path: str, *, floors: bool) -> Rule | None: ...

@dataclass(frozen=True)
class Resolution:
    rung: int
    path: str
    effect: Effect
    base: Effect                           # before ceiling and floor
    winning_layer: LayerName
    winning_rule: str                      # "blanket" or the glob
    ceiling: Effect | None
    floor: Effect
    floor_layer: LayerName | None
    unattended_promoted: bool
    problems: tuple[str, ...]
    def reason(self) -> str: ...           # one human sentence, what `ap why` prints

@dataclass(frozen=True)
class Policy:
    layers: tuple[Layer, ...]              # ordered builtin -> session
    digest: str                            # sha256 of the compiled table + sources
    loaded_at: float
    degraded: bool
    problems: tuple[str, ...]
    def resolve(self, rung: int, path: str, *, unattended: bool) -> Resolution: ...
    def table_for(self, path: str, *, unattended: bool) -> EffectTable: ...
    def floor_table(self, path: str) -> EffectTable: ...

def parse_layer(text: str, *, name: LayerName, source: str) -> Layer:
    """Never raises. Every bad field falls back and appends one line to problems."""

def load_layer(path: Path | None, *, name: LayerName) -> Layer | None: ...

def discover(repo_root: str | None = None, *,
             env: Mapping[str, str] | None = None,
             include: Collection[LayerName] = ("builtin", "repo", "user", "session"),
             ) -> Policy:
    """Client-side layers by default. The relay passes include=('builtin','org')."""

def compile_runtime(policy: Policy, *, path: str = "", unattended: bool = False) -> dict:
    """The blob the daemon reads: schema, table, floor, digest, degraded, problem."""

def write_runtime_cache(dest: Path, blob: dict) -> None:
    """Atomic: temp file in the same dir, fsync, rename. Same discipline as
    write_snapshot in snapshot.cpp."""

def runtime_cache_path(env: Mapping[str, str] | None = None) -> Path: ...

class PolicyFile:
    """Live reload. stat() gated by RECHECK_S, parse only on mtime/size change.
    A file that stops parsing keeps the last good Policy and sets degraded."""
    def __init__(self, paths: Sequence[Path], clock: Clock) -> None: ...
    def current(self) -> Policy: ...
```

### `priority.py`

```python
PRIORITY_NAMES: Mapping[str, int] = {"background": 0, "normal": 1,
                                     "elevated": 2, "critical": 3}
PRIORITY_MIN, PRIORITY_NORMAL, PRIORITY_MAX = 0, 1, 3

def name_of(priority: int) -> str: ...
def parse_priority(value: str | int) -> int: ...        # raises ValueError
```

### `principals.py`

```python
@dataclass(frozen=True)
class Principal:
    id: str
    display: str
    attended: int
    unattended: int
    token_sha256: str

@dataclass(frozen=True)
class Grant:
    principal: str | None                  # None when unauthenticated
    attended: int
    unattended: int
    reason: str                            # roster|no-roster|no-token|bad-token|unknown
    def priority(self, *, unattended: bool) -> int: ...

class Roster:
    @classmethod
    def inert(cls) -> "Roster": ...                        # everyone at normal
    @classmethod
    def load(cls, path: str | os.PathLike) -> "Roster": ...
    @classmethod
    def discover(cls, repo_root: str | None = None) -> "Roster": ...
    def authenticate(self, principal: str | None, token: str | None) -> Grant: ...
    def principals(self) -> list[Principal]: ...

def mint_token() -> str: ...               # secrets.token_urlsafe(32)
def hash_token(token: str) -> str: ...     # sha256 hex
```

`authenticate` compares with `hmac.compare_digest`.

### `wait_die.py`

```python
OrderKey = tuple[int, float, str]

def order_key(priority: int, acquired_at: float, agent: str) -> OrderKey:
    """The single total order over agents. Smaller is more entitled.

    Priority is negated so one `<` means both "higher tier" and "older".
    """
    return (-priority, acquired_at, agent)

def resolve(requester_agent: str, requester_acquired_at: float, holder: Claim,
            requester_priority: int = PRIORITY_NORMAL) -> Decision:
    """Wait-die over order_key. Default priority makes this identical to today."""
```

### `types.py`

`Claim` gains `priority: int = PRIORITY_NORMAL`. Nothing else changes.

### `leases.py`

```python
class LeaseRegistry:
    def priority_of(self, agent: str, default: int = PRIORITY_NORMAL) -> int:
        """The tier stamped on this agent's live claims, or `default` if it holds
        none. Mirrors age_of: every live claim of an agent carries one tier, so
        the requester side and the holder side compare the same quantity."""

    def key_of(self, agent: str, default: int = PRIORITY_NORMAL) -> OrderKey: ...

    def acquire(self, room, human, agent, scope, intent,
                requester_acquired_at: float | None = None,
                priority: int = PRIORITY_NORMAL) -> AcquireResult: ...
```

### `relay.py`

`Conn` gains `grant: Grant` and `unattended: bool`, both latched at join alongside
identity by the same mechanism, refused on change with the same warning.

```python
class Relay:
    def __init__(self, clock: Clock, *,
                 policy: PolicyFile | None = None,
                 roster: Roster | None = None) -> None: ...
```

`join` authenticates via `roster.authenticate(msg.principal, msg.token)`, latches the
grant, and sends the `policy` frame after the lease snapshot. `_on_claim` and `_on_event`
pass `conn.grant.priority(unattended=conn.unattended)` into `acquire` and stamp `effect`
and `effect_source` on the reply.

### `policy_cache.hpp`

```cpp
namespace ap {

enum class Effect : int { Silent = 0, Notify = 1, Context = 2, Ask = 3, Deny = 4 };
const char* effect_name(Effect e);
std::optional<Effect> parse_effect(std::string_view s);

struct PolicyTable { std::array<Effect, 5> rung; };

inline constexpr PolicyTable kBuiltin{
    {Effect::Silent, Effect::Notify, Effect::Context, Effect::Deny, Effect::Silent}};
inline constexpr PolicyTable kBuiltinFloor{
    {Effect::Silent, Effect::Silent, Effect::Silent, Effect::Notify, Effect::Silent}};

/// The decision-relevant slice of policy, and nothing else.
///
/// No TOML, no globs, no layers. Those are resolved by `ap policy compile` into a
/// one-line JSON blob; this reads that blob and the org floor the relay pushes,
/// and answers one question per edit with an array index under a shared lock.
class PolicyCache {
public:
    /// Reload from the compiled cache if it changed. Returns true when the table
    /// moved. Unusable content keeps the previous table and sets degraded().
    bool refresh(const std::string& path, long long now_ms);

    void set_floor(const PolicyTable& floor, std::string source);

    /// max(local, floor). The only call on the hot path.
    Effect effect_for(int rung) const;

    bool degraded() const;
    std::string problem() const;   // one line, empty when healthy
    std::string source() const;

private:
    mutable std::shared_mutex mu_;
    PolicyTable local_ = kBuiltin;
    PolicyTable floor_ = kBuiltinFloor;
    // ... mtime/size gate, source, problem
};

}  // namespace ap
```

### `decide.hpp`

```cpp
std::string decide_response(const std::string& request, const LeaseCache& leases,
                            const PolicyCache& policy, DecisionJournal& journal,
                            long long now_ms);
```

The rung is still computed from the lease cache alone and is still the truth. The response
gains `"effect"`:

```
{"rung":3,"effect":"deny","holder":"…","human":"…","intent":"…"}
```

`"decision"` stays on the wire, set to `"ask"` when the effect is `ask`, so a hook built
before this change keeps working. New hooks read `effect` and ignore `decision`.

### `hook.hpp`

`Decision` gains `std::string effect;`. `hook_output` resolves
`Effect e = max(parse_effect(d.effect).value_or(from_legacy(d.decision)), kHookFloor[d.rung])`
and switches:

- `silent`, `notify` — print nothing.
- `context` — `additionalContext`.
- `ask` — `permissionDecision: "ask"`.
- `deny` — `permissionDecision: "deny"`.

The old rule "a daemon may soften a block but never create one" is replaced by the floor:
the daemon may move the effect in either direction, and `kHookFloor` is what it cannot
move below. That preserves the property that actually mattered — anything on the box can
write to that socket, and nothing it writes can make a real rung 3 disappear — while
letting policy legitimately raise rungs 0-2 for people who ask for it.

### `journal.hpp`

```cpp
struct DecisionRecord {
    long long at_ms; int rung; Effect effect;
    std::string path, agent, holder, human, intent, reason;
};

/// Bounded ring. `record` is called on a decision thread and does one move under
/// a mutex; `drain` runs on the event loop's 1 s tick and writes the lines out.
/// Nothing touches the filesystem inside a decision.
class DecisionJournal {
public:
    explicit DecisionJournal(std::size_t capacity);
    void record(DecisionRecord r);
    void drain(std::vector<std::string>& lines);   // JSON lines, oldest first
    std::size_t dropped() const;
};

/// Append-and-truncate to `path`, capped at kJournalMaxLines. Called from the tick.
void flush_journal(const std::string& path, const std::vector<std::string>& lines);
```

Path: `$XDG_RUNTIME_DIR/agent-presence.decisions.jsonl`, capped at 2000 lines. `ap why`
reads it. Redaction is the existing `redact_line` allowlist — a journal entry can carry no
field a relay frame could not.

---

## 12. Wire changes

Join frame (client → relay) gains, all optional:

```json
{"type":"join","room":"…","agent":"…","human":"…",
 "principal":"sara","token":"…","unattended":true,"policy_digest":"…"}
```

Relay → client, new frame, sent after the lease snapshot and on org-policy change:

```json
{"type":"policy","floor":["silent","silent","silent","notify","silent"],
 "source":"org:/etc/agent-presence/policy.toml","digest":"…"}
```

`claim_result` and `negotiate` gain `"effect"` and `"effect_source"`. `claim_result` on a
refusal gains `"priority"` and `"holder_priority"` as tier names, so a blocked agent can
be told *why* it lost rather than just that it did.

Snapshot gains `"policy_degraded"` and `"policy_problem"` at the top level.

---

## 13. Test plan

Mapped to the six requirements.

### Python — `python/tests/`

**`test_policy.py`** — parse and resolve
- Empty config resolves to `BUILTIN` on every rung. (req 3)
- Every documented bad input — unknown effect, unknown rung key, wrong type, wrong schema
  version, invalid glob, non-table `[[path]]` — falls back to its default, appends exactly
  one problem line, and never raises. Parameterised over the whole list. (req 3)
- Layer precedence: session > user > repo > org > builtin, one case per adjacent pair.
- Within a layer: path beats blanket; longest literal prefix wins; equal specificity takes
  the later rule and records a tie warning.
- `mode = "observer"` caps at `notify`; a floor still beats it. (the §3 step-3-over-step-2 rule)
- Floors in `user`/`session` parse, warn, and are ignored.
- `ask` + unattended → `deny`; `deny` + unattended stays `deny`; `context` unaffected.
- Property (hypothesis): for any generated stack of layers and any rung/path, the resolved
  effect is `>= BUILTIN_FLOOR[rung]`. This is the fail-safe invariant. (req 3)
- Property: rungs 0-2 never resolve to `ask` or `deny` under the shipped defaults, for any
  path, attended or not. (req 5)
- `Resolution.reason()` names the winning layer, the rule and the file for every branch.
  (req 4)

**`test_policy_edit.py`**
- `set` then `unset` round-trips to the original bytes.
- Comments, blank lines and key order survive a `set` on a neighbouring key.
- Writing a file that does not exist creates it with the header comment and 0644.
- A concurrent reader never sees a partial file (temp+rename asserted, not raced).

**`test_priority.py` / `test_principals.py`**
- Tier names parse; unknown tier raises; `normal` is the default everywhere.
- Roster round-trip: mint, hash, authenticate.
- Every row of the §4.4 failure table, asserted on `Grant.reason` and the resulting tier.
- Wrong token gets `default_tier`, not a refusal; a WARNING is logged with principal and
  room. (req 1, fail-open)
- **Band ceiling**: for every principal and both flag values, the granted tier is within
  `[attended, unattended]`. Hypothesis over rosters. (req 1)
- **Client cannot raise itself**: a join frame naming a principal it has no token for, and
  a join frame with `unattended` set for a principal whose band is flat, both land at or
  below the roster ceiling. (req 1)

**`test_priority_order.py`** — the deadlock properties of §5.4, items 1-4. (req 2)

**`test_wait_die_cycle.py`** — extended: priority in `_wait_for_edges`, the
`(priority, acquired_at) == key_of(agent)` stamp assertion in the random-schedule loop,
mixed-tier populations. (req 2)

**`test_invariants.py`** — the existing `Deadlock` check over a mixed-tier simulation, still
finishing inside the TTL. (req 2)

**`test_relay_policy.py`**
- Join latches the grant; a second join with a different principal is refused and the
  latched grant survives.
- `policy` frame is sent after the lease snapshot on join, and again on org-policy change.
- `claim_result` carries `effect` and both tier names.
- A relay with no roster and no policy files behaves byte-for-byte as today. (the golden)

**`test_cli.py`**
- `ap policy show --effective --json` matches `Policy.table_for` for a fixture stack.
- `ap policy explain` prints the winning layer, rule, ceiling and floor. (req 4)
- `ap policy check` exits 1 on a degraded layer, 0 on a clean one, and warns on ties.
- `ap policy set` then `ap policy show` reflects the change with no restart. (live reload)
- `ap why` renders journal lines, and renders nothing without crashing when the journal is
  absent.
- `ap doctor` exits 1 when the runtime cache is missing.

**`test_golden_noop.py`** — the one that matters most
- With no `policy.toml` and no `principals.toml` anywhere on the search path, every
  relay-visible output — `ack`, `negotiate`, `claim_result`, `lease`, `presence` — is
  identical to `fix/lease-protection`, field for field, with `effect` and `priority` the
  only additions and both at their default values. (req 3, req 5)

### C++ — `cpp/tests/`

**`test_policy_cache.cpp`**
- `effect_for` is `max(local, floor)` across the full 5×5 grid.
- A missing cache file leaves `kBuiltin` and does not set degraded.
- A truncated, empty, or non-JSON cache file keeps the previous table, sets degraded, and
  never yields an effect below `kBuiltinFloor`. (req 3)
- A cache file naming an unknown effect string keeps that rung at its previous value and
  records a problem.
- `refresh` only parses on mtime/size change (assert parse count).
- Concurrent `refresh` and `effect_for` under TSan.

**`test_decide.cpp`** — extended
- Rung is unchanged by policy: a `silent` rung 3 still answers `{"rung":3,...}`. (§0)
- `effect` appears on every response; `decision` is `"ask"` exactly when the effect is
  `ask`.

**`test_hook.cpp`** — extended
- Each effect maps to the right stdout shape; unknown effect strings fall back to the
  legacy `decision` field and then to the floor.
- `kHookFloor` cannot be undercut: a daemon answering `{"rung":3,"effect":"silent"}`
  still produces a `notify`-level result, i.e. no allow-in-silence. (req 3)
- A daemon answering `{"rung":1,"effect":"deny"}` does block — policy may be stricter —
  while the shipped defaults never produce that. (req 5)

**`test_journal.cpp`**
- Ring wraps and counts drops instead of growing.
- `drain` empties, preserves order, and is safe against concurrent `record`.
- `flush_journal` truncates at the cap and leaves valid JSON lines.

**`test_latency.cpp`** — extended
- p99 of `run_hook` against a daemon with a loaded `PolicyCache` stays inside the existing
  bound. (req 6)
- Same, with a thread calling `refresh` in a loop, so the shared lock is contended. (req 6)

### End to end

**`python/tests/test_e2e.py`** — extended
- Two agents, roster giving one `elevated` unattended: the elevated agent is told `wait`
  and the other `abort`, and the elevated agent wins the region within one TTL without
  anything being revoked from a live holder. (req 1, no-preemption)
- `ap policy set rung3=ask`, then the next hook decision comes back `ask` with no restart
  of anything. (req 4)
- Corrupting `policy.toml` mid-run leaves the previous table in force, flips the snapshot
  flag, and changes the statusline segment. (req 3)

---

## 14. Order of work

1. `priority.py`, `wait_die.order_key`, `Claim.priority`, `LeaseRegistry.priority_of` —
   default `normal` throughout, so this lands as a pure no-op with the §5.4 property tests
   green.
2. `principals.py` and the roster path through `Relay.join`. Still a no-op with no roster.
3. `policy.py` and `compile_runtime`. Still a no-op with no files.
4. `policy_cache.hpp/.cpp`, `decide.cpp`, `hook.cpp`. The golden no-op test locks this.
5. `journal.hpp/.cpp` and the snapshot/statusline degraded flag.
6. `cli.py`, `policy_edit.py`, the two read-only MCP tools, `install.sh`.

Each step ships with its tests. Step 1 through 4 must each keep `test_golden_noop.py`
green on their own.
