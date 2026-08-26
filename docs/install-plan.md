# One-line install (plan)

Agent Presence loses on install friction and nothing else. Four commands, two
toolchains, a manual `claude mcp add`, and no download step. This is the plan
to make it `npm i -g agent-presence` + `agent-presence start`.

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
npm/agent-presence/                 wrapper: JS shim, optionalDependencies
npm/platform/darwin-arm64/          @agent-presence/darwin-arm64
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

`agent-presence` is one binary-shim entrypoint with subcommands. Nobody types
`claude mcp add`, and nobody hand-edits `settings.json`.

```
agent-presence setup            wire hooks + MCP into Claude Code, then start
agent-presence start            background relay, free port, state file, prints addr, exits
agent-presence stop             stop the relay this machine started
agent-presence status           what's running, where
agent-presence invite           print a join blob for a teammate
agent-presence join <blob>      point this machine at someone else's relay
agent-presence doctor           diagnose, with a next step per failure
agent-presence mcp              internal: what Claude Code spawns (see zero-config)
```

`start` copies Roughdraft's shape exactly: it forks the relay into the
background, reuses an already-running relay or takes a free port, writes
state to `~/.agent-presence/server.json`, prints the address, and gives the
terminal back. It does **not** guess a port — `gorelay --port 0` already binds
a free one and logs the bound address; `start` reads that back rather than
inventing a second port-picking convention.

One deliberate difference from Roughdraft: what gets printed is a `ws://`
address, not an http URL. The relay is a websocket endpoint. The Three.js
dashboard in `web/` is a vite dev app, not a served artifact, and `gorelay`
serves no static files — so printing "open this in your browser" would be a
lie. `start` prints the relay address and the `agent-presence invite` line.

No wizard. No questionnaire.

## Team onboarding, both paths first-class

Person one:

```
npm i -g agent-presence
agent-presence setup
```

Person two joins an existing relay. This is the path that currently means
hand-setting `AGENT_PRESENCE_RELAY` and wrangling a dev cert, and it's where
most of the friction actually lives. The fix is one opaque blob instead of
three environment variables:

```
# person one
agent-presence invite
# -> agent-presence join eyJyZWxheSI6IndzczovL...

# person two
npm i -g agent-presence
agent-presence join eyJyZWxheSI6IndzczovL...
```

The blob carries the relay URL, the bearer token, and — when the relay is
running TLS — the certificate itself. `join` writes
`~/.agent-presence/config.json` at 0600 and drops the PEM next to it.

**Corrected during implementation:** this section originally said the blob
pins a certificate *fingerprint*. There is no fingerprint pinning anywhere in
this codebase — `AGENT_PRESENCE_RELAY_CA` takes a PEM file and verifies the
full chain against it, and no leaf-hash path exists. So the blob carries the
whole PEM and `join` writes it where `AGENT_PRESENCE_RELAY_CA` can point.
Same trust property, different mechanism, and it's the one that's actually
implemented. `AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY` stays a deliberate
escape hatch and is not part of the happy path.

## Zero-config: solo user, no setup at all

If nobody has started a relay, the first agent starts one on localhost.

The mechanism: Claude Code is registered against `agent-presence mcp`, the
JS shim, not the Go binary directly. The shim checks `server.json`, dials the
relay, and if nothing answers it starts one on loopback before exec'ing
`agent-presence-mcp`. A solo user gets value having typed `setup` and nothing
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
`npm i -g agent-presence` from the public registry is not something I will
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
| `agent-presence start` to a listening relay | 141ms |
| nothing to a joined second machine | 1s |
| commands, person one | 2 (`npm i -g`, `agent-presence setup`) |
| commands, person two | 2 (`npm i -g`, `agent-presence join <blob>`) |

`--ignore-scripts` installs and runs with no degradation, which is the claim
the optionalDependencies choice rests on. Not verified: `npm publish` and the
registry install path, and `release.yml` — no tag was pushed.
