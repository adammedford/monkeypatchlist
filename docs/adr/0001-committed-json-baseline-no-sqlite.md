# Committed JSON baseline, no SQLite in R1

The brief proposed SQLite for caches and baselines. Instead, a monkeypatchlist baseline is a deterministic JSON file committed to the repo. It holds one entry per finding: the fingerprint, the attributes that decide `changed`, and a readable label, with nothing that churns on a rebuild. It is created and updated only by `monkeypatchlist baseline init|update`. Accepting a platform mutation is a change-governance act, so it should show up as a reviewable PR diff. A SQLite file can't be reviewed or merged by hand. A previous-scan CI artifact ties the baseline to one CI vendor's retention and is never reviewed.

R1 also has no analysis cache, so SQLite has no remaining job. Per-artifact analysis is kept a pure function of (artifact bytes, catalog version, analyzer version), so a cache can be added later without changing any interface.

## Considered Options

- **Previous scan JSON kept as a CI artifact**: still accepted by `--baseline`, but not the canonical path. It is unreviewed and depends on retention.
- **SQLite**: its diffs are binary, it causes merge conflicts, and R1 has no other use for it.
