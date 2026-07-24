# Publishing

Not published to npm yet — the package builds, packs, and is consumed by `@stopgap/shadow`
in this workspace; releasing it under the `shadow-ledger` name is the owner's call.

**Use `pnpm publish` / `pnpm pack`, never `npm pack`.** Workspace consumers import the TS
source, so `main`/`types`/`exports` point at `src/`; the `dist/` entrypoints live in
`publishConfig` and pnpm swaps them in at pack time. `npm pack` does not do that swap, and
the resulting tarball points at files it does not ship.

```bash
pnpm --filter shadow-ledger build
pnpm --filter shadow-ledger pack        # inspect the tarball
pnpm --filter shadow-ledger publish --access public
```

To split it into its own repository (PROJECT_PLAN §12 artifact 5 asks for a second pinned
repo), copy `packages/shadow-ledger/` to the new root, drop the workspace `pnpm-workspace`
inheritance by adding `typescript` and `vitest` to its own devDependencies (already declared),
and replace `@stopgap/shadow`'s `workspace:*` dependency with the published version.
