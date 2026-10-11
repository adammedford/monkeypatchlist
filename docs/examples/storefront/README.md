# Example: storefront

A small app that the README and the guides scan. Each version holds what a deploy pipeline would have after a build:

- `dist/`: the deployed build, an `index.html` and one esbuild bundle
- `maps/`: the bundle's source map, kept outside `dist/` (the bundle has no `sourceMappingURL` comment)
- `package.json` and `package-lock.json`: the app's dependencies

The app's own `src/route-tracking.js` wraps `history.pushState`, and its one dependency, the fictional `@example/telemetry`, wraps `fetch`.

- `v1/` uses `@example/telemetry` 1.4.0.
- `v2/` upgrades it to 2.0.0, which also wraps `XMLHttpRequest.prototype.open`.

The source maps carry the full source of both. The bundles were built with esbuild 0.28.2:

```sh
esbuild src/main.js --bundle --minify --format=esm --sourcemap=external --entry-names='[name]-[hash]' --outdir=dist/assets
```

`test/docs.test.ts` copies a version into a scratch directory and runs every documented command there, so the docs and this example can't drift apart.
