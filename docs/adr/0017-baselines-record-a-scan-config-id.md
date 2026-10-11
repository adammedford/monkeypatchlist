# Baselines record a scan-config id, and a mismatch is a usage error

A baseline is valid for one scan configuration (spec §11), but nothing checked that. A baseline written with `--surface all` and read by a `protected` scan, or read against a different entry document, would report a wall of `removed` and `added` findings that look like real platform change. So the baseline header records a **scan-config id**: a hash of the fields that decide which findings can exist. Those are the entry documents (file and URL), the URL→path mappings, `--surface` and the realm set. Scanning against a baseline with a different id is a usage error (exit 2) that names the fields that differ. Decided by the maintainer, 2026-09-26.

## Considered options

- **Include the mode, source-map directories and lockfile.** Rejected. The mode's difference is already absorbed by `unconfirmed`. Maps and lockfile are optional evidence that must never change identity ([ADR 0006](0006-attribution-identity-ignores-optional-inputs.md)), so they must not split baselines either.
- **Check only `surface`.** Rejected. An entry or mapping change produces the same false churn.
- **No check.** Rejected: the failure looks like real change.
