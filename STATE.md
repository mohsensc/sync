# STATE — feat/git-aware-characters

Round 1. Branch and worktree set up, nothing built yet. This file is the
handoff — read it before touching anything.

## What exists today (the office scene, as of this branch's base)

Everything lives in `web/src/office/`. No bundler on this path — it's plain
JS loaded through an import map in `office.html`, so it can `import` other
files in the same directory but NOT anything from `web/src/*.ts` (palette.ts,
zones.ts, characters.ts etc). Where the .js side needs something the .ts side
already has, it re-hosts a copy by hand (see `live.js`'s `hairFor`, `zones.js`'s
own `PALETTE` — both deliberately duplicate the .ts originals rather than
import them, with a comment saying why).

- `office.html` — owns the THREE.js scene, lighting, room geometry, the
  camera rig (orbit + `focus()`/`goal` for scripted moves), and the render
  loop (`tick()`). Spawns/despawns character roots for both the demo cast
  (`AGENT_CAST`/`BACKGROUND`, built in `setupCast()`) and live agents
  (`spawnLive`/`despawnLive`, driven by `onLivePresence`). Exposes a big
  `window.__*` test surface at the bottom (`__scene`, `__world`, `__clickAt`,
  `__hoverAt`, `__agentState`, etc) — that's the hook for
  `webapp-testing`/devtools work later.
- `live.js` — `connect()` (websocket to the relay, `ws://127.0.0.1:8799`,
  see `RELAY_URL`) and `LiveDirector`, pure logic with no THREE import.
  `onPresence(msg, now)` folds one presence frame into `{ id, human, verb,
  path, zone, rung, spawned, contestWith, shareWith }`. This is where a
  presence frame's `region.path` and (optionally) `region.symbol` first
  become available to the scene — see "presence message shape" below.
- `zones.js` — `zoneFor(verb, path)` maps work to one of 10 named zones
  (desks, vault, phones, cables, crates, fire, ducks, whiteboard, hammock,
  reception). `claimSlot`/`releaseSlots` hand out standing marks.
  `PALETTE` (hand-copied from `palette.ts`) and `zoneAt(x,z)` are both used
  by `interact.js`'s info panel.
- `agent.js` — `Agent` (activity state machine: idle/walking/sitting/typing/
  reading/etc, see `ACTS`) plus `World` (owns agents, brokers `highfive()`
  and `contest()` paired encounters). `createAgent()` is the contract. Every
  agent already carries a `badge` (Sprite over the head, driven by
  `say(text, tone)`) and a `halo` (ring at the feet, driven by `setState`).
  Both are strong, ALREADY-WIRED seams for git-aware content — see below.
- `interact.js` — `attachInteraction()`. Owns hover (`setHover`, tints via
  `tint(mats, hex)` — blends the per-agent diffuse colour, doesn't replace
  it) and click/select (`select()`, fills the `#ip` info panel — name, role,
  doing, destination, zone, position). No git data in the panel yet; `dl` in
  the panel HTML is the natural place to add rows.
- `demo.js` — `runDemo(ctx)`, the six-beat scripted fallback when no relay
  answers within 1.5s (`LIVE_TIMEOUT_MS` in office.html). Not relevant to
  live git data directly, but any zoom/reveal camera work should reuse its
  `focus([x,z], dist, yaw)` pattern (already exported to office.html and
  usable from anywhere with `window.__focus`).
- `clips/argue.js`, `highfive.js`, `clips/handshake.js` — paired-action clip
  modules. Pattern (documented at length in argue.js's header): one canonical
  spacing function (`*Marks()`), both characters walk to fixed marks, clips
  either fire the same clip on both (symmetric contact — highfive, handshake)
  or two different clips phase-matched (asymmetric — argue's point + react).
  Clips get folded into `anim.js`'s shared `CLIPS` table via
  `Object.assign(ANIM.CLIPS, ARGUE_CLIPS)` at import time in `agent.js`. Any
  new git-aware clip (a character crouching to read blame, tapping a desk to
  call up history) should follow this exact pattern — do not start a new
  animation system.
- `anim.js` — 9 procedural clips (`CLIPS` table, line ~934) against the 24-bone
  rig, described in `web/src/office/README.md`. `ONE_SHOT` and `SEATED_CLIPS`
  sets matter if a new clip is added.

## Presence message shape (what git-aware data has to key off)

From `go/internal/relaysrv/types.go`:

```go
type Region struct {
    Path   string
    Symbol *string   // optional
}
```

So a presence frame gives a repo-relative `path` and, sometimes, a `symbol`
name — never a line range. `live.js`'s `isPresence()` only requires
`m.region.path`; `msg.region.symbol` isn't read by the JS side at all yet.
That matters for the blame idea: there's no line number to hand `git blame`
directly. Two honest options for round 2+:
  1. File-level blame/log only (who touched this file, how, when) — always
     available, no heuristics.
  2. Symbol-level: grep the file text for the symbol name to guess a line,
     then blame that line. Best-effort, degrade to file-level when the
     symbol isn't found or isn't provided. Flag this clearly in the UI
     (e.g. "near `Order.total`" vs a confident line-pin) rather than
     pretending it's precise.

## The seam I picked for real git data: a vite dev-server plugin

The office path (`web/src/office/*.js`) runs unbundled straight in the
browser, so it cannot itself shell out to `git`. Three ways to bridge that,
per the brief:

- a tiny dev endpoint alongside vite
- a generated JSON file the scene reads
- the relay carrying it

**Picked: a vite dev-server plugin (`web/vite.config.js`, does not exist yet —
first thing to write).** A `configureServer` hook adds middleware under
`/api/git/*` that shells out to the real `git` binary (repo root is one level
up from `web/`, i.e. `path.resolve(__dirname, '..')`) and returns JSON.
`office.html` is only ever opened through `pnpm dev` (there's no `build`
script in `web/package.json` at all right now — just `dev`, `test`,
`typecheck`), so a dev-only middleware costs nothing and covers every way
this scene actually gets loaded today.

Rejected:
- **Generated JSON.** Wrong shape for this feature specifically — the whole
  point ("an agent editing code nobody has touched in a year should feel
  different from one editing code a teammate touched this morning") is that
  the git data has to reflect the repo as it stands *right now*, including
  whatever the live agents in the room are committing while you watch. A
  snapshot generated once goes stale the moment the first live commit lands.
  It's also a second moving part (a generator script plus a place to write
  its output) for no benefit over a live process that already has the repo
  checked out.
- **Through the relay.** Would mean touching the Python relay's message
  protocol AND the Go daemon/wire types AND probably the C++ hook's payload
  — three languages, all outside this branch's remit ("work only in your
  worktree", parallel team elsewhere touching the daemon/relay). A vite
  plugin is entirely contained inside `web/`, touches nothing another team
  could be mid-edit on, and can be built and thrown away without any
  cross-language coordination.

### Concrete endpoint sketch for round 2

All read-only, all `execFile('git', [...])` (never a shell string — no
injection risk from a path containing spaces or a leading `-`), cwd pinned
to the repo root, and every `path` query param validated against
`git ls-files` before use so nothing can pass `--upload-pack` or similar as
a fake path:

- `GET /api/git/blame?path=<repo-relative>` → `git blame --porcelain <path>`,
  parsed into per-line `{ author, authorMail, authorTime, summary, sha }`
  and rolled up into "N lines by X, M lines by Y" for the whole file (or a
  line range if one is ever available).
- `GET /api/git/log?path=<repo-relative>&n=8` → `git log --follow -n 8
  --format=%H%x1f%an%x1f%ad%x1f%s --date=relative -- <path>`.
- `GET /api/git/stat?path=<repo-relative>` → commit count
  (`git log --follow --format=%H -- <path> | wc -l`), first/last commit
  dates (age + recency — the "nobody touched this in a year" signal), and
  unique author count.
- `GET /api/git/shortlog?dir=<repo-relative-prefix>` → `git shortlog -sne --
  <dir>`, for "who owns this area of the repo" (the crates/desks-zone-level
  flourish idea).
- `GET /api/git/diffstat?path=<repo-relative>` → `git diff --stat HEAD~1..HEAD
  -- <path>` or similar, for "how much did this just change" ambient signal.

Degrade gracefully: an empty or all-`404` repo path (new file, not yet
committed, or outside the repo) should return a small `{ ok:false, reason }`
JSON, not a 500 or an empty box in the UI. `git blame` on an untracked file
exits non-zero — that's the common case to design for first, not an edge
case to bolt on later.

Cheap and fast: every one of these is a single local process spawn against a
repo already on disk, no network. Fine to call generously, once per
hover/click, not on every frame.

## Seams for the visual treatments (round 2+, not built yet)

- **Hover glow + tooltip.** `interact.js`'s `setHover(pick)` already tints
  on hover (`tint(matsOf(pick), HOVER_TINT)`) and shows a tooltip div (`#it`,
  `tip.textContent = pick.label`). Extend `pick.label` for an agent to a
  richer string, or grow the tooltip into a small multi-line panel (agent,
  human, file, zone) — the DOM/CSS pattern for a nicer floating panel
  already exists in `interact.js`'s `CSS` template string and in
  `zones.js`'s `labelTexture()` (canvas-drawn pill, used for the in-scene
  zone labels — could reuse this approach for an in-scene name tag instead
  of a DOM tooltip, which stays legible under camera rotation).
- **Click-to-zoom into the head.** `office.html` already has `focus([x,z],
  dist, yaw)` and the `goal`-based camera easing `tick()` drives every
  frame. Zooming to a character's head specifically needs a look-target
  above floor level, not on it — `focus()` currently only takes an (x,z)
  and hardcodes `goal.target.y = 1.15`; that'll need a head-height variant,
  or `focus` needs a 3rd optional y. `Agent` doesn't expose a head world
  position directly, but `root.position` + a fixed head height (character
  height is `1.68`, head is up near the top) gets you there without a bone
  lookup — good enough for a camera target.
- **"Whose code is this" tint.** `agent.js`'s `Agent` already tints its own
  mesh by `color` at spawn (`makeCharacterRoot`'s `bodyColor` lerp in
  office.html) and `interact.js`'s `tint()` already knows how to blend a
  highlight color onto a `base` per-material color without erasing it. A
  second tint layer — e.g. the desk's own material blending toward "mine"
  vs "teammate's" based on blame ownership fraction — is the same
  `tint()`/`ownMaterials()` machinery `interact.js` already has for desks
  (`d.mats = ownMaterials(d.group)` at setup).
- **File history in-scene.** The whiteboard zone (`Z.ZONES.whiteboard`,
  drawn as a physical panel with drawn-on "boxes and arrows" in office.html's
  `stubProps()`) is the obvious existing prop to repaint with real commit
  history for whichever file is under discussion, canvas-texture style, same
  technique as `labelTexture()`/`badgeTexture()`. Alternative: a panel that
  pops up on click, DOM-based like `interact.js`'s `#ip`.
- **Ambient "stale vs fresh" signal.** `Agent.setState(s)` already drives the
  halo's color/opacity/pulse (`TONE` table: ok/working/blocked/idle/done).
  A `stale`/`fresh` axis orthogonal to the existing ok/working/blocked tone
  could ride the same halo (a second visual channel — e.g. halo *radius* or
  a cold-to-warm hue shift — since `setState`'s tone already owns halo
  color) or a new, separate ambient cue (desk surface glow, a dust
  particle/cobweb prop) keyed off `stat.lastCommitAge` from the seam above.
- **Shortlog-driven area ownership.** Zones already have a `means` and a
  `prop`; a shortlog-driven flourish (a nameplate on a desk, a "planted flag"
  color wash on a zone ring) could hang off `zones.js`'s existing
  `buildZoneMarkers()` return value (`rings`, `sprites` maps, already
  per-zone and already has a `highlight(name)` method to extend).

## What's NOT built yet

Nothing. This round is branch setup, code reading, and this file. No
`vite.config.js`, no endpoint, no new clip, no UI. Round 2 should start by
writing `web/vite.config.js` with the git-data plugin (that's the seam
everything else hangs off), get one endpoint (`blame` is the highest-value)
working end to end with a real `fetch()` from `office.html`'s console
(`window.__ready` gate already exists to know when it's safe to poke at the
scene), and then land ONE visual treatment (hover tooltip showing real blame
is the smallest, most legible win) before fanning out into more variants.

## Nothing tried and rejected yet

First round. Nothing built to reject.

## Browser/port discipline

Not used this round — no browser testing happened, only reading source and
writing this file. Next round: read
`/private/tmp/claude-501/-Users-mohsen-agentai-src-2/92367945-a78b-45ee-8788-865f14f2c2d3/scratchpad/devtools-protocol.md`
in full before any `chrome-devtools` tool call — one shared port (5173), one
tab, lock directory, kill server + release lock when done. That path is
session-scratchpad-local to whoever runs round 2, not part of this repo.

## Nothing filed as a GitHub issue yet

Nothing hit yet that needs one. The symbol-vs-line-range gap in the presence
protocol (see above) is worth a "consider" note for whoever owns the
relay/protocol side, but it's not blocking anything in round 2 (file-level
blame degrades fine without it), so no issue filed for it yet — flagging it
here instead. File one if round 2 actually needs line-level precision and
still doesn't have it.
