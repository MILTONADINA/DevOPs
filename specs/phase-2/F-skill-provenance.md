# Phase 2 / Area F — Skill Provenance Verification at Install

**Spec ID**: phase-2/F-skill-provenance
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

Area E (Sigstore signing) produces the signatures. This spec (F) consumes them: when `analyzer/install.ts` copies skills into a target project, every skill's signature is verified before the file lands on disk, and unsigned skills are rejected unless the installer is explicitly invoked with `--allow-unsigned` and a stated rationale that is then logged into `.workflow/state/install.log`. Together E and F close the AST10 supply-chain gap end-to-end.

This is the change Prompt 1's GAP_61_COVERAGE_MATRIX item #60 anticipates and what `constitution/ANTIPATTERNS.md` AP-11 (Skill Supply-Chain Trust) makes constitutional. Phase 1 shipped the installer at `analyzer/install.ts` *without* verification; Phase 2 adds the verification step.

## Out of scope

- The signing flow itself — that is **area E**.
- New CLI subcommands beyond what the installer already exposes; this spec only extends `analyzer/install.ts`.
- Third-party skill marketplace browsing UI — out of scope.
- Per-project trust-policy overrides (e.g., "trust this signer for this project only") — deferred to v0.2.x.

## Actors and data

- **Primary actors**: `analyzer/install.ts` (installer), the user invoking installation.
- **Data classes touched**: skill source files (no PII), `.workflow/state/install.log` (operator state, gitignored).
- **Compliance scope**: [x] none.

---

## Functional requirements (EARS)

### REQ-F1 (Ubiquitous) — Installer verifies every skill before copy
THE SYSTEM SHALL ensure `analyzer/install.ts` invokes `cosign verify-blob` (or equivalent Sigstore verifier) against every skill in the source directory before copying it to the target project's `.claude/skills/` (or equivalent) directory.

### REQ-F2 (Unwanted behaviour) — Unsigned skill rejected by default
IF a skill in the source directory has no corresponding `.sig` file or has an invalid signature, THEN THE SYSTEM SHALL refuse to copy that skill, emit an error message naming the skill, and exit with status 2 (distinct from generic-error 1).

### REQ-F3 (Optional feature) — Unsigned override with rationale
WHERE the installer is invoked with both `--allow-unsigned` AND `--rationale="<non-empty string>"`, THE SYSTEM SHALL proceed past unsigned skills *but* append a structured log entry to `.workflow/state/install.log` containing the timestamp, skill path, and rationale string.

### REQ-F4 (Unwanted behaviour) — `--allow-unsigned` without rationale is rejected
IF `--allow-unsigned` is provided without `--rationale="..."` (or with an empty rationale), THEN THE SYSTEM SHALL exit non-zero with a message instructing the operator to supply a rationale.

### REQ-F5 (Ubiquitous) — Verification decisions logged
THE SYSTEM SHALL log every verification decision (pass / fail / overridden) to `.workflow/state/install.log` with: `timestamp`, `skill_path`, `decision`, `sha256`, `signed_by` (when present), and `rationale` (when overridden).

### REQ-F6 (Optional feature) — Dry-run mode
WHERE the installer is invoked with `--dry-run`, THE SYSTEM SHALL perform all verification checks AND print what would be copied, BUT MUST NOT modify the target directory.

### REQ-F7 (Optional feature) — Alternate manifest
WHERE the installer is invoked with `--manifest <path>`, THE SYSTEM SHALL load the named manifest instead of the default `governance/skill-manifest.yml` (for testing and per-project trust overrides).

---

## Acceptance criteria

### AC-F1.1 (maps to REQ-F1)
**Given** a source skills directory with a properly signed `process/karpathy-guidelines/SKILL.md`
**When** `node analyzer/install.ts --target ./fixture-project` runs
**Then** the installer's verbose output includes `verified: skills/universal/process/karpathy-guidelines/SKILL.md` and the file appears in `./fixture-project/.claude/skills/`.

### AC-F2.1 (maps to REQ-F2)
**Given** a source skills directory where `process/karpathy-guidelines/SKILL.md.sig` has been deleted
**When** `node analyzer/install.ts --target ./fixture-project` runs (without `--allow-unsigned`)
**Then** the installer exits with status 2, prints `unsigned: skills/universal/process/karpathy-guidelines/SKILL.md`, and does NOT copy that skill.

### AC-F3.1 (maps to REQ-F3)
**Given** the same setup as AC-F2.1
**When** `node analyzer/install.ts --target ./fixture-project --allow-unsigned --rationale="Local-dev override; signer DNS misconfigured 2026-05-22"` runs
**Then** the skill is copied AND `.workflow/state/install.log` gains a line containing `decision=overridden`, the rationale string, and the skill path.

### AC-F4.1 (maps to REQ-F4)
**Given** `node analyzer/install.ts --target ./fixture-project --allow-unsigned` (no `--rationale`)
**When** the installer parses CLI args
**Then** it exits non-zero with a message including `--rationale="..." is required when --allow-unsigned is used`.

### AC-F5.1 (maps to REQ-F5)
**Given** any installer invocation
**When** `.workflow/state/install.log` is inspected after the run
**Then** there is one log entry per skill processed, each containing every field listed in REQ-F5.

### AC-F6.1 (maps to REQ-F6)
**Given** an installer invocation with `--dry-run`
**When** the run completes
**Then** stdout reports `dry-run: would copy N skills` and the target directory's contents are unchanged.

### AC-F7.1 (maps to REQ-F7)
**Given** an alternate manifest at `./tests/manifests/dev.yml`
**When** `node analyzer/install.ts --manifest ./tests/manifests/dev.yml --target ./fixture-project` runs
**Then** verification uses the entries from that manifest, not the default.

---

## Non-functional requirements

### NFR-F1 — Performance
- Verification overhead per skill: ≤ 200 ms (using the cached trust bundle from REQ-E5).
- Full-repo install (19+ skills): ≤ 8 seconds total, p95.

### NFR-F2 — Observability
- `.workflow/state/install.log` lines are valid JSONL (one JSON object per line).
- A summary line is printed to stdout at the end of every install invocation: `installed=N verified=N overridden=M skipped=K`.

### NFR-F3 — Security
- Threat model: `docs/threat-models/phase-2/F-skill-provenance.md` (Step 2).
- The installer NEVER trusts a skill whose hash is absent from `governance/skill-manifest.yml`, even if a `.sig` is present (defense-in-depth against signature replay).
- `--allow-unsigned --rationale="..."` does NOT bypass the hash check; it only bypasses the signature-existence check.

### NFR-F4 — Compliance
- Install log lines do not contain PII.
- The rationale string is operator-supplied free text; the installer SHALL log it verbatim but is not responsible for its content (the operator owns what they type).

### NFR-F5 — Surgical scope
- Existing `analyzer/install.ts` API surface (target path, copy semantics) is preserved; verification is *added*, not refactored.

---

## Threat model

See `docs/threat-models/phase-2/F-skill-provenance.md` (Step 2). Anticipated primary risks:

- **AST01 (Untrusted skill registries)** — direct target: the installer is the gate.
- **AST02 (Skill poisoning at registry)** — defended by E + F together.
- **AST03 (Skill name typosquatting)** — partially mitigated: the manifest's `path` field is canonical, so a typo'd name has no manifest entry and is rejected by REQ-F1.
- **ASI03 (Identity & Privilege Abuse)** — overrides are operator-tagged via the rationale, creating accountability.

---

## Decisions

- **Exit status 2 for unsigned-rejection.** Distinct from generic-error 1 so CI can detect "policy rejection" vs "tool failure" without parsing error strings.
- **Rationale is mandatory, non-empty.** Operators who legitimately override should articulate why; rubber-stamp overrides are exactly the AP-11 failure mode this spec defends against.
- **`--manifest` flag for alternate manifests.** Enables testing without touching the default; also opens the door to per-project trust profiles in v0.2.x without API redesign.
- **`.workflow/state/install.log` is JSONL, not freeform text.** Greppable and consumable by future telemetry skills without parsing complexity.

---

## Open questions

None blocking. If during implementation a skill needs verification against multiple identities (e.g., maintainer rotated, both old + new keys are valid for a window), the manifest schema can accommodate a `valid_identities: [...]` array; the spec doesn't preclude that.

---

## Implementation plan

Step 3 atomization will likely produce: (1) extend `analyzer/install.ts` with verification call sites and CLI parsing for the new flags; (2) author the install-log JSONL writer; (3) author fixtures for AC-F1 through AC-F7 (a fixture skill source dir with one signed and one unsigned skill); (4) integration test that invokes the installer with each flag combination; (5) update `docs/SKILL_SIGNING.md` with the install-verification flow.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-F1 | AC-F1.1 | (Phase 2 implementation) |
| REQ-F2 | AC-F2.1 | (Phase 2 implementation) |
| REQ-F3 | AC-F3.1 | (Phase 2 implementation) |
| REQ-F4 | AC-F4.1 | (Phase 2 implementation) |
| REQ-F5 | AC-F5.1 | (Phase 2 implementation) |
| REQ-F6 | AC-F6.1 | (Phase 2 implementation) |
| REQ-F7 | AC-F7.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-022`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area F).
