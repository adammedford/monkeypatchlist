# Packages

Each folder here is a **deep module**: a lot of behaviour behind a small interface. Copy [`example/`](example/) to start one:

```
src/packages/
  <name>/
    index.ts        ← an entry point (public). Import this from outside.
    client.ts       ← another entry point. A package may expose several.
    lib/            ← implementation: private, its files import each other freely.
    tests/          ← co-located tests and fixtures: private.
```

A package's **entry points** are its root files; everything in a subfolder is private. Import a package only through its entry points. Packages are flat: one level under `src/packages/`, never a package inside a package.

**Expose small entry points, not a barrel.** Give each audience its own root file (`index.ts`, `client.ts`) that exports what it needs. A barrel that re-exports a whole subtree through one `index.ts` widens the interface until the package is shallow.

## Rules

`npm run lint:boundaries` (dependency-cruiser, [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs)) enforces these, and CI runs it. Each rule name below is what a violation prints.

**Entry-point boundary** (`entrypoint-boundary-from-app`, `entrypoint-boundary-across-packages`). Code outside a package, whether `src/index.ts`, `test/`, `tools/` or another package, imports that package's root files only, never anything in its subfolders.

**Intra-package freedom.** A package's own entry points and `lib/` files import each other freely.

**Tests through the entry points** (`tests-through-entrypoints`, `tests-folder-is-private`). Files under `<name>/tests/` import any package's entry points and their own `tests/` fixtures, never `lib/`, not even their own package's. Only tests import from a `tests/` folder.

**No cycles** (`no-circular`). No dependency cycles anywhere in `src`, `test` or `tools`.

## Build

`tsconfig.build.json` excludes `src/**/tests` so co-located tests stay out of `dist/` and the published package. It also excludes `src/packages/example`; drop that line if you delete the example.
