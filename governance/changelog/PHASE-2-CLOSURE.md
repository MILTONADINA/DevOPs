# Phase 2 — Security Depth — CLOSURE

**Sealed**: 2026-05-24 (session 8 Phase B.3)
**Branch**: `phase-2-security-depth`
**Scope**: 8 EARS areas (A–H) + A.11 (Phase 2 final-pass sec-review) + A.13 (claim consolidation)

Phase 2's mandate per `governance/changelog/ROADMAP.md`: pentest stack integration, OWASP ASI 2026 red-team in CI, prompt-injection defense hardening, stack-specific security skills, Sigstore signing, skill provenance verification at install. All shipped.

---

## Per-area status

| Area | Title | Status | Anchoring claims |
|---|---|---|---|
| A | Pentest stack (Shannon, PentAGI, Lyrie, pentest-ai) | ✅ Closed | 042–049 (REQ-A1..A8); A.11 sec-review pass; A.13 = this file + claim 090 |
| B | DeepTeam OWASP ASI 2026 red-team CI gate | ✅ Closed | 065–073 (REQ-B1..B8) |
| C | Prompt-injection defense hardening (rebuff + HMAC boundary) | ✅ Closed | 082–087 (REQ-C1..C8 across 6 consolidated claims) |
| D | Stack-specific security skills | ✅ Closed | 055–064 (REQ-D1..D7) |
| E | Sigstore signing + signed manifest | ✅ Closed | 074–080 (REQ-E1..E7) |
| F | Skill provenance verification at install | ✅ Closed | 088–089 (REQ-F1..F7 across 2 consolidated claims) |
| G | Webhook idempotency skill + analyzer detection | ✅ Closed | 053–054 (REQ-G1..G8) |
| H | Renovate template + ci.yml lint | ✅ Closed | 050–052 (REQ-H1..H8) |
| A.11 | Final-pass sec-review (ASI02 + ASI04) | ✅ PASS | 090 |
| A.13 | Per-REQ A1..A8 claim consolidation | ✅ Consolidated | 042–049 already valid; this file + 090 anchor the meta |

---

## A.11 sec-review summary

Full sec-review at `.workflow/proofs/sec-review/A.11-asi02-asi04.md` (local-only).

- **ASI02** (subagent least-priv on 4 pentest tools): **PASS**. `subagents/universal/security.md` declares minimal tool set + `forbidden_paths` excluding `src/**` and `tests/**`. No other subagent declares pentest-MCP access. Permission inheritance is per-frontmatter only (no implicit broadening). No findings.
- **ASI04** (Lyrie RAG wrapped via `observability/external-content-boundary.ts`): **PASS**. Boundary module + pre-tool hook from C.03/C.05 provide the cryptographic gate. One in-session config gap surfaced + closed: `lyrie-mcp` added to `governance/external-content-sources.yml` (was previously rejected as unknown source — config completeness gap, not ASI04 bypass). All four pentest tools now in the source table.

A.11 prerequisite for Phase 2 sign-off: **MET**.

---

## Claim coverage (full Phase 2)

Total Phase 2 claims valid on `phase-2-security-depth`: **90/90** (042..080 + 082..090; claim 081 lives on `stratum-merge` from session 7).

Consolidated-claims convention (Areas C, F, A.11/A.13): one claim may anchor multiple REQs when the same module/proof satisfies them. **REQ coverage is the hard requirement; 1:1 claim count is not.** Each Phase 2 REQ (A1–A8, B1–B8, C1–C8, D1–D7, E1–E7, F1–F7, G1–G8, H1–H8, NFR-A2) maps to ≥1 valid claim.

---

## Cross-area dependencies (status)

- **F.09 ← E.04**: CLEARED session 6 (first Sigstore signing run).
- **A.11 ← C.03+C.05**: CLEARED this session (Area C shipped the boundary; A.11 sec-review confirms Lyrie RAG path).
- **C.05 ← C.03 ← C.01 + C.02**: structurally satisfied by C.01–C.05 commits this session.

---

## Stale cosign signatures (pending refresh at release-sign.yml dispatch)

Modified this session, signatures + bundles now stale relative to content:

- `skills/universal/security/prompt-injection-defense/SKILL.md` (C.09 added 6 new H2 sections)

The manifest entry's `sha256` is also stale. Both `.sig` + `.bundle` files + manifest sha256 are stale.

**Auto-resolves**: next `release-sign.yml` dispatch (Session 9 release-prep, post-merge to main, pre-`v0.2.0` tag). The workflow recomputes sha256 + re-signs against current content.

Tracked in polish-backlog as **PB-13** (added session 8 Phase B.4 closure).

---

## Honesty markers

1. **Consolidated claims policy**: Areas C (6 claims for 8 REQs), F (2 claims for 7 REQs), and A.11/A.13 (1 claim for NFR-A2 + the consolidation meta-claim) use consolidation where the same proof artefact satisfies multiple REQs. Each REQ has ≥1 anchoring claim.
2. **Post-install revocation gap**: spec F Open Issue #1 (ASI10 row) remains **DEFERRED TO PHASE 3** per spec F bounded scope. Threat-model F honestly documents this; not a Phase 2 closure obstacle.
3. **Stratum integration**: Phase 3 work (Option B locked 2026-05-24). NOT a Phase 2 closure obstacle; tracked separately in `docs/LAUNCH_READINESS.md` (on `stratum-merge`).
4. **GAP_61 row updates**: Phase 2 rows not yet marked closed in `docs/GAP_61_COVERAGE_MATRIX.md`. Defer to Session 9 release-prep (one consolidated edit after all v0.2.0 mechanics complete).

---

## Session 9 entry conditions

- Polish backlog burn-down (10 open items per `.workflow/state/polish-backlog.md` post-session-8: PB-3..PB-10, PB-12, PB-13)
- Release-prep:
  1. `governance/VERSION.md` → `0.2.0`
  2. Merge `stratum-merge` → `main` (Option B-scoped Stratum subtree)
  3. Merge `phase-2-security-depth` → `main` (Phase 2 closure)
  4. Tag `v0.2.0`
  5. `release-sign.yml` dispatch refreshes all stale signatures (PB-13 auto-resolves)
  6. GAP_61 Phase 2 rows marked closed

---

## Cross-references

- ROADMAP: `governance/changelog/ROADMAP.md` Phase 2 section
- GAP_61 coverage matrix: `docs/GAP_61_COVERAGE_MATRIX.md`
- Launch readiness: `docs/LAUNCH_READINESS.md` (on `stratum-merge`; refreshed at T-Z4)
- Polish backlog: `.workflow/state/polish-backlog.md` (local-only)
- Baton: `.workflow/state/baton.md` (local-only)
- A.11 sec-review: `.workflow/state/.workflow/proofs/sec-review/A.11-asi02-asi04.md` (local-only)
- Phase 2 specs: `specs/phase-2/{A..H}-*.md`
- Phase 2 plans: `.workflow/state/plans/phase-2-{A..H}-*.md`
- Phase 2 threat models: `docs/threat-models/phase-2/{A..C,E,F}-*.md`
