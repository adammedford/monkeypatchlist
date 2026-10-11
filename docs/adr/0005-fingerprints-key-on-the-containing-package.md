# Fingerprints key on the containing package, never the introducing dependency

A platform mutation inside a transitive dependency is related to two packages: the **containing package** (whose file holds the code, read from the source-map path) and the **introducing dependency** (the direct dependency that pulled it in, readable only from a lockfile's dependency graph). The fingerprint's attribution key uses only the containing package's name, with no version. The introducing dependency is reported as evidence on each occurrence and never becomes identity. The reason is stability. The containing package can be recovered on every scan that has source maps. The introducing dependency depends on an optional input, can have several values at once, and changes when the dependency tree is reshuffled even though the code has not changed. Any of these would re-key findings and churn the committed baseline ([ADR 0001](0001-committed-json-baseline-no-sqlite.md)).

## Considered options

- **Key on the introducing dependency** matches the brief's "Introduced by telemetry-agent@8.0" wording, but it was rejected. Supplying or dropping `--lockfile` would re-key every transitive finding, and so would `@acme/sdk` dropping `otel-fetch` while the app adds it directly.
- **Key on both** was rejected for the same reasons, and because two introducers would split one mutation into two findings.

## Consequences

- `introducedBy[]` is never stored in the baseline projection and never feeds `changed`.
- Without a lockfile, introducers are unknown. They are not guessed from npm's nesting chain, because hoisting makes the outermost `node_modules` segment unreliable.
