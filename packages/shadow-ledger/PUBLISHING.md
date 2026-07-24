# Publishing

Not published to npm yet — the package builds, packs, and is consumed by `@stopgap/shadow`
in this workspace; releasing it under the `shadow-ledger` name is the owner's call.

**Use `pnpm publish` / `pnpm pack`, never `npm publish` / `npm pack`.** This is deliberate,
not an oversight. Workspace consumers (`@stopgap/shadow`) import the TS source, and the local
gate runs `typecheck` before `build`, so the on-disk `main`/`types`/`exports` must point at
`src/` or in-repo typechecking breaks before any `dist/` exists. The shippable `dist/`
entrypoints live in `publishConfig`, which **pnpm** swaps into the manifest at pack/publish
time.

npm does **not** honor `publishConfig` overrides of `main`/`types`/`exports` (only `registry`,
`tag`, `access`). Publishing this package with the npm CLI therefore produces a manifest whose
entrypoints point at `src/`, which `files` does not ship — a broken tarball. The repo pins
pnpm via `packageManager` + corepack; keep publishing on pnpm. If this package is ever split
into its own repo, that repo can instead point `main`/`types`/`exports` straight at `dist` and
drop the `publishConfig` dance, since it will have no source-consuming workspace sibling.

```bash
pnpm --filter shadow-ledger build
pnpm --filter shadow-ledger pack        # inspect the tarball
pnpm --filter shadow-ledger publish --access public
```

To split it into its own repository (PROJECT_PLAN §12 artifact 5 asks for a second pinned
repo), copy `packages/shadow-ledger/` to the new root, drop the workspace `pnpm-workspace`
inheritance by adding `typescript` and `vitest` to its own devDependencies (already declared),
and replace `@stopgap/shadow`'s `workspace:*` dependency with the published version.
