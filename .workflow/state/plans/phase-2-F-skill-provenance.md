# Phase 2 / Area F — Skill Provenance Verification at Install — Implementation Plan

**Plan ID**: phase-2-F-plan
**Spec**: specs/phase-2/F-skill-provenance.md
**Threat model**: docs/threat-models/phase-2/F-skill-provenance.md (with OWASP AST 2026 section; honest documentation of post-install revocation gap)
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- **Bounded scope**: this plan implements REQs F1–F7 only. The post-install revocation gap (threat model F Open Issue #1 / ASI10 row) is **DEFERRED TO PHASE 3 (memory & observability)**. Plan F makes no attempt to address it; honest acknowledgment carried in spec F + threat model F.
- Threat model F covers AST01 (direct target — installer is the gate), AST02 (joint with E), AST03 (partial — manifest path canonicalisation forecloses typosquatting at install time).
- Cross-area dependency: F.09 (fixture authoring) depends on E.04 (first signing run) — the fixture needs at least one signed skill to exercise AC-F1.1.

## Task list

### Task F.01 — Extend `analyzer/install.ts` with CLI parsing for new flags
**REQ**: REQ-F3, F4, F6, F7
**AC**: structural — CLI parsing unit-tests cover --allow-unsigned, --rationale=..., --dry-run, --manifest <path>
**Type**: implementation
**Effort**: ~45 min
**Depends on**: (none)
**Success criterion**: `--allow-unsigned`, `--rationale="..."`, `--dry-run`, `--manifest <path>` all parsed correctly; mutual-exclusion rules enforced (`--allow-unsigned` without non-empty `--rationale` rejects per F.05). Unit-test coverage for each flag combination.

### Task F.02 — Implement verification call-site (cosign verify-blob)
**REQ**: REQ-F1
**AC**: AC-F1.1
**Type**: implementation
**Effort**: ~60 min
**Depends on**: F.01
**Success criterion**: Before copying any skill from the source directory to the target's `.claude/skills/`, the installer invokes `cosign verify-blob` (or equivalent Sigstore verifier) against the skill + its `.sig`. Verbose output shows `verified: skills/universal/...` per skill. AC-F1.1 passes against a properly signed fixture skill.

### Task F.03 — Implement reject-unsigned path (exit 2, name skill)
**REQ**: REQ-F2
**AC**: AC-F2.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: F.02
**Success criterion**: When a skill has no `.sig` OR has an invalid signature, the installer prints `unsigned: <skill path>`, exits with status **2** (distinct from generic-error 1), and does NOT copy the skill. AC-F2.1 passes.

### Task F.04 — Implement `--allow-unsigned` + mandatory `--rationale` path
**REQ**: REQ-F3
**AC**: AC-F3.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: F.01, F.02
**Success criterion**: When both `--allow-unsigned` AND `--rationale="<non-empty>"` are provided, unsigned skills are copied AND a JSONL entry is appended to `.workflow/state/install.log` containing the timestamp, skill path, decision=overridden, and rationale string. AC-F3.1 passes.

### Task F.05 — Implement `--allow-unsigned` without `--rationale` rejection
**REQ**: REQ-F4
**AC**: AC-F4.1
**Type**: implementation
**Effort**: ~20 min
**Depends on**: F.01
**Success criterion**: `--allow-unsigned` provided without `--rationale="..."` (or with an empty rationale) → installer exits non-zero with the message `--rationale="..." is required when --allow-unsigned is used`. AC-F4.1 passes.

### Task F.06 — Implement `install.log` JSONL writer (REQ-F5)
**REQ**: REQ-F5
**AC**: AC-F5.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: F.02, F.03, F.04
**Success criterion**: Every verification decision (`pass` / `fail` / `overridden`) appends one valid JSONL line to `.workflow/state/install.log` with fields: `timestamp` (ISO 8601), `skill_path`, `decision`, `sha256`, `signed_by` (when present), `rationale` (when overridden). AC-F5.1 passes; lines are JSONL-parseable individually.

### Task F.07 — Implement `--dry-run` mode (REQ-F6)
**REQ**: REQ-F6
**AC**: AC-F6.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: F.02, F.06
**Success criterion**: `--dry-run` performs all verification checks AND prints `dry-run: would copy N skills` to stdout, BUT does NOT mutate the target directory. AC-F6.1 passes; target dir contents unchanged after the run.

### Task F.08 — Implement `--manifest <path>` alternate-manifest path (REQ-F7)
**REQ**: REQ-F7
**AC**: AC-F7.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: F.01, F.02
**Success criterion**: When `--manifest <path>` is provided, verification consults the named manifest instead of the default `governance/skill-manifest.yml`. Enables per-project trust overrides at v0.2.x without API redesign. AC-F7.1 passes against `./tests/manifests/dev.yml`.

### Task F.09 — Author fixture skill source dir (signed + unsigned)
**REQ**: REQ-F1 through REQ-F7 (acceptance criteria all require this fixture)
**AC**: prerequisite for AC-F1.1 through AC-F7.1
**Type**: test
**Effort**: ~45 min
**Depends on**: F.01, **E.04** (cross-area dependency — needs at least one signed skill from the first signing run)
**Success criterion**: Fixture at `tests/fixtures/install/source-skills/` contains (i) one properly signed skill with valid `.sig`, (ii) one skill missing its `.sig`, (iii) one skill whose `.sig` is structurally valid but signature does not match the file content. AC-F1.1, AC-F2.1, AC-F3.1 all reproduce deterministically against this fixture.

### Task F.10 — Integration test: every flag combination
**REQ**: REQ-F1 through REQ-F7
**AC**: AC-F1.1 through AC-F7.1
**Type**: test
**Effort**: ~45 min
**Depends on**: F.01 – F.09
**Success criterion**: Test harness invokes the installer with: (default), (--allow-unsigned --rationale="..."), (--allow-unsigned without --rationale → exits 1), (--dry-run), (--manifest ./tests/manifests/dev.yml), and meaningful combinations of the above. All ACs verified end-to-end; no false-pass leaks.

### Task F.11 — Security-review: defense-in-depth — hash-check + PII redaction
**REQ**: NFR-F3, NFR-F4
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~30 min
**Depends on**: F.04, F.06
**Success criterion**: Confirms (i) the hash-check against `governance/skill-manifest.yml` is ALWAYS run, even with `--allow-unsigned --rationale="..."` (signature-existence bypass does NOT bypass the hash check — defense-in-depth against signature replay); (ii) `rationale` strings are logged verbatim in `install.log` but PII-redacted at any telemetry export. Both unit-tested.

### Task F.12 — Security-review: AST01 / AST02 / AST03 defense walkthrough
**REQ**: NFR-F3 (security), threat model F
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~30 min
**Depends on**: F.01 – F.10
**Success criterion**: Walkthrough against threat model F confirms: (i) installer is the gate against AST01 (untrusted registries); (ii) AST02 (registry poisoning) addressed by E + F together — F refuses to install skills not in the manifest; (iii) AST03 (typosquatting) partially mitigated — manifest `path` field is canonical, typo'd names have no manifest entry and are rejected by REQ-F1. The post-install revocation gap (Open Issue #1) is reaffirmed as **DEFERRED TO PHASE 3** — no Phase 2 attempt.

### Task F.13 — Update `docs/SKILL_SIGNING.md` with install-verification flow
**REQ**: cross-reference completeness (E.01 produces the file; F documents the consumption flow)
**AC**: new H2 section "Install-time verification" added with the F1–F7 flag matrix
**Type**: docs
**Effort**: ~30 min
**Depends on**: E.01, F.01 – F.10
**Success criterion**: H2 section "Install-time verification" exists in `docs/SKILL_SIGNING.md` with a flag matrix (default / --allow-unsigned --rationale / --dry-run / --manifest) and a worked invocation example. Cross-references the threat model's post-install revocation gap as DEFERRED.

### Task F.14 — Emit per-REQ Phase 4 implementation claims (F1–F7)
**REQ**: meta — consolidates Step 4 claim emission for area F
**AC**: all F ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: F.01 – F.13
**Success criterion**: 7 new claim YAML files (one per REQ-F1 through REQ-F7) all valid per the claim-validator's re-run check.

## Dependency graph

```
F.01 (CLI parsing) ─┬─► F.02 (verify) ─┬─► F.03 (reject path)
                    │                  ├─► F.04 (--allow-unsigned)
                    │                  ├─► F.06 (install.log)
                    │                  ├─► F.07 (--dry-run)
                    │                  └─► F.08 (--manifest)
                    └─► F.05 (--allow-unsigned without rationale)

E.04 (signing run, cross-area) ──► F.09 (fixture)
                                       │
                                       ▼
                          F.10 (integration tests)
                                       │
                  F.11 (sec-review hash+PII) ─┐
                  F.12 (sec-review AST01-03) ─┴─► F.13 (docs cross-ref) ─► F.14 (test — emit claims)
```

F.02 fans out to F.03/F.04/F.06/F.07/F.08 (all install-time behaviours layer on the verification call-site). F.09 is gated by E.04 (signed-skill fixture). Security reviews precede docs cross-ref and claim emission.

## Total effort estimate

- Implementation tasks (F.01–F.08): ~4.75 hours
- Test tasks (F.09, F.10, F.14): ~2.0 hours
- Security-review tasks (F.11, F.12): ~1.0 hours
- Docs task (F.13): ~0.5 hours
- **Grand total: ~7.5–8.0 hours of Step 4 implementation work for area F.**

## Out of scope for this plan

- **Post-install revocation gap** — deferred to Phase 3 (memory & observability) per threat model F Open Issue #1. Plan F bounded by REQs F1–F7 only.
- The signing flow itself — area E.
- New CLI subcommands beyond installer extensions — out of scope (the `devops approve` CLI in area C is orthogonal).
- Third-party skill marketplace browsing UI — post-v1.0.
- Per-project trust-policy overrides ("trust this signer for this project only") — `--manifest` flag enables the mechanism, but the trust-policy schema itself is deferred to v0.2.x.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area F plan decomposition).
