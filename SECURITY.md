# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a vulnerability. No email address is published for this project.

Include what you can of:

- the monkeypatchlist version and catalog version (`tool.monkeypatchlistVersion` and `tool.catalogVersion` in a `--json` report)
- the command and configuration you ran
- a minimal build directory or script that shows the problem, or the steps to reproduce it
- what an attacker gains

You'll get an acknowledgement in the advisory thread. The fix is developed in a private fork of the advisory, and the advisory is published with the release that fixes it, crediting you unless you ask otherwise.

## What counts

monkeypatchlist reads untrusted input: the build directory, captured HTML, source maps, lockfiles and, in `--mode resolve`, remote scripts. Examples of vulnerabilities:

- code execution from scanned input, or from `monkeypatchlist.config.json` (monkeypatchlist never executes its configuration or the code it scans)
- network access without `--mode resolve`, or a request in `resolve` mode that escapes the fixed safety floor: a refused scheme or address (loopback, private, link-local or cloud-metadata), unverified TLS, credentials or cookies sent, or the count, size, redirect or time caps exceeded
- reading or writing files outside the paths the command was given
- a crafted input that makes a scan report `complete` while it silently skipped native work

A missed or false finding on ordinary code is an accuracy bug, not a vulnerability. Report it with the **False positive or missed mutation** issue template. monkeypatchlist is a static scanner, not a malware detector: code that hides a platform mutation from static analysis, or that a scan names among its known limitations ([docs/limitations.md](docs/limitations.md)), is not a vulnerability in monkeypatchlist.

## Supported versions

Security fixes go into the latest minor release line, as a patch release. Older release lines get no fixes; upgrade to the latest minor release.

| Version | Supported |
|---|---|
| Latest minor release | Yes |
| Older releases | No |
