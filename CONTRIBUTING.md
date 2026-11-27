# Contributing

Thanks for your interest in improving `d1-follow`. The bar for a change is
whether it keeps a Worker's Durable Objects beside its D1 database's primary as
the primary moves, and leaves every object serving where it is when the package
cannot tell where the primary is. Bug fixes, the pieces the README's
[Status](README.md#status) still lists as design, sharper reports from the
creator and the census, and clearer docs are all welcome.

Use [Bun](https://bun.sh) 1.4.4. Keep changes on a branch and open a pull
request that says what behavior changes and how you verified it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

eslint runs in CI through ci-baseline. To run the same check locally, after
installing dependencies: `<a ci-baseline checkout>/lib/lint-local.sh`. It runs
the ci-baseline commit this repository's workflows pin.

## Maintainership and review

Curlew Labs maintains this project. Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) reviews changes
and approves the releases that [need approval](#releases). Use issues for
reproducible defects and proposals; use
[private vulnerability reporting](SECURITY.md) for security concerns.

Changes land through pull requests with passing CI and maintainer review. A
change to a table a release has shipped must be additive (README sec."Schema
changes"). Every dependency is pinned to an exact version.

## Stability before 1.0

Before 1.0, a change may alter the package's interface: what its entry points
export, by name, signature or type; the entry points `package.json` declares;
and the values it puts on the wire and in its logs, such as a mode's name. A
release keeps nothing for an earlier 0.x release's callers, so a change need not
either. A release that carries such a change is a minor, never a patch, so it
needs the approval [Releases](#releases) describes, and its notes say what
changed.

The schemas are narrower, because a database outlives the release that built it:
a table a published release created changes only additively and keeps the
meaning of the values it stores, while a table no release has shipped may change
in any way until one does (README sec."Schema changes").

## Before a large change

Open an issue describing the problem first. The design in the README carries the
invariants: a stateless object decides before any D1 work and forwards a request
at most once, a lane changes hands only inside its holder's lock, and the
creator acts only while it holds its pass lease and never empties an object it
must keep. A feature belongs here only if it stays useful with the app swapped
for another. A short discussion up front saves rework.

## Releases

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

1. Set `version` in `package.json` on `main`.
2. Push the tag `vX.Y.Z` at that commit. The Release workflow runs CI, packs the
   tarball and opens a draft release with it attached.
3. Check the draft, add to its notes what changed since the last release - each
   export, entry point, wire or log value, and table that changed - then publish
   it. Releases are immutable: a published release's tag and assets cannot be
   changed, so a fix is a new version.

## License

By submitting a contribution for inclusion in this project, you agree that it is
licensed under the MIT and Apache-2.0 licenses, as the README's License section
describes, without any additional terms or conditions.
