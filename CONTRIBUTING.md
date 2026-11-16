# Contributing

Use [Bun](https://bun.sh) 1.4.4. Keep changes on a branch and open a pull
request that says what behavior changes and how you verified it.

```sh
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun run test
```

## Maintainership and review

Curlew Labs maintains this project. Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) reviews changes
and approves releases. Use issues for reproducible defects and proposals; use
[private vulnerability reporting](SECURITY.md) for security concerns.

Changes land through pull requests with passing CI and maintainer review. A
change to a schema in `schema/` must be additive (README sec."Schema changes").
Every dependency is pinned to an exact version.

## Releases

1. Set `version` in `package.json` on `main`.
2. Push the tag `vX.Y.Z` at that commit. The Release workflow runs CI, packs the
   tarball and opens a draft release with it attached.
3. Check the draft, then publish it. Releases are immutable: a published
   release's tag and assets cannot be changed, so a fix is a new version.
