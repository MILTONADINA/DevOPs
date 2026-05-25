# Threat Model — Phase 2 Area E — Sigstore / Cosign Skill Signing

**Spec**: `specs/phase-2/E-sigstore-signing.md`
**Date**: 2026-05-22
**Author**: miltonadina (Claude Code, Opus 4.7)
**Reviewer**: miltonadina
**Status**: draft

---

## System sketch

```
skill author / maintainer
    │
    ▼ commit + push  [TRUST BOUNDARY — author ↔ repo]
    GitHub repository (branch protection on main + tag protection)
    │
    ▼ on tag push matching v\d+\.\d+\.\d+
    GitHub Actions workflow: .github/workflows/release-sign.yml
    │ (cosign version pinned; OIDC token request)
    │
    ▼ keyless OIDC  [TRUST BOUNDARY — CI ↔ Sigstore]
    Sigstore (Fulcio CA issues ephemeral cert; signing event)
    │
    ▼ inclusion proof
    Rekor transparency log  [PUBLIC LOG]
    │
    ▼ artifacts
    .sig files committed back to repo + governance/skill-manifest.yml updated
       (signed by the same CI identity that produced the signatures)
    │
    ▼ verification consumed by area F at install time
```

The signing identity is the GitHub Actions workflow's ambient OIDC identity — there are no long-lived private keys to custody, lose, or rotate. Every signing event is publicly auditable in Rekor.

## Trust boundaries

1. **Skill author → repo** [TRUST BOUNDARY] — branch protection on `main` + tag protection limit who can push the release tag that triggers signing.
2. **CI workflow → Sigstore** [TRUST BOUNDARY] — keyless OIDC token request; GitHub Actions ambient identity scoped to the workflow's identity claim.
3. **CI → repo (signature + manifest commits)** [TRUST BOUNDARY] — `release-sign.yml` commits `.sig` files and the updated `governance/skill-manifest.yml` with a bot identity authorised only via the workflow run.
4. **Sigstore → Rekor** [TRUST BOUNDARY — PUBLIC LOG] — every signing event ends up in the public transparency log; this is the audit-trail-of-last-resort and the basis for offline verifiability.
5. **Trust bundle cache → offline verifier** [TRUST BOUNDARY] — `.workflow/sigstore/trust-bundle.json` is the local source of truth for offline verification (consumed by area F).

## Data classes

| Class | Where stored | Where transmitted | Retention |
|-------|--------------|-------------------|-----------|
| Skill source (`SKILL.md`) | repo | per release | indefinite |
| Signature (`SKILL.md.sig`) | repo + Rekor | per release | indefinite (Rekor immutable) |
| Manifest entry | `governance/skill-manifest.yml` | per release | indefinite |
| Sigstore OIDC token | runner ephemeral env | once per signing event | ephemeral (auto-expires) |
| Trust bundle | `.workflow/sigstore/` | local-only | refreshed periodically |

---

## STRIDE analysis

| Threat | Description | Mitigation | Status |
|--------|-------------|------------|--------|
| **Spoofing** | Attacker forges a signature without a legitimate OIDC identity | Keyless OIDC requires a GitHub Actions runner credential AND Rekor inclusion; both are independently verifiable | spec'd |
| **Tampering** | Skill content modified post-sign | Verifier in area F catches via hash + signature mismatch; tampering invalidates the signature | spec'd |
| **Repudiation** | Who signed this skill? | Sigstore identity recorded in `skill-manifest.yml.signed_by` + Rekor public log entry (public, immutable, queryable) | spec'd |
| **Information disclosure** | Signing flow handles no PII | — | N/A |
| **Denial of service** | Sigstore unavailability blocks signing | Signing is per-release, not per-PR; release can wait. Rekor unavailability does NOT block verification (offline trust bundle covers AC-E5.1) | spec'd |
| **Elevation of privilege** | Compromised CI runner gains signing capability | Workflow scoped to release-tag refs only; tag protection on main; OIDC token claim is workflow-specific so a different workflow cannot impersonate the signer | spec'd |

---

## OWASP Top 10 for Agentic Applications (ASI) 2026

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| ASI01 | Agent Goal Hijacking | N/A | The signing flow does not ingest agent input; there is no agent goal in this flow | — | N/A |
| ASI02 | Tool Misuse | YES (indirect) | `cosign` CLI misuse — e.g., signing a file that should not be signed | Workflow file SHA-pinned (REQ-B8 pattern applied to release-sign.yml); cosign version pinned in CI and recorded in `signed_with_version` per entry (REQ-E7) | spec'd |
| ASI03 | Identity and Privilege Abuse | YES | CI runner could request OIDC tokens for non-release purposes | Workflow `on:` trigger scoped to release-tag refs only; non-release branches cannot trigger signing | spec'd |
| ASI04 | Indirect Prompt Injection | N/A | No external content enters this flow | — | N/A |
| ASI05 | Memory Poisoning | N/A | No memory layer involvement | — | N/A |
| ASI06 | Inter-agent Communication Attacks | N/A | Single-CI workflow | — | N/A |
| ASI07 | Resource Exhaustion | YES | Tag-spam attack could trigger many signing runs | GitHub branch protection + tag protection limit who can push tags; signing budget bounded by workflow concurrency limits | spec'd |
| ASI08 | Recursive Hijacking | N/A | Linear CI flow with no reasoning chain | — | N/A |
| ASI09 | Human-Agent Trust Exploitation | N/A | Signing flow is fully automated; no human-agent dialogue in the loop | — | N/A |
| ASI10 | Rogue Agents | YES | A compromised CI workflow could sign malicious skills under a legitimate identity | Rekor public log makes any signing event detectable post-hoc; manifest commits are visible in `git log` and PR review (REQ-E3 implies manifest is committed back, so the diff is visible) | spec'd |

---

## OWASP Agentic Skill Threats (AST) 2026

> AST coverage extends per-file beyond the universal `STRIDE_ASI_TEMPLATE.md` (which does not include AST). Spec E directly targets supply-chain threats, so the AST table is required here.

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| AST02 | Skill poisoning at registry level | YES | Attacker pushes a malicious `SKILL.md` modification or replaces a skill with a poisoned variant (e.g., the historical ClawHub-class incident) | Signing + manifest hash-pinning; verifier (area F) catches mismatch. Rekor log makes any signing event auditable independent of the repo. | spec'd |
| AST04 | Skill metadata manipulation | YES | Manifest entries (hash, identity, log_index) tampered post-sign to point at a different skill content | Manifest itself is committed by the CI identity and visible in `git log`; tampering shows in PR diff. The hash field is the canonical truth — verifier (area F) NEVER trusts a skill whose hash is absent from manifest, even if a `.sig` is present (defense-in-depth) | spec'd |
| AST08 | Skill update tampering | YES | Malicious update slipped in without re-signing (or signed by a different identity) | Every update must produce a new signature; the old hash invalidates verification; Rekor log makes any gap auditable (a missing inclusion proof for an updated skill is a red flag) | spec'd |

---

## Open issues

> Block merge until resolved (where applicable).

1. **Trust-bundle refresh schedule** — Sigstore root rotation is rare (multi-year cadence) but must be handled operationally. Defer to v0.1.x polish as a `docs/SIGSTORE_OPS.md` runbook; **not blocking** Phase 2 implementation.
2. **Post-install revocation** — addressed in area F's threat model (the *consumer* side), not duplicated here. E produces the signatures; F handles consumption + lifetime + revocation gap.

---

## Sign-off

- [ ] Engineer: miltonadina — pending
- [ ] Security reviewer: miltonadina — pending
- [ ] Red-team scan (`deepteam OWASP_ASI_2026()`): pending — signing flow does not expose an agent surface, so most ASI probes are N/A by construction; the AST-class threats here are the real coverage
