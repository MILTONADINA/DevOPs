# Phase 2 / Area E — Sigstore / Cosign Skill Signing — Implementation Plan

**Plan ID**: phase-2-E-plan
**Spec**: specs/phase-2/E-sigstore-signing.md
**Threat model**: docs/threat-models/phase-2/E-sigstore-signing.md (with OWASP AST 2026 section)
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- Threat model E covers AST02 (poisoning), AST04 (metadata manipulation), AST08 (update tampering). Plan tasks E.06 (cosign version pin), E.08 (AST02 + AST08 walkthrough), and E.09 (AST04 + Rekor audit trail) operationalise the threat model's defenses.
- Threat model E's residual "if attacker compromises CI" risk is acknowledged in spec E NFR-E3; task E.09 documents this in the threat model's Open issues section.

## Task list

### Task E.01 — Author `docs/SKILL_SIGNING.md`
**REQ**: REQ-E4
**AC**: AC-E4.1
**Type**: docs
**Effort**: ~45 min
**Depends on**: (none)
**Success criterion**: File contains H2 sections titled `Why Sigstore`, `Signing identity`, `Verify manually`, `What to do on failure`, `Rotation policy`. AC-E4.1 passes. Cross-references task F.13 (install-verification flow).

### Task E.02 — Author initial `governance/skill-manifest.yml`
**REQ**: REQ-E2
**AC**: AC-E2.1 (structural — placeholders permitted until first signing)
**Type**: implementation
**Effort**: ~45 min
**Depends on**: (none)
**Success criterion**: Manifest enumerates all 19 universal skills with `name`, `path`, `sha256` (computed at authoring time), `sig_path` (path it WILL hold after E.04), `signed_by` (placeholder until first signing CI run fills it), `signed_at` (placeholder), `rekor_log_index` (placeholder), `signed_with_version`. YAML parses; AC-E2.1 structural check passes.

### Task E.03 — Author `.github/workflows/release-sign.yml`
**REQ**: REQ-E3
**AC**: AC-E3.1
**Type**: implementation
**Effort**: ~60 min
**Depends on**: E.02
**Success criterion**: Workflow tag-triggers on `v\d+\.\d+\.\d+`, uses `cosign-installer@<sha-pin>` + cosign keyless OIDC, produces `SKILL.md.sig` per changed skill, commits the updated `governance/skill-manifest.yml`. Dry-run against a synthetic `v0.2.0-test` tag completes without errors.

### Task E.04 — First signing run: sign all 19 current universal skills
**REQ**: REQ-E1
**AC**: AC-E1.1
**Type**: implementation
**Effort**: ~30 min (CI runtime; per NFR-E1 ≤ 90 s for the full set)
**Depends on**: E.03
**Success criterion**: A first release tag triggers `release-sign.yml`; 19 `SKILL.md.sig` files materialise alongside their `SKILL.md` counterparts. `git ls-files 'skills/universal/**/SKILL.md.sig'` count equals `git ls-files 'skills/universal/**/SKILL.md'` count. AC-E1.1 passes.

### Task E.05 — Author trust-bundle cache + refresh tooling
**REQ**: REQ-E5
**AC**: AC-E5.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: (none — parallelisable with E.03)
**Success criterion**: `.workflow/sigstore/trust-bundle.json` populated from Sigstore root-of-trust bundle; refresh tooling (CLI subcommand or scheduled workflow) periodically refreshes the bundle. `cosign verify-blob --bundle-path .workflow/sigstore/trust-bundle.json` succeeds against a signed skill while network is disconnected. AC-E5.1 passes.

### Task E.06 — Security-review: pin cosign version in `release-sign.yml` + manifest
**REQ**: REQ-E7
**AC**: AC-E7.1
**Type**: security-review
**Effort**: ~20 min
**Depends on**: E.03
**Success criterion**: `release-sign.yml` pins `cosign` to a specific version string (not floating). Each manifest entry signed by the same CI run records the identical `signed_with_version`. AC-E7.1 passes. Closes the AST08 (Update tampering) path against the signing toolchain itself.

### Task E.07 — Author modified-skill detection test fixture
**REQ**: REQ-E6
**AC**: AC-E6.1
**Type**: test + security-review
**Effort**: ~30 min
**Depends on**: E.04
**Success criterion**: Test takes a signed skill (e.g., `process/karpathy-guidelines/SKILL.md`), appends one character, runs `cosign verify-blob`, confirms non-zero exit code AND the error message names the modified file. AC-E6.1 passes.

### Task E.08 — Security-review: AST02 (registry poisoning) + AST08 (update tampering) walkthrough
**REQ**: NFR-E3 (security)
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~30 min
**Depends on**: E.01 – E.07
**Success criterion**: Walkthrough against threat model E confirms: (i) Rekor transparency log entries are immutable + publicly auditable; (ii) `signed_with_version` pinning (E.06) forecloses malicious cosign-version-upgrade attacks; (iii) any modified skill is detected at verify time (E.07). No critical findings open.

### Task E.09 — Security-review: AST04 (metadata manipulation) + residual CI-compromise risk
**REQ**: NFR-E3, threat model E AST04 row
**AC**: residual-risk note present in threat model E Open issues
**Type**: security-review
**Effort**: ~30 min
**Depends on**: E.03, E.04
**Success criterion**: Confirms manifest entries are hash-pinned (AST04 mitigation). The residual "if attacker compromises CI, malicious manifest entries become possible" risk is documented in `docs/threat-models/phase-2/E-sigstore-signing.md` Open issues with the public Rekor log creating an audit trail as the primary deterrent. Note accepted.

### Task E.10 — Emit per-REQ Phase 4 implementation claims (E1–E7)
**REQ**: meta — consolidates Step 4 claim emission for area E
**AC**: all E ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: E.01 – E.09
**Success criterion**: 7 new claim YAML files (one per REQ-E1 through REQ-E7) all valid per the claim-validator's re-run check.

## Dependency graph

```
E.01 (docs)         E.02 (manifest) ─► E.03 (workflow) ─► E.04 (first signing run)
                                                                  │
E.05 (trust bundle, parallel) ─────────────────────────────► E.07 (modified-skill test)
                                                                  │
                                  E.06 (sec-review: cosign pin) ──┤
                                                                  ▼
                                  E.08 (sec-review: AST02/08) ─┬─► E.10 (test — emit claims)
                                  E.09 (sec-review: AST04) ─────┘
```

E.02 → E.03 → E.04 is the linear signing chain. E.05 (trust bundle) is independent and gates only E.07. Security reviews fold in before claim emission.

## Total effort estimate

- Implementation tasks (E.02, E.03, E.04, E.05): ~3.0 hours
- Security-review tasks (E.06, E.08, E.09): ~1.5 hours
- Test task (E.07): ~0.5 hours
- Docs task (E.01): ~0.75 hours
- Claim emission (E.10): ~0.5 hours
- **Grand total: ~6.25–6.75 hours of Step 4 implementation work for area E.**

## Step 4 carry-forwards (from Step 3 reviewer)

- **E.04 release-tag chicken-and-egg**: E.04 requires triggering `release-sign.yml` via a release tag matching `v\d+\.\d+\.\d+`, but Phase 2 isn't at v0.2.0 yet (current state: pre-tag, on `phase-2-security-depth` branch). Resolution options for E.03 authoring: (a) add a `workflow_dispatch` trigger to `release-sign.yml` so the first signing run can be initiated manually without a tag (most flexible; pairs well with a CI dry-run pattern); (b) define a pre-release tag schema like `v0.2.0-rc1` that also triggers signing (more formal; matches semver conventions). Decide before E.03 authoring begins so the workflow trigger spec is final on first write.
- **E.05 trust-bundle refresh cadence**: spec E says "refreshed periodically" without a concrete number. Resolution at E.05 implementation: pick a cadence (daily / weekly / on-release) and encode it in the refresh tooling itself (cron in a GitHub Actions workflow, or a Make target documented in `docs/SKILL_SIGNING.md`). Defaulting to weekly is safe — Sigstore's root-of-trust rotation has not historically been a high-frequency event.

## Out of scope for this plan

- Install-time verification — area F (this plan ships signing; F consumes signatures).
- Retroactive signing of Phase 1 commit history — out of scope per spec E (signatures cover skill content, not git history).
- Third-party skill registry / marketplace UI — post-v1.0.
- Stack-specific skills authored in area D — the signing flow defined here applies to them at next release, but their authoring is D's concern.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area E plan decomposition).
- 2026-05-23 miltonadina: added Step 4 carry-forward annotations for E.04 release-tag mechanism (workflow_dispatch vs v0.2.0-rc1 pre-release tag — decide before E.03 authoring) and E.05 trust-bundle refresh cadence (decide concrete number during implementation). Per Step 3 reviewer feedback; not structural revisions — operator notes for Step 4 start.
