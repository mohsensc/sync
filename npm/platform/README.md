# npm/platform

Generated. Not checked in.

Each `<os>-<arch>/` here is one `@agent-sync/<os>-<arch>` package: a
`package.json` with the matching `os`/`cpu` fields (that's what makes npm
pick the right one) and a `bin/` full of prebuilt binaries. The
`agent-sync` wrapper in `npm/agent-sync` lists all five as
`optionalDependencies`; npm installs only the one that matches the machine.

Regenerate with:

```
scripts/build-npm-packages.sh          # build binaries + write the packages
scripts/build-npm-packages.sh --pack   # also npm pack everything into dist-npm/
```

The version is never set here by hand — it's read from
`npm/agent-sync/package.json` and stamped onto every platform package,
so the wrapper's pinned `optionalDependencies` versions can't drift from
what's actually in these folders.

ap-hook (C++) only builds for whatever platform is running the script. This
machine can't cross-compile it, so most of these five packages ship without
it — the script's output says which one got a real hook and which four
didn't.
