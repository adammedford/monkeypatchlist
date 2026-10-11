# One resolver implementation per release

A native analyzer is permitted behind the resolver seam if the cost target isn't met in JavaScript (decided when the R0 bar was re-scoped). If a release shipped both a native and a JS resolver, falling back to JS where no prebuilt binary exists, then two machines could produce different findings for the same build. That breaks the baseline (a developer laptop and CI would disagree on `added` and `changed`) and the promise that a patch release reproduces corpus output byte for byte. So each monkeypatchlist release ships **exactly one** resolver implementation, and the report records `tool.analyzerVersion`. There is no fallback. A missing platform binary is an internal error (exit 4) that names the supported platforms. Changing the implementation is at least a minor release, and it must meet identity invariance on the validation corpus. Decided by the maintainer, 2026-09-26.

## Considered options

- **Native first, JS fallback on unsupported platforms.** Rejected. Findings would depend on the machine, which is invisible to the user and fatal to a committed baseline.
- **Both, with a CI check that they agree.** Rejected. Agreement on the corpus doesn't prove agreement on user code, and every divergence would surface as false `changed` in someone's gate.
- **Let the user choose the implementation.** Rejected for the same reason. It would also have to enter the scan-config id, which splits baselines across teams.
