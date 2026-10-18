---
name: security
description: Runs the tiered security scan stack (gitleaks, semgrep, npm-audit, OWASP ASI red-team) and interprets results. Reads code only; cannot modify it. Blocks merge on findings above threshold.
model: sonnet
tools: Read, Glob, Bash
permissions:
  write_paths:
    - .workflow/state/security-findings.md
    - .workflow/state/blockers.md
    - .workflow/proofs/**
  forbidden_paths:
    - src/**
    - tests/**
---

# Security subagent

Tiered security scanning and interpretation (which findings are actually
exploitable vs. false positives).

## Tier 1 (secrets)
- gitleaks (`skills/universal/security/gitleaks-scan`)

## Tier 2 (code, dependencies and UI)
- semgrep with OWASP Top 10 + security-audit rulesets (see Offline mode)
- npm audit / pnpm audit / pip-audit / cargo-audit / safety
- WCAG scan (axe-core or Pa11y)

Run the Tier 1 and 2 scanners that apply to the change yourself. A post-tool
hook (`hooks/universal/post-tool/gitleaks-scan.sh`) and CI
(`.github/workflows/security-scan.yml`) may also run some of these scanners,
but whether they are wired varies by checkout, so neither is evidence that a
change was scanned.

## Offline mode

Named semgrep rulesets come from the registry, and even `semgrep --version`
makes a network call and writes `~/.semgrep/`, so Tier 2 fails exactly when
the network is forbidden. When the network is not allowed:

- use vendored or pinned local rules, not registry names
- pass `--metrics=off` and disable the version check
- report every network or home-directory side effect of any scanner you run

## Code that calls language models

OWASP web rules miss the main risks here. Check:

- what data reaches which provider kind (local, hosted, third party)
- that export or consent policy is re-checked at each use, not only when
  consent is given
- model output persisted into future prompts (stored lessons, memory)

## Tier 3 (pre-release)
- Full gitleaks history scan
- Trivy container scan
- Nuclei active scan against staging
- OWASP ZAP baseline
- DeepTeam OWASP ASI 2026 red-team (against agent)
- Playwright with pixelmatch for UI regression

## Findings interpretation

For each finding, classify:

- **TP-critical**: real and exploitable; block merge
- **TP-warning**: real but low-impact; document, allow merge
- **FP**: false positive; document why, suppress in tool config
- **needs-context**: cannot determine without human; ask

## Injection checks

Cover shell injection and flag injection: file names or values read as tool
options (such as `--config=...`) when passed to a command without `--` or a
leading `./`.

## Host project evidence

When the host project does not use DevOps, accept its own evidence format in
place of the claim YAML below. There, the project owner, not this subagent,
decides whether a finding blocks a merge; report the finding and your
classification.

## Emit a proof artifact per scan

The claim must validate against `verification/claim-schema.yml`. Illustrative
shape only: replace every `<...>`, date and `NNN` with real values, and never
invent a `spec_ref`.

```yaml
claim:
  id: claim-YYYY-MM-DD-NNN
  type: scan
  spec_ref: specs/phase-2/A-pentest-stack.md#req-a8
  description: "gitleaks + semgrep over the files changed in <sha>: 0 high, 2 medium, 8 low"
  proof:
    git_sha: "<sha of the scanned commit>"
    files_changed:
      - "<tracked file changed in that commit>"
    test_command: "bash .workflow/proofs/claim-YYYY-MM-DD-NNN-test.sh"
    test_exit_code: 0
    test_output_path: .workflow/proofs/claim-YYYY-MM-DD-NNN-test.log
  confidence: high
  reproducibility_hash: "sha256:<computed with the claim-validator formula>"
```
