# Phase 2 / Area E — Sigstore / Cosign Skill Signing

**Spec ID**: phase-2/E-sigstore-signing
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

OWASP AST02 (Skill poisoning at registry level) and AST08 (Skill update tampering) require a cryptographic provenance chain on every skill DevOPs ships. Phase 1 documented the intent in `governance/owasp-asi-2026/threats.md` AST10 section and `constitution/ANTIPATTERNS.md` AP-11 (Skill Supply-Chain Trust). Phase 2 area E delivers the *signing* side: every skill under `skills/universal/` gets a Sigstore signature, hash-pinned skill versions are recorded in `governance/skill-manifest.yml`, and a CI workflow signs new skills on release tags. Area F covers the *verification* side at install time.

Sigstore is chosen over GPG-style key infrastructure because the keyless OIDC flow eliminates long-lived key custody and produces a public, immutable transparency-log entry (Rekor) that anyone can audit.

## Out of scope

- Install-time verification — that is **area F**.
- Signing of Phase 1 commit history retroactively. The signatures cover skill content, not git history.
- Third-party skill registry / marketplace — that is post-v1.0 work.
- Stack-specific skills authored in **area D** — the signing flow defined here applies to them too once they ship, but their authoring is D's concern.

## Actors and data

- **Primary actors**: CI workflow runner (signs on release), `analyzer/install.ts` (consumes signatures in area F), Rekor transparency log (public).
- **Data classes touched**: skill source files (no PII). Sigstore OIDC tokens used in the signing flow are short-lived and never persisted.
- **Compliance scope**: [x] none for the signatures themselves.

---

## Functional requirements (EARS)

### REQ-E1 (Ubiquitous) — Every universal skill has a Sigstore signature
THE SYSTEM SHALL ensure every `skills/universal/**/SKILL.md` file has a corresponding `SKILL.md.sig` Sigstore signature file alongside it in the same directory.

### REQ-E2 (Ubiquitous) — Skill manifest with hash pinning
THE SYSTEM SHALL maintain a manifest at `governance/skill-manifest.yml` listing every skill with: `name`, `path`, `sha256` (of `SKILL.md`), `sig_path`, `signed_by` (Sigstore identity), `signed_at` (ISO 8601), and `rekor_log_index`.

### REQ-E3 (Event-driven) — CI signs on release tag
WHEN a release tag matching `v\d+\.\d+\.\d+` is pushed to `main`, THE SYSTEM SHALL run a signing workflow that produces `.sig` files for every skill changed in the release and updates `governance/skill-manifest.yml`.

### REQ-E4 (Ubiquitous) — Trust model documented
THE SYSTEM SHALL document the trust model at `docs/SKILL_SIGNING.md` covering: (i) why Sigstore over GPG, (ii) the OIDC identity used for signing, (iii) how to verify a signature manually, (iv) what to do when verification fails, and (v) the rotation policy for the signing identity.

### REQ-E5 (Ubiquitous) — Offline verifiability
THE SYSTEM SHALL ensure each signature is verifiable offline using a cached copy of the Sigstore root-of-trust bundle stored at `.workflow/sigstore/trust-bundle.json` (refreshed periodically; not gated on internet access for verification).

### REQ-E6 (Unwanted behaviour) — Tampered skill detected
IF a `SKILL.md` file is modified without re-signing, THEN THE SYSTEM SHALL cause `cosign verify-blob` (or equivalent) against that file to exit non-zero, and any verifier consuming the manifest SHALL refuse to install the skill.

### REQ-E7 (Ubiquitous) — Reproducible signing
THE SYSTEM SHALL produce identical signatures for identical inputs (modulo Sigstore's per-signing-event randomness inherent to ECDSA) by pinning the cosign version in the CI workflow and recording it in the manifest's `signed_with_version` field.

---

## Acceptance criteria

### AC-E1.1 (maps to REQ-E1)
**Given** the post-implementation repository
**When** `git ls-files 'skills/universal/**/SKILL.md.sig'` is executed
**Then** the count equals the count of `git ls-files 'skills/universal/**/SKILL.md'`.

### AC-E2.1 (maps to REQ-E2)
**Given** the post-implementation `governance/skill-manifest.yml`
**When** the file is parsed
**Then** every key listed in REQ-E2 is present and non-empty for every skill entry.

### AC-E3.1 (maps to REQ-E3)
**Given** a release tag `v0.2.0` pushed to `main`
**When** the GitHub Actions workflow `release-sign.yml` runs
**Then** the workflow produces `.sig` updates for any changed skills and commits an updated `governance/skill-manifest.yml`.

### AC-E4.1 (maps to REQ-E4)
**Given** the post-implementation `docs/SKILL_SIGNING.md`
**When** the file is read
**Then** H2 sections titled `Why Sigstore`, `Signing identity`, `Verify manually`, `What to do on failure`, and `Rotation policy` are present.

### AC-E5.1 (maps to REQ-E5)
**Given** the trust bundle at `.workflow/sigstore/trust-bundle.json` exists and the network is disconnected
**When** `cosign verify-blob --bundle-path .workflow/sigstore/trust-bundle.json` runs against a signed skill
**Then** verification succeeds with exit 0.

### AC-E6.1 (maps to REQ-E6)
**Given** a signed skill whose `SKILL.md` is then modified by appending one character
**When** `cosign verify-blob` runs against the modified file
**Then** verification fails with exit non-zero and the error message names the file.

### AC-E7.1 (maps to REQ-E7)
**Given** `governance/skill-manifest.yml`
**When** the `signed_with_version` field is inspected for every entry signed by the same CI run
**Then** the version is identical across those entries and matches the version pinned in `release-sign.yml`.

---

## Non-functional requirements

### NFR-E1 — Performance
- Per-skill signing overhead: ≤ 3 seconds (cosign-keyless typical).
- Full-repo re-signing in CI: ≤ 90 seconds for 19+ skills.

### NFR-E2 — Observability
- Each signing event is logged to `governance/telemetry/signing-events.jsonl` with `skill_path`, `sha256`, `rekor_index`, and `signed_at`.

### NFR-E3 — Security
- Threat model: `docs/threat-models/phase-2/E-sigstore-signing.md` (Step 2).
- The Sigstore OIDC identity is the GitHub Actions workflow's ambient identity — no long-lived signing keys.
- The trust bundle is itself verifiable; manual rotation procedure documented.

### NFR-E4 — Compliance
- No PII in signatures or manifest entries.
- The Rekor transparency log entry is public by design.

---

## Threat model

See `docs/threat-models/phase-2/E-sigstore-signing.md` (Step 2). Anticipated primary risks:

- **AST02 (Skill poisoning at registry)** — direct target of this spec.
- **AST08 (Skill update tampering)** — direct target.
- **AST04 (Skill metadata manipulation)** — partially addressed: the manifest entries are hash-pinned, but if an attacker compromises CI they could insert malicious entries. Mitigated by the public Rekor log creating an auditable trail.

---

## Decisions

- **Sigstore over GPG.** Keyless OIDC removes the key-custody attack surface; transparency log creates public auditability.
- **Manifest in YAML, not JSON.** Matches the existing `governance/skill-evals/registry.yml` style.
- **Cosign version pinned, not floating.** AST08 risk: a malicious cosign upgrade could subvert signing. Version pin is enforced in CI and recorded per-entry in the manifest.

---

## Open questions

None blocking. The exact Sigstore CLI is `cosign` v2.x; if the upstream landscape shifts to `slsa-verifier` or similar by implementation time, the spec accommodates substitution (REQ-E1 names the *property* — a verifiable signature — not the exact tool).

---

## Implementation plan

Step 3 atomization will likely produce: (1) author `docs/SKILL_SIGNING.md`; (2) write CI workflow `.github/workflows/release-sign.yml`; (3) author initial `governance/skill-manifest.yml` with current 19 skills' hashes (will fully populate signatures on the first release); (4) write trust-bundle cache + refresh tooling; (5) author the modified-skill detection test fixture for AC-E6.1.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-E1 | AC-E1.1 | (Phase 2 implementation) |
| REQ-E2 | AC-E2.1 | (Phase 2 implementation) |
| REQ-E3 | AC-E3.1 | (Phase 2 implementation) |
| REQ-E4 | AC-E4.1 | (Phase 2 implementation) |
| REQ-E5 | AC-E5.1 | (Phase 2 implementation) |
| REQ-E6 | AC-E6.1 | (Phase 2 implementation) |
| REQ-E7 | AC-E7.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-021`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area E).
