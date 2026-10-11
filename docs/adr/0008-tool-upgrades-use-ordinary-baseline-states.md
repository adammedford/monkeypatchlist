# Deltas from monkeypatchlist upgrades use ordinary baseline states; the catalog never drops a target on its own

A monkeypatchlist upgrade can change findings on unchanged code: a catalog bump adds a target, grows the protected list or changes a member's descriptor, and an analyzer change can newly resolve a wildcard or model a guard. These deltas get the ordinary baseline states `added`, `removed` and `changed`, and they trip `--fail-on` like any other. There is no separate "newly recognized" state. A delta that a catalog change could account for carries an `explainedBy` note, built from a catalog changelog shipped in the package. The note only offers an explanation; it doesn't claim the catalog change caused the delta. The documented path is to bump monkeypatchlist in its own PR and run `baseline update` there. To keep that churn small, the catalog is monotonic. A target that leaves `@webref/idl` but still ships (`Window.sharedStorage`, `Navigator.joinAdInterestGroup`) stays in the catalog as a **retained target**. Retained targets are removed only by a deliberate overlay edit, backed by BCD evidence that no current engine ships them.

## Considered options

- **A `recognized` state that `--fail-on added` does not trip** was rejected. In a PR that bumps monkeypatchlist alongside code changes, a genuinely new mutation of a newly catalogued target would slip past the gate. Analyzer-caused deltas also can't be traced to a cause one finding at a time, so the state would cover the catalog churn but not the analyzer churn.
- **Failing the gate on any version mismatch until `baseline update` runs** was rejected. It adds friction to every upgrade, including upgrades that change no findings.
- **Dropping targets automatically when BCD shows nothing ships them** was rejected. It would import BCD's own churn, and BCD is supposed to be a cross-check only.

## Consequences

- Any release that can change findings on unchanged code is a minor release. A patch release must reproduce byte-identical scan output on the corpus.
- `baseline update` refuses to rewrite a baseline written by a newer monkeypatchlist or catalog, unless `--allow-downgrade` is passed.
