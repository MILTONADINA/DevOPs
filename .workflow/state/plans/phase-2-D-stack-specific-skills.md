# Phase 2 / Area D — Stack-Specific Security Skills — Implementation Plan

**Plan ID**: phase-2-D-plan
**Spec**: specs/phase-2/D-stack-specific-skills.md
**Threat model**: N/A — teaching content, no new attack surface (per Prompt 3; skills reference threats they mitigate via REQ-D7, but D itself does not introduce attack surface)
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- **AC-D4.1 fixture broadening** (Step 1 reviewer feedback): the spec's AC-D4.1 names only the Next.js stack. The reviewer's "either revise now or pick up in Step 4" framing landed on "pick up in Step 4" — operationalised as plan task **D.13** which authors fixtures for all 5 stacks (Next.js, Stripe, FastAPI, Supabase, Rust), each producing the expected stack-specific recommendations.
- The `AGENTS.md` skills catalog update (issue #2 / PB-4) is **NOT** in this plan — that's v0.1.0 polish on `main`, per spec D's "Out of scope" section.

## Task list

### Task D.01 — Scaffold 9 SKILL.md skeleton files
**REQ**: REQ-D1, REQ-D2
**AC**: AC-D1.1, AC-D2.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: (none)
**Success criterion**: 9 files created at the documented paths under `skills/stack-specific/` with YAML frontmatter declaring non-empty `name` + `description`. AC-D1.1 + AC-D2.1 pass on skeletons.

### Task D.02 — Author body: `skills/stack-specific/nextjs/server-action-safety/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1 (against this file)
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 patterns/anti-patterns (e.g., authn drift, server-action input validation, mutation idempotency); a `Tradeoff:` or `Why this matters:` section; ≥ 1 ` ```ts ` fenced block; ≥ 1 `ASI\d{2}` or `AST\d{2}` identifier (likely ASI02 Tool Misuse + ASI09 Misaligned & Deceptive Behaviours for client→server boundary confusion). D-lint (D.11) passes for this file.

### Task D.03 — Author body: `skills/stack-specific/nextjs/check-route-types/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 anti-patterns around `next dev/build` typecheck gaps (`any`-typed params, missing route handler signatures, generated types staleness); tradeoff section; ` ```ts ` block; ASI/AST reference. D-lint passes.

### Task D.04 — Author body: `skills/stack-specific/stripe/webhook-idempotency/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01 (G.01 informational only — this Stripe variant is the stack-specific extension of area G)
**Success criterion**: Body documents ≥ 3 Stripe-specific idempotency failure modes (signature replay, retry-id reuse, double-fulfilment on dedupe-store failure); `Stripe-Signature` validation noted as orthogonal concern; ` ```ts ` block with `stripe.webhooks.constructEvent`; ASI02 reference. D-lint passes.

### Task D.05 — Author body: `skills/stack-specific/stripe/pci-scope-minimization/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1; NFR-D4 (PCI DSS references)
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 PCI scope-creep patterns (raw PAN handling, logging cardholder data, transitive PCI exposure via webhook payloads); references specific PCI DSS v4 sections (e.g., 3.3 storage limits, 10.2 audit logs); ` ```ts ` block showing Stripe token-only flow; ASI03 (Identity & Privilege Abuse) reference for PCI-scoped credential handling. D-lint passes.

### Task D.06 — Author body: `skills/stack-specific/fastapi/dependency-injection/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 anti-patterns (DI scope leakage of request-scoped auth into singleton, override-misuse in tests bleeding into prod, missing `Depends()` on auth-required routes); ` ```python ` block; ASI03 reference (auth-token handling). D-lint passes.

### Task D.07 — Author body: `skills/stack-specific/supabase/rls-policies/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1; NFR-D4 (GDPR/SOC 2 references)
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 RLS failure modes (policy bypass via service-role key in client, USING-vs-WITH-CHECK confusion, missing INSERT policy); ` ```sql ` block with `CREATE POLICY … USING … WITH CHECK …`; GDPR Art. 32 + SOC 2 CC6.1 referenced for least-privilege; ASI03 reference. D-lint passes.

### Task D.08 — Author body: `skills/stack-specific/supabase/rpc-functions/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 RPC anti-patterns (SECURITY DEFINER without `SET search_path`, missing `REVOKE EXECUTE FROM public`, JSON-arg shape drift); ` ```sql ` block; ASI02 (Tool Misuse — RPC as privileged backdoor) reference. D-lint passes.

### Task D.09 — Author body: `skills/stack-specific/rust/error-handling/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 anti-patterns (`unwrap()` in request path, `panic!` instead of `Result`, leaking error internals via `Debug`); ` ```rust ` block with `thiserror`/`anyhow` example; ASI06 (Unexpected RCE — leaked error details fueling exploit chains) reference. D-lint passes.

### Task D.10 — Author body: `skills/stack-specific/rust/cargo-audit/SKILL.md`
**REQ**: REQ-D3, D5, D6, D7
**AC**: AC-D3.1, AC-D5.1, AC-D6.1, AC-D7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: Body documents ≥ 3 patterns (cargo-audit in CI, cargo-deny advisory enforcement, RUSTSEC ID monitoring); ` ```rust ` or ` ```toml ` fenced example showing `cargo audit --deny warnings`; AST08 (Update tampering — pinned versions vs floating ranges) reference. D-lint passes.

### Task D.11 — Author D-lint script `.workflow/proofs/_checks/req-d-skills.js`
**REQ**: AC-D2 through AC-D7 enforcement
**AC**: lint script PASSes against all 9 well-formed skills + FAILs against a deliberately malformed fixture
**Type**: test
**Effort**: ~45 min
**Depends on**: D.01
**Success criterion**: The lint script walks `skills/stack-specific/**/SKILL.md`, validates frontmatter, counts H3/numbered anti-pattern entries (≥ 3), checks for `Tradeoff:` or `Why this matters:`, checks for ≥ 1 stack-appropriate fenced code block, checks for ≥ 1 `ASI\d{2}` or `AST\d{2}` identifier. Exit 0 PASS / non-zero FAIL with named file.

### Task D.12 — Extend `analyzer/recommendation-rules.yml` with stack-specific skill recommendations
**REQ**: REQ-D4
**AC**: AC-D4.1 (Next.js path)
**Type**: implementation
**Effort**: ~30 min
**Depends on**: D.01
**Success criterion**: When `analyzer/scan.ts` detects a stack indicator (`next` dep, `stripe` dep, `fastapi` dep, `@supabase/supabase-js` dep, `Cargo.toml` present), the emitted `.workflow/profile.yml` `recommended.skills` array includes the corresponding stack-specific skill paths. AC-D4.1 passes for the Next.js fixture.

### Task D.13 — CARRY-FORWARD: broaden AC-D4.1 fixtures to all 5 stacks
**REQ**: REQ-D4 (broadened coverage per Step 1 reviewer)
**AC**: extension of AC-D4.1 — each of the 5 stacks emits the expected recommendations against its dedicated fixture
**Type**: test
**Effort**: ~60 min
**Depends on**: D.12
**Success criterion**: Five fixture projects at `tests/fixtures/analyzer/{nextjs,stripe,fastapi,supabase,rust}-project/` each produce a profile whose `recommended.skills` matches the corresponding stack-specific skill paths. The "Next.js-only" reviewer concern from Step 1 closed.

### Task D.14 — Security-review: ASI/AST references in 9 skills are defensible
**REQ**: REQ-D7 quality gate
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~45 min
**Depends on**: D.02 – D.10
**Success criterion**: Each of the 9 skills' cited ASI/AST identifier maps onto a documented threat in `governance/owasp-asi-2026/threats.md` and is materially mitigated by the skill's content (not decorative). Review checklist signed; any drift annotated.

### Task D.15 — Security-review: PCI / GDPR / SOC 2 citations are accurate
**REQ**: NFR-D4 (compliance accuracy)
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~30 min
**Depends on**: D.05, D.07
**Success criterion**: PCI DSS section references in D.05 (Stripe `pci-scope-minimization`) cite the correct v4 sections (e.g., 3.3, 10.2). GDPR Art. 32 + SOC 2 CC6.1 references in D.07 (Supabase `rls-policies`) align with the authz-overlap framing. Citations verified against current spec text.

### Task D.16 — Emit per-REQ Phase 4 implementation claims (D1–D7)
**REQ**: meta — consolidates Step 4 claim emission for area D
**AC**: all D ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: D.01 – D.15
**Success criterion**: 7 new claim YAML files (one per REQ-D1 through REQ-D7) all valid per the claim-validator's re-run check.

## Dependency graph

```
D.01 (scaffold) ─┬─► D.02 (nextjs/server-action) ───┐
                 ├─► D.03 (nextjs/route-types)      │
                 ├─► D.04 (stripe/webhook)          │
                 ├─► D.05 (stripe/pci) ─────────► D.15 (sec-review PCI)
                 ├─► D.06 (fastapi/di)              │
                 ├─► D.07 (supabase/rls) ────────► D.15 (sec-review GDPR/SOC 2)
                 ├─► D.08 (supabase/rpc)            │
                 ├─► D.09 (rust/errors)             │
                 ├─► D.10 (rust/cargo-audit) ───────┘
                 ├─► D.11 (D-lint script)
                 └─► D.12 (analyzer rules) ─► D.13 (5-stack fixtures, CARRY-FORWARD)
                                                              │
                                            D.14 (sec-review ASI/AST refs)
                                                              │
                                                              ▼
                                                          D.16 (test — emit claims)
```

D.02–D.10 are parallelisable. D.11 (lint) gates the per-skill quality bar. D.12 + D.13 are the analyzer wiring + broadened fixtures. Security reviews (D.14, D.15) precede claim emission.

## Total effort estimate

- Implementation tasks (D.01–D.10, D.12): ~7.0 hours
- Test/fixture tasks (D.11, D.13, D.16): ~2.25 hours
- Security-review tasks (D.14, D.15): ~1.25 hours
- **Grand total: ~10.0–11.0 hours of Step 4 implementation work for area D.**

## Out of scope for this plan

- Universal `skills/universal/security/webhook-idempotency/` — area G (the Stripe-specific variant in D.04 is the extension).
- Updating `AGENTS.md` skills catalog — v0.1.0 polish on `main` (issue #2 / PB-4).
- Skill signatures for new stack-specific skills — areas E + F (signing flow established there will apply to D skills at next release).
- Adding new stack detectors (Vue, Svelte, Go, Java) — deferred until a real project surfaces the need.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area D plan decomposition).
