# Phase 2 / Area D — Stack-Specific Security Skills

**Spec ID**: phase-2/D-stack-specific-skills
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

Phase 1 shipped 19 universal `SKILL.md` files under `skills/universal/` (process, development, security, devops, compliance). The repository's `skills/stack-specific/` directory was reserved but left empty. Phase 2 fills it with nine targeted security skills covering the four highest-traffic stacks the analyzer detects (Next.js, Stripe, FastAPI, Supabase, Rust). Each skill teaches a small set of stack-specific anti-patterns and the safe alternative, and is recommended by `analyzer/scan.ts` when the relevant stack indicator is detected.

The nine skills, as enumerated in Prompt 3 area D:

- `skills/stack-specific/nextjs/server-action-safety/SKILL.md`
- `skills/stack-specific/nextjs/check-route-types/SKILL.md`
- `skills/stack-specific/stripe/webhook-idempotency/SKILL.md`
- `skills/stack-specific/stripe/pci-scope-minimization/SKILL.md`
- `skills/stack-specific/fastapi/dependency-injection/SKILL.md`
- `skills/stack-specific/supabase/rls-policies/SKILL.md`
- `skills/stack-specific/supabase/rpc-functions/SKILL.md`
- `skills/stack-specific/rust/error-handling/SKILL.md`
- `skills/stack-specific/rust/cargo-audit/SKILL.md`

## Out of scope

- Universal `skills/universal/security/webhook-idempotency/` — that is **area G** (generic across providers).
- Updating the `AGENTS.md` "Skills catalog" bullet list to mention the new skills — that's PB-4 / issue #2, **v0.1.0 polish work on `main`**, NOT Phase 2.
- Skill signatures — those are areas **E** and **F**.
- Adding new stack detectors to `analyzer/scan.ts` (Vue, Svelte, Go, Java, etc.) — out of scope.
- Implementation of any individual skill's recommendations as runtime checks; this is teaching content, not enforcement.

## Actors and data

- **Primary actors**: coder, security, and reviewer subagents (each invoking the relevant skill when working in the matching stack).
- **Data classes touched**: indirectly — Stripe touches PCI, Supabase RLS touches PII, FastAPI DI may touch auth tokens.
- **Compliance scope**: indirect; skill content references PCI DSS (Stripe) and standard authz patterns where applicable.

---

## Functional requirements (EARS)

### REQ-D1 (Ubiquitous) — All nine SKILL.md files exist
THE SYSTEM SHALL contain a `SKILL.md` file at each of the nine documented paths.

### REQ-D2 (Ubiquitous) — Each SKILL.md has valid frontmatter
THE SYSTEM SHALL ensure every stack-specific `SKILL.md` declares YAML frontmatter with non-empty `name` and `description` fields, matching the format used by the universal skills.

### REQ-D3 (Ubiquitous) — Each skill teaches at least three patterns or anti-patterns
THE SYSTEM SHALL ensure each stack-specific skill's body documents at least three distinct patterns or anti-patterns in its target stack's security domain (e.g., the Stripe webhook-idempotency skill names at least three idempotency failure modes and their fixes).

### REQ-D4 (Event-driven) — Analyzer recommends each skill when stack is detected
WHEN `analyzer/scan.ts` detects a stack indicator (`next.js` framework, `stripe` package, `fastapi` framework, `@supabase/supabase-js` package, `Cargo.toml` present), THE SYSTEM SHALL include the corresponding stack-specific skills in the emitted `recommended.skills` array in `.workflow/profile.yml`.

### REQ-D5 (Ubiquitous) — Tradeoff statement present
THE SYSTEM SHALL ensure every stack-specific skill contains an explicit "Tradeoff:" or "Why this matters:" section acknowledging when the patterns DO and DO NOT apply.

### REQ-D6 (Ubiquitous) — Worked code example
THE SYSTEM SHALL ensure every stack-specific skill includes at least one fenced code example in the stack's native language (TypeScript/JS for Next.js & Stripe-JS; Python for FastAPI; SQL or JS for Supabase; Rust for Rust skills).

### REQ-D7 (Optional feature) — ASI/AST threat reference (MAY, with explicit opt-out)
THE SYSTEM MAY ensure every stack-specific skill references at least one OWASP ASI 2026 or AST10 identifier from `governance/owasp-asi-2026/threats.md` that the skill materially mitigates. WHERE no canonical identifier materially applies (for example, language-runtime hygiene with no agent-specific threat path), the skill SHALL include an explicit line `No canonical ASI/AST applies — <one-line reason>` instead of a decorative reference. Any `ASI\d{2}` or `AST\d{2}` identifier present in the skill SHALL exist in the canonical set declared in `governance/owasp-asi-2026/threats.md` (ASI01–ASI10, AST01–AST10).

---

## Acceptance criteria

### AC-D1.1 (maps to REQ-D1)
**Given** the post-implementation repository
**When** `Test-Path` is run against each of the nine documented `SKILL.md` paths
**Then** all nine return true.

### AC-D2.1 (maps to REQ-D2)
**Given** the nine stack-specific `SKILL.md` files
**When** the YAML frontmatter of each is parsed (same logic as REQ-7 of `phase-1-validation.md`)
**Then** each contains non-empty `name` and `description` fields.

### AC-D3.1 (maps to REQ-D3)
**Given** any stack-specific `SKILL.md`
**When** the body is inspected
**Then** at least three distinct H3 sections appear under "Anti-patterns", "Patterns", or "Rules" — or equivalent numbered list with three entries.

### AC-D4.1 (maps to REQ-D4)
**Given** an analyzer fixture project whose `package.json` declares `next` as a dependency
**When** `node analyzer/scan.ts` runs against it
**Then** the emitted `.workflow/profile.yml` `recommended.skills` array includes `stack-specific/nextjs/server-action-safety` and `stack-specific/nextjs/check-route-types`.

### AC-D5.1 (maps to REQ-D5)
**Given** any stack-specific `SKILL.md`
**When** the file content is scanned
**Then** at least one occurrence of `Tradeoff:` or `Why this matters:` appears in the body.

### AC-D6.1 (maps to REQ-D6)
**Given** any stack-specific `SKILL.md`
**When** the file is scanned for fenced code blocks
**Then** at least one fenced block opens with the relevant language tag (e.g., ` ```ts `, ` ```python `, ` ```sql `, ` ```rust `).

### AC-D7.1 (maps to REQ-D7)
**Given** any stack-specific `SKILL.md`
**When** the file is scanned for `ASI\d{2}` or `AST\d{2}` identifiers
**Then** EITHER (a) at least one match is found AND every match references a canonical identifier from `governance/owasp-asi-2026/threats.md` (the set ASI01–ASI10, AST01–AST10), OR (b) no match is found AND the file contains the literal phrase `No canonical ASI/AST applies` followed by a reason.

---

## Non-functional requirements

### NFR-D1 — Reproducibility
- Each skill's worked example is deterministic and runs in isolation (no network calls in the example code).
- The analyzer's recommendation logic is unit-testable via fixture projects.

### NFR-D2 — Observability
- When a skill is invoked, the subagent emits an OTel span attribute `skill.id` so per-skill usage is queryable in Langfuse.

### NFR-D3 — Security
- Threat model: this area does not add new attack surface — it adds *teaching content*. No standalone threat model required per Prompt 3 (which marks A, B, C, E, F for threat models, not D).

### NFR-D4 — Compliance
- The Stripe `pci-scope-minimization` skill references the relevant PCI DSS sections; the Supabase `rls-policies` skill references GDPR/SOC 2 patterns where authz overlaps.

### NFR-D5 — Surgical scope
- Each `SKILL.md` is added in its existing directory; no other repo files are touched (modulo `analyzer/recommendation-rules.yml` for REQ-D4).

---

## Threat model

Not authored as a standalone artifact (per Prompt 3, threat models cover A, B, C, E, F). The skills *reference* threats they mitigate (REQ-D7); the per-area threat models for A, B, C, E, F cover the broader attack surface.

---

## Decisions

- **Five stacks, nine skills.** Each stack gets the highest-leverage security skills first. Vue/Svelte/Go/Java/etc. are deferred until the analyzer detects them in a real project profile.
- **`AGENTS.md` skills catalog update is NOT in this spec.** That edit is v0.1.0 polish (issue #2, PB-4) and lives on `main`. Phase 2 commits only land on `phase-2-security-depth`.
- **Skill content authored by the validator/security subagents during Step 4.** This Step 1 spec scopes WHAT exists; Step 4 sessions write each individual skill's body. Skill `SKILL.md` files are not authored here.
- **No skill signatures yet.** Signatures land in **area E**. New stack-specific skills will be signed there alongside the existing universal skills.

---

## Open questions

None blocking. If during Step 4 a skill's anti-pattern list naturally exceeds the "at least 3" floor, the spec accommodates that — the floor is a minimum, not a target.

---

## Implementation plan

Step 3 atomization will likely produce: (1) author each of the 9 SKILL.md files (~30-60 minutes each); (2) extend `analyzer/recommendation-rules.yml` with stack-specific skill recommendations; (3) write fixture-project tests for AC-D4.1 (one fixture per stack); (4) automated lint script that validates AC-D2 through AC-D7 across all stack-specific skills.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-D1 | AC-D1.1 | (Phase 2 implementation) |
| REQ-D2 | AC-D2.1 | (Phase 2 implementation) |
| REQ-D3 | AC-D3.1 | (Phase 2 implementation) |
| REQ-D4 | AC-D4.1 | (Phase 2 implementation) |
| REQ-D5 | AC-D5.1 | (Phase 2 implementation) |
| REQ-D6 | AC-D6.1 | (Phase 2 implementation) |
| REQ-D7 | AC-D7.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-020`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area D).
- 2026-05-23 miltonadina: revised REQ-D7 (Ubiquitous SHALL → Optional MAY, with explicit `No canonical ASI/AST applies` opt-out path; any present identifier MUST be from the canonical set) and AC-D7.1 (either-or branch — match-found-and-canonical, OR no-match-with-explicit-note). Step 3 reviewer feedback after audit found D.02 and D.09 citing non-canonical ASI identifiers; the spec is updated so honest "no agentic threat applies" is permitted instead of forcing decorative references.
