# Threat Model — Phase 2 Area F — Skill Provenance Verification at Install

**Spec**: `specs/phase-2/F-skill-provenance.md`
**Date**: 2026-05-22
**Author**: miltonadina (Claude Code, Opus 4.7)
**Reviewer**: miltonadina
**Status**: draft

---

## System sketch

```
skill source (universal source dir, marketplace, or local clone)
    │
    ▼ analyzer/install.ts invocation [REQ-F1]
    │   ├─ load governance/skill-manifest.yml (or --manifest <path>)
    │   ├─ for each candidate skill:
    │   │   ├─ check SHA256 against manifest entry            ← hash gate
    │   │   ├─ run `cosign verify-blob` (offline trust bundle) ← signature gate
    │   │   └─ both must pass OR the skill is rejected (exit 2)
    │   └─ writes structured log entry to .workflow/state/install.log [REQ-F5]
    │
    ▼ override path (REQ-F3, F4):
    │   `--allow-unsigned --rationale="<non-empty>"`
    │   ├─ signature gate is bypassed
    │   ├─ hash gate STILL enforced (NFR-F3 defense-in-depth)
    │   └─ rationale logged verbatim with timestamp + identity
    │
    target project's .claude/skills/ (or equivalent)
        receives signed-or-explicitly-overridden skills only
```

The installer is the gate. If a skill cannot be verified AND no rationale-backed override is supplied, the skill never lands on disk.

## Trust boundaries

1. **Skill source → installer** [TRUST BOUNDARY] — every candidate skill is verified or rejected at copy time.
2. **Installer → target skills dir** [TRUST BOUNDARY] — write occurs only after verification pass (or explicit `--allow-unsigned --rationale`).
3. **Manifest → installer** [TRUST BOUNDARY] — `governance/skill-manifest.yml` is the source of truth for hash and signature identity; an absent manifest entry means "untrusted" regardless of any `.sig` file (defense-in-depth against signature replay, per NFR-F3).
4. **Operator → CLI flags** [TRUST BOUNDARY] — `--allow-unsigned --rationale="..."` is the *only* recognised override path. Rationale is mandatory (REQ-F4) and non-empty.
5. **Install log → audit trail** [TRUST BOUNDARY] — `.workflow/state/install.log` is JSONL, grep-able for incident response.

## Data classes

| Class | Where stored | Where transmitted | Retention |
|-------|--------------|-------------------|-----------|
| Skill source | repo + target installs | local | indefinite |
| Manifest entries | `governance/skill-manifest.yml` | per release | indefinite |
| Install log | `.workflow/state/install.log` (gitignored) | local | session+ |
| Rationale strings | install.log | telemetry export (PII-redacted, per NFR-F4) | session+ |
| Trust bundle | `.workflow/sigstore/` | local-only | refreshed periodically (E's concern) |

---

## STRIDE analysis

| Threat | Description | Mitigation | Status |
|--------|-------------|------------|--------|
| **Spoofing** | Attacker provides a skill with a forged signature | `cosign verify-blob` against keyless OIDC identity + manifest hash check (defense-in-depth: hash must match even if signature is replayed from an unrelated skill) | spec'd |
| **Tampering** | Skill modified between sign-time and install-time | Hash gate catches modification; signature gate catches identity substitution | spec'd |
| **Repudiation** | Who installed an unsigned skill on this machine? | install.log records `timestamp`, `identity` (from `git config user.email`), `decision`, `sha256`, `signed_by` (when present), and `rationale` (when overridden) | spec'd |
| **Information disclosure** | Rationale strings may contain operator notes (potentially sensitive) | PII-redaction at telemetry export; install.log is gitignored; rationale is operator-supplied free-text, not censored by the installer | spec'd |
| **Denial of service** | Malformed manifest causes installer to hang | Schema validation + per-skill verification timeout; full-install timeout | spec'd |
| **Elevation of privilege** | Installer running with elevated privileges installs untrusted skill | Installer runs in the user's context only (no root invocation); target dir is user-writable; no privileged operation required | spec'd |

---

## OWASP Top 10 for Agentic Applications (ASI) 2026

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| ASI01 | Agent Goal Hijacking | YES (indirect) | A poisoned skill could redirect any agent that loads it post-install | Installer rejects unsigned / tampered skills; `--allow-unsigned` requires explicit operator rationale | spec'd |
| ASI02 | Tool Misuse | YES | A malicious skill could expose or invoke unsafe tools once loaded | Provenance verification ensures the skill *content* matches the signed reference; content review remains a separate concern (covered by skill-eval and red-team flows, areas B + governance/skill-evals) | spec'd |
| ASI03 | Identity and Privilege Abuse | YES | Installer running with elevated privileges to install in protected dirs | Installer runs in user-context only; no `sudo` / privileged invocation required | spec'd |
| ASI04 | Indirect Prompt Injection | N/A | Installer does not ingest external content during verification | — | N/A |
| ASI05 | Memory Poisoning | N/A | Installer does not touch the memory layer | — | N/A |
| ASI06 | Inter-agent Communication Attacks | N/A | Single-installer flow | — | N/A |
| ASI07 | Resource Exhaustion | YES | A manifest with thousands of skill entries could DoS the install | Per-skill verification timeout; full-install wall-clock timeout (NFR-F1: ≤ 8 s p95 for 19+ skills) | spec'd |
| ASI08 | Recursive Hijacking | N/A | Linear install flow with no reasoning chain | — | N/A |
| ASI09 | Human-Agent Trust Exploitation | YES | Operator socially-engineered into using `--allow-unsigned` carelessly | Mandatory rationale (REQ-F4) + audit-logged CLI subcommand provides accountability *even when* the override is exercised. The operator must articulate WHY in writing; the rationale is recoverable for incident response. | spec'd |
| ASI10 | Rogue Agents | YES — **POST-INSTALL REVOCATION GAP** | A skill that was validly signed at install time could later be revoked (signing identity compromised, skill author goes rogue, vulnerability discovered). Currently no mechanism within Phase 2 scope flags already-installed skills as suspect when revocation occurs after the install moment. | **DEFERRED TO PHASE 3 (memory & observability).** Phase 3 will introduce a periodic re-validation mechanism that consults Rekor for revoked entries against installed skills; observability layer will surface "skill installed but later revoked" as a structured event. No fabricated Phase 2 control is claimed for this threat — see Open issues #1. | **open (DEFERRED — Phase 3)** |

---

## OWASP Agentic Skill Threats (AST) 2026

> AST coverage extends per-file beyond the universal `STRIDE_ASI_TEMPLATE.md`. Spec F directly targets supply-chain threats at the install boundary, so the AST table is required here.

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| AST01 | Untrusted skill registries | YES — direct target | The installer is the gate against skills sourced from untrusted registries or marketplace | Signed-only-by-default (REQ-F1, F2); `--allow-unsigned` requires non-empty rationale (REQ-F4) with operator identity recorded | spec'd |
| AST02 | Skill poisoning at registry level | YES (defended jointly with E) | Adversary poisons a skill at the source registry | E produces the signatures; F refuses to install a skill whose hash does not match the signed manifest entry | spec'd |
| AST03 | Skill name typosquatting | YES — partially mitigated | An adversary registers `karpathy-guidelinez` (typo) hoping for an accidental install | The manifest's `path` field is canonical; a typo'd skill name has NO matching manifest entry and is rejected by REQ-F1. (Full mitigation also requires registry-side namespace policies, which are out of scope for this spec.) | spec'd (partial; registry-policy out of scope) |

---

## Open issues

> Block merge until resolved (where applicable; **DEFERRED** items do NOT block Phase 2 implementation).

1. **Post-install revocation gap** — if the signing identity is compromised AFTER a skill is installed, there is currently no mechanism (within Phase 2 scope) to flag the already-installed skill as suspect. The installer's REQ-F1 verification fires *at install time only*. **MITIGATION: deferred to Phase 3 (memory & observability)**. Phase 3 will introduce: (a) a periodic re-validation skill that consults Rekor for revocations against installed skills, (b) an observability event class `skill.revoked_after_install` surfacing the condition to the operator. No fabricated Phase 2 control is claimed for this threat — coverage theater is worse than an acknowledged gap. **This open item does NOT block Phase 2 implementation.**

---

## Sign-off

- [ ] Engineer: miltonadina — pending
- [ ] Security reviewer: miltonadina — pending
- [ ] Red-team scan (`deepteam OWASP_ASI_2026()`): pending — the install flow is not the agent surface, so ASI probes mostly target ASI09 (operator override path) and ASI10 (post-install revocation); the AST-class threats are the real coverage
