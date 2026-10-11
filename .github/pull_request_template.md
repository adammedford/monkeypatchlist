## What and why

<!-- What the change does, and the issue it fixes or the spec section it implements. -->

## Findings

<!-- Can this change findings on unchanged code (a catalog bump, an analyzer change, a corpus change)? If so, it is minor-release material: refresh corpus-snapshot/ with `npm run corpus:snapshot` and review the diff as the finding churn users will see. See CONTRIBUTING.md. -->

- [ ] This change gives byte-identical reports on the validation corpus (`npm run corpus:check` passes), **or** it is bound for a minor release and refreshes `corpus-snapshot/`.

## Checklist

- [ ] The gate passes: `npm run typecheck && npm run lint && npm run lint:boundaries && npm run build && npm test && npm run catalog:check && npm run fixtures:check`
- [ ] New behaviour has tests.
- [ ] User-facing changes are documented (README, `docs/`) and listed under `[Unreleased]` in `CHANGELOG.md`.
- [ ] Catalog changes: the target diff is regenerated (`npm run catalog`), and any line it marks has a sign-off in `catalog/sign-off.json`.
- [ ] The change contains no holdout corpus material, and wasn't written from it.
