# Security — Baseline for the scheduled full-history secret scan

**Spec ID**: security/history-secret-scan-baseline
**Status**: approved (owner: "go with your recommendations", 2026-09-25)
**Last updated**: 2026-09-25
**Owner**: miltonadina

---

## Context

`.github/workflows/security-scan.yml` runs `gitleaks-action` on pull requests, on pushes to `main`, and on a daily schedule. The pull-request and push runs scan only new commits. The scheduled run scans the whole history, and it has failed every day since at least 2026-09-14. It fails on the same seven findings every time, and all seven are deliberate test fixtures:

- fake credentials in `tests/fixtures/security/poisoned-mcp-config.json`, the REQ-A8 negative fixture that must stay detectable;
- JWT- and key-shaped inputs in two Stratum redaction test files.

A job that is always red cannot show a real leak: a real finding would be an eighth line on a run everyone has learned to ignore. The fixtures must stay detectable by a directory scan (REQ-A8, `specs/phase-2/A-pentest-stack.md`), and the CI allowlist in `governance/gitleaks-ci.toml` must keep its single-file scope (claim 2026-09-14-013).

## Out of scope

- The CI allowlist's path list. It is unchanged.
- The tier-1 post-tool hook, which is not wired in this checkout.

## Functional requirements (EARS)

### REQ-HSB-1 (Ubiquitous) — Exact-fingerprint baseline
THE SYSTEM SHALL keep a root `.gitleaksignore` that lists each reviewed historical fixture finding by its exact git-mode fingerprint (`commit:file:rule:line`) and nothing broader.

### REQ-HSB-2 (Ubiquitous) — Pinned scanner version
THE SYSTEM SHALL pin the gitleaks version the CI action runs, through `GITLEAKS_VERSION` in `security-scan.yml`, to the version that produced the baseline's fingerprints.

### REQ-HSB-3 (Unwanted behaviour) — New secrets still fail
IF any commit adds a secret-shaped string that is not in the baseline, including a new line in a baselined file, THEN THE SYSTEM SHALL fail the history scan.

### REQ-HSB-4 (Ubiquitous) — Fixtures stay detectable
THE SYSTEM SHALL continue to report the REQ-A8 poisoned fixture in a directory scan while the baseline file is present.

## Acceptance criteria

### AC-HSB-1.1 (REQ-HSB-1, REQ-HSB-2)
**Given** the commit that adds the baseline **When** gitleaks, at the pinned version with `governance/gitleaks-ci.toml`, scans that commit's history **Then** it reports no findings. **When** the baseline is set aside **Then** it reports exactly the baselined fingerprints.

### AC-HSB-3.1 (REQ-HSB-3)
**Given** a scratch commit on top that adds a fresh fake live key **When** the history scan runs with the baseline **Then** it reports exactly one finding, in the new file.

### AC-HSB-4.1 (REQ-HSB-4)
**Given** the poisoned fixture copied beside the baseline file **When** a directory scan runs **Then** it reports at least one finding.

### AC-HSB-5.1 (claim 013 invariant)
**Given** the commit **When** `governance/gitleaks-ci.toml` is compared with its content at `408ee2f` **Then** the allowlist `paths` are identical.
