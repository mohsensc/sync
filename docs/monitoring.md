# Monitoring

`go/internal/metrics` is the whole catalogue — one `*Registry`, read that
file first. This doc is what each number means, what a bad value looks
like, and how any of it gets from a laptop to a dashboard at all.

## Why daemons don't expose an endpoint

`presenced` runs on every developer's laptop, behind NAT, unreachable by a
Prometheus scrape. `gorelay` runs somewhere central and is the one process
an operator actually runs. So the daemons don't run a `/metrics` endpoint
at all — each one pushes a small stats frame up the websocket connection it
already holds to the relay, and the relay aggregates and exposes
`/metrics` on its own for everyone.

That shape isn't just about reachability. Scraping laptops directly would
mean a network path per developer, credentials on every machine, and
telemetry about which files people are editing leaving a laptop by a route
nobody reviewed. The relay already terminates that connection and already
redacts what crosses it (`go/internal/relaysrv/redact.go`); routing metrics
through the connection that exists anyway, instead of opening a new one, is
the honest choice given what this product is careful about elsewhere.

Run the relay with `--metrics-addr=host:port` to serve `/metrics`; it's
unset by default; there is deliberately no default port a metrics endpoint
just appears on, because that's a way to leak a room's shape to whoever is
on the same network as an operator who didn't ask for it.

## Label rules, and why they're not negotiable

Two rules, enforced by `metrics_test.go`'s
`TestNoMetricCarriesUserDataInALabel`, which fails the build on a violation
rather than trusting review to catch it:

- **No user data in a label, ever.** Not a path, not an intent, not a
  human name, not an agent id, not a room id (room ids are already hashes
  and are *still* kept out of labels — a room id plus a timestamp
  identifies a team). A label lands in a time-series database, gets
  replicated, and outlives the thing it described; it's the least careful
  place in a monitoring system to put the payload this whole product exists
  to be careful about. Rung, effect, outcome, shape, tool and reason are
  the entire allowed vocabulary — small enumerations, checked in as
  constants, so a typo is a compile error instead of a second time series
  that looks almost like the first one.
- **Bounded cardinality.** Every label has a small fixed domain. There is
  deliberately no per-daemon or per-agent label: developers come and go,
  and a label that grows with them turns a time-series database into a
  bill and then an outage. Per-daemon detail belongs in the relay's status
  JSON, which is a point-in-time answer nobody stores — not a metric.

Recording only ever goes through a typed method (`r.Decision(rung,
effect)`, `r.Lease(outcome)`, `r.RegionKey(shape)`, `r.MCPCall(tool,
outcome, d)`, `r.FrameDropped(reason)`, `r.Coalesce(outcome)`) so a label
value can only ever come from one of those constants.

## Reading the dashboard

`ops/grafana/agent-presence.json`, five rows, roughly in the order someone
debugging would reach for them.

### Availability

Is the relay up and are daemons actually attached to it.

| metric | bad value looks like |
|---|---|
| `up{job="gorelay"}` | `0` — Prometheus can't reach `--metrics-addr` at all |
| `ap_relay_connections` | a sudden drop with no deploy to explain it |
| `ap_rooms` | flatlines at 0 during working hours |
| `ap_daemons_connected` | drops to 0 and stays there (`DaemonsConnectedDroppedToZero`) |
| `rate(ap_relay_reconnects_total[5m])` | sustained nonzero — something is knocking connections down, not just one blip |

### Latency

The number that can break the product without anyone touching a line of
code: `ap_decide_duration_seconds`, the time `presenced` takes to answer
one hook decision from its local lease cache. `ap-hook`'s budget is 5ms and
it **fails open** past it — never blocks the agent — so a regression here
doesn't look like an error anywhere. It looks like collision detection
quietly stopped working. The panel draws p50/p95/p99 with a threshold line
at 5ms; p99 crossing it for more than two minutes is
`DecideLatencyP99OverBudget`.

`ap_claim_roundtrip_seconds` (time from sending a claim to the relay's
verdict) and `ap_broadcast_fanout_seconds` (time to fan one frame out to a
room) are the two network-facing latencies behind it — worth checking
whenever decide latency moves, since presenced's own cache is downstream of
both.

Percentiles come from `histogram_quantile` over the `_bucket` series, never
an average — an average hides exactly the tail this is watching for. The
bucket boundaries in `metrics.go` (`decideBuckets`) straddle 5ms on purpose,
so both sides of the budget have resolution instead of Prometheus's
defaults, which start at 5ms and would put every healthy decision in the
first bucket.

### The ladder

Whether the product is doing anything, not just staying up.

- **Rung distribution** (`ap_decisions_total` by `rung`) — which collision
  tier decisions are actually landing on. All rung-0 for days is either a
  quiet repo or a scorer that stopped scoring.
- **Decisions by effect** and **deny rate** — a deny rate near zero most of
  the time is normal; a step change either direction after a policy edit is
  worth reading `ap policy show --effective` against.
- **Lease outcomes** (`ap_leases_total` by `outcome`) — `expired` climbing
  relative to `granted`/`handover` means leases are timing out instead of
  being released, which is usually a client that died without saying so.
- **Redundant work** (`ap_redundant_work_total`) — rung-4 hits: two agents
  caught doing the same work in different files. Off unless
  `AGENT_PRESENCE_RUNG4=1`; zero here when rung-4 is on is either good news
  or the scorer placeholder (#15) not scoring anything.
- **Coalesce: dropped vs admitted** (`ap_coalesce_total` by `outcome`) — the
  share of hook events the coalescer is dropping as duplicates. A spike
  tracks bursty tool calls, not a bug by itself; a sustained near-100% is
  the coalescer eating real events.

### Consistency

Every panel in this row is a way the system can quietly disagree with
itself — the class of bug that has already shipped once.

- **Absolute region keys** (`ap_region_keys_total{shape="absolute"}`) —
  **must be zero.** An absolute key is a region named by its filesystem
  path, which can't match a teammate's checkout of the same repo. Anything
  above zero means collision detection has silently stopped working across
  checkouts; `AbsoluteRegionKeysDetected` fires on the first occurrence, not
  after a grace period, because there's no acceptable rate for this one.
- **Room splits** (`ap_room_splits_total`) — two clients derived different
  room ids from the same origin remote. Should track deploys of the room-id
  logic, not steady background noise.
- **Lease-cache divergence** (`ap_lease_cache_divergence`) — leases a
  daemon believes in that the relay doesn't, at reconcile. A brief spike
  during a reconnect storm is normal; sustained is `LeaseCacheDivergenceSustained`.
- **Peer clock skew** (`ap_peer_clock_skew_seconds`) — difference between a
  frame's own timestamp and its arrival time. Lease and presence TTLs are
  wall-clock and nothing disciplines this, so a skew climbing toward the
  90s lease TTL means a laptop's clock, not the product, is about to cause
  a false expiry.

### Saturation

Whether the relay itself is keeping up.

- **Goroutines** and **heap** (`go_goroutines`, `go_memstats_heap_*`) — from
  the Go runtime collector, wired up for free in `metrics.New()`. A
  goroutine count that only ever climbs is a leak, not load.
- **Open file descriptors** (`process_open_fds` vs `process_max_fds`) —
  every websocket connection is a file descriptor; converging on the limit
  precedes new connections failing, not follows it.
- **Send-queue depth** (`ap_send_queue_depth`) — frames queued for the
  slowest consumer the relay is writing to. Climbing without recovering is
  the leading indicator for the next panel.
- **Dropped frames** (`ap_frames_dropped_total` by `reason`) — frames the
  relay accepted and then gave up delivering. `DroppedFramesRising` fires
  on any sustained rate above zero; the `reason` label says why. This is
  outbound delivery failure only — a frame refused inbound, before the
  relay tried to deliver it, is `ap_frames_rejected_inbound_total` below,
  not this counter.
- **Journal writes / trims** (`ap_journal_writes_total`,
  `ap_journal_trims_total`) — the decision journal's own write and trim
  rate. Writes without trims growing the journal unbounded is worth a look
  before disk does the alerting for you.

## In the catalogue, not on the dashboard

Seven metrics `metrics.go` emits don't have a panel — kept off on purpose,
not forgotten:

- **`ap_outbound_dropped_total`** — daemon-side mirror of `ap_frames_dropped_total`:
  an upper bound on frames a laptop's own bounded outbound queue discarded
  because the relay was unreachable longer than the queue could hold.
  Under sustained backpressure it can, in a narrow window, also count a
  frame that was actually written and delivered — see the drop-oldest
  comment in `outbound.go` — so treat it as "at most this many," not an
  exact loss count. Folded in from each daemon's stats frame. Nonzero means
  an outage outlasted the buffer, not that anything is currently broken,
  so it isn't alert-worthy the way a live drop rate is.
- **`ap_frames_rejected_inbound_total`** — inbound frames the
  per-connection token bucket refused before the relay ever attempted
  delivery. A rate-limited sender, not a delivery failure, so it's kept
  out of `ap_frames_dropped_total` and off `DroppedFramesRising` on
  purpose: mixing the two would make that alert fire on a well-behaved
  bucket doing its job. No panel yet because nobody's hit a rate-limited
  agent in the wild; add one alongside the Saturation row's dropped-frames
  panel if that changes.
- **`ap_asks_unarmed_total`** — asks that didn't start the holder's
  handover deadline because the asker was unauthenticated in a room with an
  enforcing roster (#167). Healthy is zero, and it stays zero forever in a
  room with no roster, so a panel would be empty on most deployments and
  flat on the rest. Worth an ad-hoc query rather than a graph: anything but
  zero means a token is missing or wrong, or somebody is in the room who
  shouldn't be — and the first of those looks to the agent like being
  quietly starved behind a busy holder, which is otherwise hard to tell
  apart from the system working.
- **`ap_daemon_connected`** — a per-process gauge presenced sets on its own
  registry ("1 while I have a live relay connection"). It never reaches the
  relay's `/metrics`: there's deliberately no per-daemon label to hang it
  on, so it stays local, feeding a daemon's own status output instead of a
  scraped time series. `ap_daemons_connected` (plural, on the dashboard) is
  the relay's own count and the one worth watching.
- **`ap_policy_reload_seconds`** — time to re-read and recompile policy
  after an edit on disk. Not on the dashboard because it's rare enough
  (a human editing a TOML file) that a graph would mostly be empty; if a
  reload ever gets slow enough to matter it'll show up as a gap in
  `ap policy show --effective` responding, and that's worth a panel then.
- **`ap_mcp_calls_total`** (by `tool`, `outcome`) and **`ap_mcp_duration_seconds`**
  (by `tool`) — the `claim_work`/`respond`/`who_else_is_here` surface's own
  call counts and latency. Left off this dashboard because it's a different
  question ("is the MCP surface healthy") from the five rows above ("is the
  product doing the right thing"); both metrics exist and are queryable
  today for whoever wants that dashboard next.

## Alerts

`ops/prometheus/alerts.yml`. Each one's `description` says what to go do,
not just what fired — see the file itself for the full text per alert:
`AbsoluteRegionKeysDetected`, `DecideLatencyP99OverBudget`, `RelayDown`,
`DaemonsConnectedDroppedToZero`, `DroppedFramesRising`,
`LeaseCacheDivergenceSustained`.

## Running it locally

```
gorelay --metrics-addr=0.0.0.0:9830     # in one terminal
cd ops && docker compose up             # Prometheus on :9831, Grafana on :9832
```

Grafana comes up with the datasource and the Agent Presence dashboard
already provisioned — nothing to click through. Default login is
`admin`/`admin`; Grafana will ask you to change it on first login.

`ops/verify_metrics.py` (wired into `scripts/ci-local.sh ops`) parses
`agent-presence.json` and `alerts.yml`, pulls every metric name out of
every PromQL `expr`, and fails if one isn't something `metrics.go` actually
emits. It's the guard against exactly the failure mode this whole file
exists to prevent: a dashboard that quietly stops meaning anything because
the code behind it moved on without it.
