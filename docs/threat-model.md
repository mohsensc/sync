# Threat model: the relay off loopback

**Date:** 2026-08-11
**Status:** current as of the join authentication and rate limiting in #11.
Supersedes §4.5 of `policy-design.md`, which described the pre-#11 relay
(no join authentication of any kind).

Scope: the relay's network surface only. Hooks talk to `presenced` over a
unix socket on the same machine; that boundary is a filesystem permission,
not a network one, and is out of scope here.

## What changed in #11, and what didn't

Before this: the relay compared a bearer token per message, in the clear,
against a roster loaded server-side — but nothing bound that comparison to
a connection, so any message could carry any principal's name and the check
ran again from scratch. Two problems followed. First, the check was
per-message rather than per-connection, so a connection had no fixed
identity — see `principals.py`'s own docstring on this from before #11.
Second, and worse: `Grant` gated priority *tier*, never room *membership*.
Both are still true after #11 in one sense and different in another:

- **Fixed now:** authentication happens once, at `join`. The relay latches
  the agent id, the claimed principal and the resulting `Grant` to the
  connection object itself — not to anything the client can rewrite — and
  refuses a second `join` frame that tries to change any of them
  (`Relay._latch_grant`, `Relay._bind_agent`, `python/tests/test_agent_id_binding.py`,
  `test_connection_identity.py`). A connection cannot act as a principal it
  did not authenticate as, and it cannot launder a dead connection's tier
  onto a fresh one under the same agent id either — `_bind_agent` closes
  that specifically (see its docstring for the incident it's named for).
- **Unchanged:** joining a room still requires nothing but the room id.
  Priority now has a real authentication step behind it; membership still
  doesn't.

## What possession of the repo grants

A clone of the repo gives you, with no further credential:

- **The room id.** It's a truncated sha256 of the normalized git remote —
  see `room_key.py` and `docs/design.md`. Anyone who can clone the repo can
  compute it.
- **Room membership**, at whatever `default_tier` the roster declares (or
  `normal` if there's no roster), the moment you can reach the relay's port.
  No token, no principal name, nothing — an anonymous `join` with a room id
  and any agent id you like is accepted. This is deliberate for v1
  (`docs/design.md`: "room membership derived automatically from the git
  remote, no access control beyond possession of the repo") and it is
  exactly the assumption that stops being defensible once the relay is
  reachable from more than one machine.
- If you also have **push access**: the ability to add yourself to
  `.agent-presence/principals.toml` at any tier, including `critical`. The
  control here isn't cryptographic — it's that the roster is committed, so
  adding yourself at `critical` is a diff someone else reviews before it
  merges, same as any other code change.

## What possession of the repo does not grant

- **Anybody's bearer token.** `principals.toml` holds `sha256(token)`, never
  the token itself (`_HEX64` in `principals.py`; `hash_token`). The plaintext
  token is minted once by `ap principals add`, printed to whoever ran it, and
  from then on lives at `$XDG_CONFIG_HOME/agent-presence/token` on that
  person's machine — never in the repo, never in git history. Cloning the
  repo gets you the hash, which is useless for authenticating as anyone.
- **A tier you weren't granted.** The client sends one bit —
  `unattended` — and `Grant.priority()` clamps it to stay inside the band
  the roster already gave that principal. There's no field on the wire that
  raises a tier; `priority_of` never reads anything from the message body
  (`relay.py`, `priority_of`'s own docstring is explicit about this).
- **Someone else's live connection.** Even with a stolen token, joining as
  `sara` from a second connection doesn't touch the first one's leases,
  because the lease table and the fan-out are both keyed off the
  *connection's* latched identity, not off anything replayed on the wire.
  What it does get you: a second connection authenticated as `sara`, which
  is indistinguishable to the relay from `sara` running two agents — the
  ordinary multi-checkout case. A stolen token is a real compromise; it just
  isn't a *worse* one than the token owner already has.

## What a room's membership means once the relay is reachable from off-box

On loopback, "a member of the room" means "a process running as you (or
someone else logged into this machine) that can open a local socket." The
trust boundary is the machine's own user/process boundary, which the relay
adds nothing to and takes nothing from.

Bind a real interface (`--host` / `AGENT_PRESENCE_HOST`, still defaulting to
`127.0.0.1`) and that stops being true. "A member of the room" now means "a
host that can route to this port and can compute or guess the room id."
Concretely, once the relay is reachable from outside one machine:

- Anyone on that network can join any room whose id they can derive from a
  git remote URL — which is one sha256 away from public knowledge for any
  repo whose remote is known — and see every path, symbol, verb and
  (non-opaque) intent string that crosses the room. Presence is not private
  by design; it's meant to be seen by teammates. It is not meant to be seen
  by whoever else is on the network.
- That anonymous joiner gets `default_tier` (`Roster.authenticate`'s
  `no-token` path) and can submit real `event`, `claim`, `heartbeat` and
  `move` frames at that tier. It cannot outrank a rostered principal, and it
  cannot preempt anyone's lease mid-edit — the wait-die ordering and the
  no-preemption invariant apply regardless of who's asking — but it can
  contend for regions, occupy the low end of the priority order, and consume
  a connection's worth of resources.
- It is *not* equivalent to being a teammate with push access to the repo.
  Room membership and roster membership are different gates, and only the
  second one is currently authenticated. This is the residual gap #11 was
  filed against and the reason to keep this relay on a trusted network — a
  VPN or a mesh like Tailscale between the machines that are actually
  supposed to be in the room — rather than a public interface, until the
  transport itself is authenticated (see below).

## Rate limits and per-connection caps

Outbound was already bounded before #11: a per-connection queue with a hard
cap, and a peer whose socket stops draining gets shed rather than allowed to
grow the relay's memory without limit (`serve.py`, `WsConn`,
`test_backpressure.py`). #11 adds the inbound half: a token bucket per
connection (`WsConn.admit_inbound`) that drops frames over budget without
processing them, and disconnects a connection whose budget stays exhausted
for `INBOUND_SATURATED_S` straight rather than a connection that's merely
bursty. It exists to keep one connection's ingest cost from crowding out
everyone else's on the relay's single event loop — the inbound mirror of
what the outbound queue already did for fan-out.

The threshold is set high (2000 frames/s sustained, burst to 4000) on
purpose: real traffic — a coalesced hook batch, an MCP claim, a 30s
heartbeat — runs at a handful of frames a second per connection, nowhere
near this. The number is calibrated against `tests/load`'s own contention
scenarios, which hammer the relay with a claim/refuse loop and deliberately
no backoff to see how it behaves under maximum legitimate contention; that
traffic clears low thousands/s in short bursts on a quiet loopback socket.
So this is a backstop against a peer sending far more than any client, well
behaved or not, produces — not a tight budget tuned to normal use. A peer
that opens many connections rather than flooding one is not covered by this;
per-IP or total-connection caps are a reasonable next step and are not in
this change.

Frame size is capped too — `MAX_FRAME_BYTES` (64 KiB) on the
`websockets.serve` listener — so one oversized frame can't be used to make
the relay allocate and parse something disproportionate to what any real
join, claim or event ever needs.

## What is still open, pending TLS (#22)

Everything below is unchanged by #11 and is exactly the gap #22 exists to
close:

- **No encryption.** Paths, symbols, intents and bearer tokens all cross the
  wire as plaintext JSON. Off loopback, anyone who can observe the traffic —
  on the same network segment, on a shared switch, anywhere between the two
  machines — can read it and can read the bearer token specifically, which
  is exactly the credential that authenticates a principal.
- **No server authentication.** A daemon has no way to confirm the socket
  it's talking to is actually the relay it means to join and not something
  on-path answering in its place. An attacker in that position can read
  everything and inject frames as if they were the relay — including, for
  instance, telling every daemon a region is free when it isn't.
- **Token replay.** Because the token crosses in the clear, capturing one
  join frame is enough to impersonate that principal until it's rotated.
  Nothing about #11 changes this; latching the grant to a connection
  protects against a *live* connection being re-rated, not against a
  captured token being used to open a new one.
- **A compromised or malicious relay** sees everything and can be told
  anything by any joined client. It always could; TLS between daemon and
  relay doesn't change that the relay itself is a trust boundary, only that
  the network in between isn't one it has to share with.

None of this is a regression from #11 — it's the state #11 explicitly did
not touch, scoped out to #22 because the cost of doing it right depends on
whether the daemon stays C++ or moves to Go (`ap-hook`/`presenced`'s own
issue #18). Until #22 lands: bind the relay to a real interface only on a
network you already trust with the same things the traffic exposes, and
treat `127.0.0.1` as the only default that needs no such judgment call.
