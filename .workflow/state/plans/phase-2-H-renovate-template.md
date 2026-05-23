# Phase 2 / Area H — Renovate Configuration Template — Implementation Plan

**Plan ID**: phase-2-H-plan
**Spec**: specs/phase-2/H-renovate-template.md
**Threat model**: N/A — operational configuration template; security posture bounded by Renovate's own well-known threat model + conservative defaults (no auto-merge, vulnerability lane separate) keep the blast radius small (per Prompt 3 + spec H)
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- Spec H's conservative-defaults framing is preserved: no auto-merge (NFR-H3), vulnerability-alerts lane is the only schedule-bypass path. Plan H task H.06 verifies these invariants.
- Closes `GAP_61_COVERAGE_MATRIX.md` gap #48 (Renovate template). H is the smallest plan in the Phase 2 set.

## Task list

### Task H.01 — Author `templates/renovate/renovate.json`
**REQ**: REQ-H1, H2, H3, H4, H5, H6
**AC**: AC-H1.1 through AC-H6.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: (none)
**Success criterion**: Valid JSON file at `templates/renovate/renovate.json` declaring: `extends: ["config:recommended"]` (REQ-H2); `schedule: ["before 9am on Monday"]` (REQ-H3); `vulnerabilityAlerts: { schedule: ["at any time"], labels: ["security"] }` (REQ-H4); a `packageRules` entry with `matchUpdateTypes: ["patch"]` + `groupName` (REQ-H5); `enabledManagers` including at minimum `npm`, `pip_requirements`, `pep621`, `pep723`, `cargo`, `gomod` (REQ-H6). AC-H1.1 through AC-H6.1 all pass.

### Task H.02 — Extend `docs/COST_OPTIMIZATION.md` with "Renovate setup for consumer projects" section
**REQ**: REQ-H7
**AC**: AC-H7.1
**Type**: docs
**Effort**: ~30 min
**Depends on**: H.01
**Success criterion**: H2 or H3 section titled `Renovate setup for consumer projects` (or close variant) exists with a link to `templates/renovate/renovate.json` AND a link to the Mend Renovate GitHub App install URL. Brief operational notes (3–4 sentences) on what to copy where. AC-H7.1 passes.

### Task H.03 — Extend `analyzer/recommendation-rules.yml` + `analyzer/scan.ts` for Renovate next-step detection
**REQ**: REQ-H8
**AC**: AC-H8.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: H.01
**Success criterion**: When a consumer project (i) lacks `renovate.json` AND `.github/dependabot.yml` AND (ii) has an upgrade-relevant manifest (`package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, etc.), the analyzer emits a `recommended.next_steps` entry pointing at `templates/renovate/renovate.json`. AC-H8.1 passes against the H.04 fixture.

### Task H.04 — Author analyzer fixture
**REQ**: REQ-H8
**AC**: AC-H8.1
**Type**: test
**Effort**: ~15 min
**Depends on**: H.03
**Success criterion**: Fixture at `tests/fixtures/analyzer/no-renovate-node-project/` contains a minimal `package.json` with no `renovate.json` and no `.github/dependabot.yml`. `node analyzer/scan.ts` against the fixture emits `recommended.next_steps` including a reference to `templates/renovate/renovate.json`. AC-H8.1 reproduces deterministically.

### Task H.05 — Author lint check for `renovate.json` template (CI gate)
**REQ**: AC-H1 through AC-H6 enforcement on every PR touching the template
**AC**: lint script PASSes on the well-formed template + FAILs on a deliberately broken fixture
**Type**: test
**Effort**: ~30 min
**Depends on**: H.01
**Success criterion**: Lint script at `.workflow/proofs/_checks/req-h-renovate.js` (or similar) parses `templates/renovate/renovate.json` and asserts AC-H1.1 through AC-H6.1 mechanically. Exit 0 PASS / non-zero FAIL with a named defect. Wired into the existing CI workflow.

### Task H.06 — Security-review: conservative-defaults invariants (NFR-H3)
**REQ**: NFR-H3 (security)
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~15 min
**Depends on**: H.01
**Success criterion**: Confirms (i) no `automerge` key set to true anywhere in the template; (ii) no broadened allowlists; (iii) the vulnerability-alerts lane (REQ-H4) is the ONLY schedule-bypass path; (iv) Renovate's "actionable CVE" definition is referenced (no overly-aggressive auto-bumping). Review checklist signed.

### Task H.07 — Emit per-REQ Phase 4 implementation claims (H1–H8)
**REQ**: meta — consolidates Step 4 claim emission for area H
**AC**: all H ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: H.01 – H.06
**Success criterion**: 8 new claim YAML files (one per REQ-H1 through REQ-H8) all valid per the claim-validator's re-run check.

## Dependency graph

```
H.01 (template) ─┬─► H.02 (docs)
                 ├─► H.03 (analyzer rules) ─► H.04 (fixture)
                 ├─► H.05 (lint check)
                 └─► H.06 (sec-review)
                                              │
                                              ▼
                                          H.07 (test — emit claims)
```

H.01 is the foundation — everything else depends on the template existing. H.02 / H.03 / H.05 / H.06 parallelise after H.01.

## Total effort estimate

- Implementation tasks (H.01, H.03): ~1.25 hours
- Test tasks (H.04, H.05, H.07): ~1.25 hours
- Security-review task (H.06): ~0.25 hours
- Docs task (H.02): ~0.5 hours
- **Grand total: ~3.0–3.5 hours of Step 4 implementation work for area H.**

## Out of scope for this plan

- Installing Renovate into a target project — handled by the consumer-project owner via the Mend Renovate GitHub App or self-hosted runner.
- Replacing GitHub's native Dependabot configuration in *this* repository — Dependabot is already enabled per Prompt 2 hygiene. The template is for *consumer* projects.
- Auto-merge policy — template ships conservative defaults (manual merge); auto-merge is a per-consumer decision documented but NOT enabled.
- Multi-repo Renovate orchestration (group-level configs) — deferred to v0.2.x or later.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area H plan decomposition; closes GAP_61_COVERAGE_MATRIX gap #48).
