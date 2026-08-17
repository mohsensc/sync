// Minimal ambient declarations for the handful of node: builtins
// test/gitapi-scratch.test.ts needs to build a real scratch git repo on
// disk. There's no @types/node in this project (see gitapi.d.mts's own
// comment on why gitapi.mjs needs a hand-written .d.mts at all) and adding
// one is a package.json change outside test/'s file ownership for this
// round — this is the same "just enough for tsc" shim gitapi.d.mts already
// does for gitapi.mjs, one level down.
declare module 'node:child_process' {
  export function execFileSync(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; encoding?: string },
  ): string
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string
  export function writeFileSync(path: string, data: string): void
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
}
declare module 'node:os' {
  export function tmpdir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
