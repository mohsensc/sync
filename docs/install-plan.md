# One-line install (plan)

Agent Sync loses on install friction and nothing else. Four commands, two
toolchains, a manual `claude mcp add`, and no download step. This is the plan
to make it `npm i -g agent-sync` + `agent-sync start`.

Nothing about the C++/Go split changes. Four binaries stay four binaries.
Packaging bends to the binaries.

## Distribution: optionalDependencies, not a postinstall download

One wrapper package plus per-platform binary packages selected by npm's
`os`/`cpu` fields, the esbuild/swc pattern. The alternative — a postinstall
script that pulls the right asset off a GitHub release — loses on all three
failure modes that matter here:

| Failure mode | postinstall download | optionalDependencies |
| --- | --- | --- |
| `npm ci --ignore-scripts` | installs nothing, silently. The wrapper is on PATH and every invocation fails. | unaffected — plain dependency resolution, no scripts involved |
| Corporate proxy / registry mirror | hits `github.com/.../releases`, a host separate from the registry npm is already configured and allowed to reach | comes from the same registry, through the same proxy, as everything else |
| Offline / warm cache | not in the lockfile, not in the npm cache, no artifact | in the lockfile, in the cache, resolves offline |

`--ignore-scripts` is the one that decides it. It is the default in a lot of
CI and in every security-conscious shop, and its failure is silent, which is
the worst kind.

The consequence for implementation: the wrapper's `bin` is a JS shim that
`require.resolve`s the platform package and execs the binary **at runtime**.
Not a postinstall that copies or symlinks the binary into place — that puts
the `--ignore-scripts` hole straight back in.

Layout:

```
npm/agent-sync/                 wrapper: JS shim, optionalDependencies
npm/platform/darwin-arm64/          @agent-sync/darwin-arm64
npm/platform/darwin-x64/
npm/platform/linux-x64/
npm/platform/linux-arm64/
npm/platform/win32-x64/
```

## Release artifacts without GitHub Actions

The standing rule killed `ci.yml`. It did not kill releases: commit `1826514`
("delete the ci workflow, promote the local suite") deleted `ci.yml` and in the
same commit *edited* `.github/workflows/release.yml`, which is still on the
tree and still fires on `v*` tags. So the exception already exists and was
made deliberately. I am not adding a workflow and not arguing for a new
exception — I am using the one that's there.

What that workflow does today is run `scripts/build-go-release.sh`, which
cross-compiles the three Go binaries to five platforms from one machine
(no cgo, so no per-target toolchain). It does not build `ap-hook` at all.

`ap-hook` is the real constraint. It is C++20 over POSIX and pthreads —
no OpenSSL, no third-party headers — so it *is* cross-compilable in
principle, but `zig` is not installed on this machine and Apple's clang
cannot target Linux or Windows. So:

- The three Go binaries ship prebuilt for all five platforms. That path is
  real and already automated.
- `ap-hook` ships prebuilt only where something actually built it. Locally
  that's darwin/arm64. The honest fix is extending `release.yml`'s job to
  build the hook per-runner (`macos-14`, `ubuntu-24.04`, `windows-2022`),
  which I will write into the workflow and mark as unverified — I cannot
  push a tag, so nobody has watched it run.
- **Degradation is explicit, not silent.** A platform package with no hook
  still gives you the relay, the daemon and the MCP surface: `claim_work`,
  `respond`, `who_else_is_here` all work. What you lose is arbitration on
  tool calls, because that is what the hook does. `doctor` says exactly
  that, names the platform, and prints the cmake line.

"One command, no toolchain" must not quietly mean "on macOS arm64 only."

## Command surface

`agent-sync` is one binary-shim entrypoint with subcommands. Nobody types
`claude mcp add`, and nobody hand-edits `settings.json`.

```
agent-sync setup            wire hooks + MCP into Claude Code, then start
agent-sync start            background relay, free port, state file, prints addr, exits
agent-sync stop             stop the relay this machine started
agent-sync status           what's running, where
agent-sync invite           print a join blob for a teammate
agent-sync join <blob>      point this machine at someone else's relay
agent-sync doctor           diagnose, with a next step per failure
agent-sync mcp              internal: what Claude Code spawns (see zero-config)
```

`start` copies Roughdraft's shape exactly: it forks the relay into the
background, reuses an already-running relay or takes a free port, writes
state to `~/.agent-sync/server.json`, prints the address, and gives the
terminal back. It does **not** guess a port — `gorelay --port 0` already binds
a free one and logs the bound address; `start` reads that back rather than
inventing a second port-picking convention.

One deliberate difference from Roughdraft: what gets printed is a `ws://`
address, not an http URL. The relay is a websocket endpoint. The Three.js
dashboard in `web/` is a vite dev app, not a served artifact, and `gorelay`
serves no static files — so printing "open this in your browser" would be a
lie. `start` prints the relay address and the `agent-sync invite` line.

No wizard. No questionnaire.

## Team onboarding, both paths first-class

Person one:

```
npm i -g agent-sync
agent-sync setup
```

Person two joins an existing relay. This is the path that currently means
hand-setting `AGENT_SYNC_RELAY` and wrangling a dev cert, and it's where
most of the friction actually lives. The fix is one opaque blob instead of
three environment variables:

```
# person one
agent-sync invite
# -> agent-sync join eyJyZWxheSI6IndzczovL...

# person two
npm i -g agent-sync
agent-sync join eyJyZWxheSI6IndzczovL...
```

The blob carries the relay URL, the bearer token, and — when the relay is
running TLS — the certificate itself. `join` writes
`~/.agent-sync/config.json` at 0600 and drops the PEM next to it.

**Corrected during implementation:** this section originally said the blob
pins a certificate *fingerprint*. There is no fingerprint pinning anywhere in
this codebase — `AGENT_SYNC_RELAY_CA` takes a PEM file and verifies the
full chain against it, and no leaf-hash path exists. So the blob carries the
whole PEM and `join` writes it where `AGENT_SYNC_RELAY_CA` can point.
Same trust property, different mechanism, and it's the one that's actually
implemented. `AGENT_SYNC_RELAY_INSECURE_SKIP_VERIFY` stays a deliberate
escape hatch and is not part of the happy path.

## Zero-config: solo user, no setup at all

If nobody has started a relay, the first agent starts one on localhost.

The mechanism: Claude Code is registered against `agent-sync mcp`, the
JS shim, not the Go binary directly. The shim checks `server.json`, dials the
relay, and if nothing answers it starts one on loopback before exec'ing
`agent-sync-mcp`. A solo user gets value having typed `setup` and nothing
else. A joined machine skips this — `config.json` points at someone else's
relay and the shim never starts a local one.

## Safety rails on the self-registering part

Writing `~/.claude/settings.json` is the highest-consequence thing here. A
naive overwrite destroying somebody's hook config would be a worse outcome
than the friction this PR removes. So: back up first, merge into the existing
`PreToolUse`/`PostToolUse` arrays rather than replacing them, and skip if an
`ap-hook` entry is already there. Same for MCP — check `claude mcp list`
before `claude mcp add`.

## What I can and cannot verify

I cannot run `npm publish` — that's outward-facing and not authorized — so
`npm i -g agent-sync` from the public registry is not something I will
claim to have watched work. What I can verify end to end is `npm pack` into
tarballs, then `npm i -g` from those, with platform packages resolved
locally. The README and the final report say it that way.

Clean-environment testing extends `scripts/test-install.sh`, which already
has the right harness: `nogo_path()` symlinks only named coreutils (so a
distro `go` at `/usr/bin/go` can't sneak back in) and invokes under
`env -i PATH=... HOME=...`. Extending that file keeps the coverage inside
`scripts/ci-local.sh` instead of stranding it in a script nothing runs.

Failure modes to test deliberately, each needing an actionable message: no
Node, wrong architecture, port already taken, relay unreachable,
`--ignore-scripts`.

## What was actually measured

A `node:22-slim` container (no Go, no cmake, no `cc`) on Docker/colima,
`linux/arm64`:

| | |
| --- | --- |
| `npm i -g` from local tarballs | 1s |
| `agent-sync start` to a listening relay | 141ms |
| nothing to a joined second machine | 1s |
| commands, person one | 2 (`npm i -g`, `agent-sync setup`) |
| commands, person two | 2 (`npm i -g`, `agent-sync join <blob>`) |

`--ignore-scripts` installs and runs with no degradation, which is the claim
the optionalDependencies choice rests on. Not verified: `npm publish` and the
registry install path, and `release.yml` — no tag was pushed.

## Multi-agent targets: hook vs. AGENTS.md-only

The dashboard's setup-instructions flow (`api/_lib/tokens.ts`'s
`setupInstructions`) picked up a target picker: Claude Code, Codex, Grok,
Gemini CLI, and Muse. This section is the design note for why the copy those
targets produce isn't uniform.

`agent-sync setup` (`npm/agent-sync/lib/setup.js`) is Claude-Code-specific
code, not a coincidence of what got built first: it shells out to `claude
mcp add` and writes `~/.claude/settings.json`'s `PreToolUse`/`PostToolUse`
arrays with the `ap-hook` binary (the safety rails above — backup, merge,
idempotent — apply to exactly this write). There is no equivalent for
Codex/Grok/Gemini CLI/Muse anywhere in this repo: no hook protocol adapter,
no scripted MCP registration. `ap-hook` itself only speaks Claude Code's
PreToolUse/PostToolUse hook JSON — even a coding agent whose own settings
happen to have a general-purpose hooks block (several do) isn't running the
protocol `ap-hook` implements, so pointing it there wouldn't do anything.

`AGENTS.md` is the one thing all five targets share — it's the convention
several coding-agent CLIs are converging on for repo-local instructions.
Every selected target gets a generated `## Agent Sync` section for it,
phrased conditionally ("if the agent-sync MCP tools are available in this
session, call ..."), because unlike Claude Code, nothing in this codebase
registers those tools for the others — an unconditional instruction to call
tools that were never wired up would be a checkbox that silently does
nothing while looking like it works.

Two precedence traps this has to call out explicitly in the generated copy,
both about a file with equal or higher priority silently shadowing
`AGENTS.md`:
- **Claude Code** reads `CLAUDE.md` as the primary file in a directory and
  only falls back to `AGENTS.md` when no `CLAUDE.md` is present there
  (behavior as of 2026-09) — so for this target the generated text tells
  the connecting agent to write the identical section to both files, not
  `AGENTS.md` alone. No code path in this repo performs that write; the
  agent does, if it follows the instruction — same as the AGENTS.md-only
  write for every other target.
- **Gemini CLI** reads `AGENTS.md`, but a `GEMINI.md` in the same directory
  wins if both exist. There's no dual-write fix here (Google's own
  precedence, not something this repo's setup step controls) — the
  generated copy just says so, so a repo that already has a `GEMINI.md`
  doesn't end up silently unheard.

Net effect: three tiers, not two. Claude Code (hook + MCP + CLAUDE.md +
AGENTS.md), everything else (AGENTS.md only, MCP registration left as a
manual step in that CLI's own config if it supports one), and no hook
surface at all outside Claude Code. The picker's copy for the non-Claude
targets is intentionally near-identical across all four — the honest thing
to say about what Agent Sync does for them today doesn't vary by vendor.
