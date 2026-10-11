# A report used as a baseline reads as if updated

`--baseline` accepts a full JSON report as well as a baseline file ([ADR 0001](0001-committed-json-baseline-no-sqlite.md), spec §11), but a report's `findings[]` contains `added`, `changed`, `existing`, `removed` and `unconfirmed` entries, and nothing said which of them were accepted. The rule: a report is read **as if `baseline update` had just been run on that scan**. Every finding except `removed` is an accepted entry, under its current fingerprint (`added` and `changed` included). `unconfirmed` entries carry forward. The report's `packages` map serves as the baseline's, and its `scanConfigId` must match, as a baseline file's must ([ADR 0017](0017-baselines-record-a-scan-config-id.md)). Decided by the maintainer, 2026-09-26.

## Considered options

- **Only the report's `existing` findings.** Rejected. The previous scan's `added` findings would reappear as `added` on every later scan, so the gate would never clear.
- **Use the report's own `baseline` input.** Rejected. It isn't in the report, and it would make a report a pointer rather than a record.
- **Refuse reports as baselines.** Rejected. Comparing two CI runs (`--baseline last-run.json`) is the documented way to see what a single change did.
