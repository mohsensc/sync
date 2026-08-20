# Threat model: the relay off loopback

**Date:** 2026-08-11, rung-4 section corrected 2026-08-17.
**Status:** current as of TLS in #22, plus the correction below. Supersedes
§4.5 of `policy-design.md`, which described the pre-#11 relay (no join
authentication of any kind), and this file's own pre-#22 version, which had
no transport encryption at all.

**Superseded — read this first:** the relay this file describes was Python
(`relay.py`, `serve.py`). It's been rewritten in Go and the Python relay is
deleted, along with the test files this doc cites. See `docs/go-daemon.md`
for the current architecture. The properties below still hold — they were
ported deliberately, not dropped — but the file names and test names are
gone; see the inline `now:` notes on the specific citations.

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
  `test_connection_identity.py` — now: `latchGrant`/`bindAgent` in
  `go/internal/relaysrv/relay.go`). A connection cannot act as a principal it
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
  (`relay.py`, `priority_of`'s own docstring is explicit about this — now:
  `priorityOf` in `go/internal/relaysrv/relay.go`).
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
  second one is currently authenticated. **This is still true after #22.**
  TLS (below) fixes who can *read* and *tamper with* the traffic; it says
  nothing about who is allowed to send an anonymous `join` in the first
  place. Knowing the room id — one sha256 of a git remote, cheap to
  compute or guess — still gets an anonymous connection into the room at
  `default_tier`, over an encrypted channel exactly as it did over a
  plaintext one. Keep this relay on a trusted network — a VPN or a mesh
  like Tailscale between the machines that are actually supposed to be in
  the room — rather than a public interface. TLS makes that network safer
  to use; it doesn't make a public interface safe.

## Rate limits and per-connection caps

Outbound was already bounded before #11: a per-connection queue with a hard
cap, and a peer whose socket stops draining gets shed rather than allowed to
grow the relay's memory without limit (`serve.py`, `WsConn`,
`test_backpressure.py` — now: `WsConn` and `backpressure_test.go` in
`go/internal/relaysrv/server.go`). #11 adds the inbound half: a token bucket
per connection (`WsConn.admit_inbound`) that drops frames over budget without
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

## What #22 changed

The relay optionally terminates TLS (`--tls-cert`/`--tls-key` or
`AGENT_PRESENCE_TLS_CERT`/`AGENT_PRESENCE_TLS_KEY`; `serve.py`,
`build_tls_context`). The Go daemon dials `wss://` and verifies the relay's
certificate by default against the system root pool — the same trust store
any other TLS client on that machine uses — with two ways to point it at a
cert nothing else signed: `AGENT_PRESENCE_RELAY_CA` trusts one specific PEM
on top of the system pool (the documented dev path,
`docs/tls-dev-cert.md`), and `AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY`
turns verification off entirely, logging a loud, impossible-to-miss warning
every time it does. Neither the C++ hook nor the unix-socket protocol to it
changed; this is entirely the daemon-to-relay hop.

`ws://` on loopback is still the zero-config default — nobody's local setup
breaks, and TLS is additive, not required, exactly as #22 asked for.

This closes the two items #11 filed against transport encryption:

- **Encryption in transit.** Paths, symbols, intents and bearer tokens no
  longer cross the wire as plaintext JSON once TLS is configured. Off
  loopback, run it — see `docs/tls-dev-cert.md`.
- **Server authentication.** A daemon verifying the relay's certificate (the
  default, once `AGENT_PRESENCE_RELAY` is `wss://`) has a real answer to "is
  this actually the relay I mean to join": something on-path answering in
  the relay's place fails the TLS handshake before any frame crosses,
  unless verification was explicitly turned off with the loud flag above.
- **Token replay, mostly.** A token can no longer be captured off the wire
  by anyone merely observing the network — TLS closes that specific route.
  It does not change what happens if a token leaks some other way (a
  committed secret, a compromised machine): possession of a valid token
  still authenticates as that principal until it's rotated, same as before
  #22. Nothing about this issue changes credential rotation, which isn't
  built yet.

## What's still open after #22

- **Room membership itself is still unauthenticated** — see the section
  above. This was scoped out of both #11 and #22 on purpose: it's a design
  decision about what a room *is*, not a transport property, and TLS
  doesn't touch it either way.
- **A compromised or malicious relay** sees everything and can be told
  anything by any joined client, same as always. TLS protects the network
  between daemon and relay; it says nothing about the relay itself, which
  remains a trust boundary of its own — unchanged from before #22.
- **Certificate provisioning and rotation are entirely manual.** There's no
  ACME integration, no cert expiry check, nothing that renews a cert before
  it lapses. `docs/tls-dev-cert.md` covers a 30-day dev cert; a longer-lived
  deployment needs its own operational answer to that, outside this repo's
  scope so far.
- **`AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY` exists.** It's meant to be
  the loud, deliberately inconvenient path, not a normal way to run this —
  see the warning it logs. A fleet that sets it as a default has quietly
  put itself back at pre-#22 exposure to an on-path attacker, with the one
  difference that the traffic is still opaque to a passive observer who
  isn't on-path.

## Rung 4's embedding backend: an offline tool, not a relay-adjacent surface

Everything above is scoped to the relay, on purpose (see the top of this
file). This section used to describe `agent_presence.embedding_similarity` —
rung 4's opt-in sentence-embedding backend, `AGENT_PRESENCE_SIMILARITY=embedding`
— as "a Python process on the same machine as the relay making an outbound
HTTPS call." That was true when the relay itself was that Python process.
It no longer is: the relay is `gorelay` now (#40), rung 4's actual scorer on
the relay's request path is `relaysrv/similarity.go` — a lexical port with no
embedding backend and no outbound call of any kind — and `gorelay` never
reads `AGENT_PRESENCE_SIMILARITY` and has no subprocess capability at all (a
static Go binary; it doesn't shell out to anything, Python included). There
is no live path left that reaches this code.

What's left of `embedding_similarity.py` is reachable exactly one way:
running `python/tools/tune_rung4.py --backend embedding` by hand, an offline
corpus-scoring tool a developer runs to compare scorer backends while tuning
rung 4's threshold (#15). It never sees a real room, a real agent, or a real
declared intent — only the fixed tuning corpus in that file. Kept here
because the network behavior itself (a one-time model-weight download,
everything after that local) is still accurate and still worth a reader
knowing about if they run that tool, not because it's a surface the relay or
any live process exposes.

- **What it sends off-machine, and when:** the model weights
  (`sentence-transformers/all-MiniLM-L6-v2`, ~90MB) download from Hugging
  Face on first use and are cached locally after that. This is a fetch —
  nothing about a room, an agent, a path, or a declared intent is sent. No
  further network call happens on the query path: every `score()` call
  after the first is local ONNX inference against the cached model, and the
  cache directory itself never leaves the machine.
- **What never leaves the machine:** everything `tune_rung4.py` scores —
  its own fixed tuning corpus, not a real declared intent from a real
  session, since nothing on the relay's request path reaches this code any
  more (see above). Scoring is local inference, not an API call; this was a
  deliberate design choice, not the only option (see
  `embedding_similarity.py`'s docstring for the sentence-embedding backends
  that were evaluated, all local).
- **Not gated by an env var:** `tune_rung4.py --backend embedding` builds
  `EmbeddingSimilarity()` directly from the CLI flag — `AGENT_PRESENCE_RUNG4`
  and `AGENT_PRESENCE_SIMILARITY` don't come into it. The default install
  doesn't have `fastembed` on disk either way — it's an optional extra
  (`pip install -e '.[dev,embedding]'`) `tune_rung4.py` fails loudly without.
- **What would change this note:** a hosted embedding backend (an API call
  per query instead of local inference) would send declared intent text to
  a third party on every score, which is a materially different posture —
  opt-in, loud, and documented here specifically, not folded into this
  entry. None exists in this repo today; if one is added, it needs its own
  version of this section, not an edit to this one.
