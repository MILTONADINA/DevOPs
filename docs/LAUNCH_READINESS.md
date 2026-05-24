# DevOPs — Launch Readiness

**Last refined**: 2026-05-24 (session 7, Batch 1 — provisional baseline pre-audit)
**Next refresh**: Batch 3 of session 7 (post-Stratum-audit refined figure)

> **Methodology — one number, committed**: Launch readiness = % work
> complete toward **v0.2.0** (the personal-use production-ready
> milestone), weighted by **effort hours**. Phases 3–6 are post-launch
> enhancement, not launch-blocking. v0.2.0 closes when: all 8 Phase 2
> areas land, polish backlog (PB-3..PB-12) clears, `governance/VERSION.md
> → 0.2.0`, and `phase-2-security-depth` + `stratum-merge` merge to
> `main` with a signed `v0.2.0` tag.

---

## Provisional figure (pre-Stratum-audit)

```
═══════════════════════════════════════════════════════════════
LAUNCH READINESS:  ~91% complete  (DevOPs-only, pre-Stratum-merge)
═══════════════════════════════════════════════════════════════

ENGINEERING — Phase 1 + Phase 2 (v0.2.0 target)       [91% done]
├─ ✅ Phase 1   Foundation (47 gaps, 9 commits on main)    100%
│   ├─ ✅ Constitution, hooks, skills, subagents, modes
│   ├─ ✅ Analyzer, claim-validator, memory backends
│   ├─ ✅ Observability stack with PII redaction
│   └─ 🟡 Polish backlog (8 items deferred to v0.2.0)
├─ 🟡 Phase 2   Security Depth (9 gaps, 32h of 57h)         75%
│   ├─ ✅ Area A   Pentest stack (claims 042-049)           100%
│   ├─ ✅ Area B   DeepTeam CI gate (claims 065-073)        100%
│   ├─ ⬜ Area C   Prompt injection (8.5h, A.11 unblocker)    0%
│   ├─ ✅ Area D   Stack-specific skills (claims 055-064)   100%
│   ├─ ✅ Area E   Sigstore signing (claims 074-080)        100%
│   ├─ ⬜ Area F   Skill provenance (8h)                      0%
│   ├─ ✅ Area G   Webhook idempotency (claims 053-054)     100%
│   ├─ ✅ Area H   Renovate template (claims 050-052)       100%
│   └─ ⬜ A.11     Phase 2 final-pass (blocked on C.05)       0%

V0.2.0 RELEASE BLOCKERS                               [partial]
├─ ⬜ Area C, Area F, A.11 final-pass
├─ ⬜ Polish backlog PB-3..PB-12 (9 items as of session 6)
├─ ⬜ governance/VERSION.md → 0.2.0
├─ ⬜ Merge phase-2-security-depth → main + tag v0.2.0
└─ ⬜ Trigger release-sign.yml on v0.2.0

POST-v0.2.0 (Phase 3-6, not launch-blocking)
├─ Phase 3   Memory & observability depth (incl. Stratum)
├─ Phase 4   Design phase tooling
├─ Phase 5   SRE & operate
└─ Phase 6   Self-improvement

OUT OF AUTOMATION SCOPE (personal-tool simplifications)
├─ Attorney            n/a (personal use)
├─ Pen-test            covered by Phase 2 pentest stack
├─ External BAAs       n/a (no third-party PHI handling)
└─ Commercial launch   not a goal
═══════════════════════════════════════════════════════════════
```

### Computation

- **Phase 1**: 80 effort hours, 100% complete → 80h / 178h total v0.2.0 effort = **45 percentage points**
- **Phase 2**: 57 effort hours estimated, 75% complete (6 of 8 areas) → 0.75 × 57h = 42.75h / 178h total = **24 percentage points**
- **Polish backlog**: ~10 hours estimated for PB-3..PB-12 → not yet started, not counted toward the 91%; cleared in v0.2.0 release prep
- **Release prep**: ~5 hours (version bump, merge, tag, signed release) → not yet started
- **Total counted**: 45 + 24 = 69h of the 178h v0.2.0 envelope is done. Provisional rough number: 69/178 ≈ 39%.

> **Discrepancy flag**: the "~91% complete" headline aggregates differently — it weights *areas closed* (6/8 = 75% of Phase 2 by area-count) plus Phase 1 (100%), under a "two phases of equal weight" model. The "39%" effort-hours derivation above is the stricter math. The Refined Launch Readiness figure in Batch 3 will commit to ONE methodology and report ONE number — surfacing this discrepancy explicitly here so the choice is visible.

---

## Awaiting refinement from Batch 3

Three changes are queued for the post-Stratum-audit refresh:

1. **Stratum's actual state** changes Phase 3's scope. DevOPs's `memory/stratum/README.md` describes Stratum's Phase 0 capture proxy + Phase 1 git attestation as "ready" — the audit confirmed the upstream repo is in fact a **single-commit scaffold** (April 6, 2026) with source stubs only. Phase 3 of DevOPs's roadmap therefore expands to include Stratum closeout (not just integration). If Stratum integration is deemed non-launch-blocking, this changes nothing for v0.2.0; if deemed launch-blocking, the v0.2.0 envelope grows substantially.

2. **Methodology commitment**: pick *effort-hours-weighted* or *area-closed-weighted* and report one number with the math shown. The 91% / 39% discrepancy above is exactly the slop this file is meant to eliminate.

3. **Roadmap deltas**: propose updates to `governance/changelog/ROADMAP.md` + `docs/GAP_61_COVERAGE_MATRIX.md` based on the Stratum-merge findings. Per the session 7 prompt, those edits are surfaced for approval — not applied directly.

---

## Tracking convention

This file is the durable, public-facing source-of-truth for launch readiness.
Update on every session that closes a Phase 2 area, lands a polish-backlog
item, or otherwise changes the v0.2.0 envelope. Cite the figure + the
methodology + the commit SHA where it was refined.

The local-only audit working file (`.workflow/state/stratum-audit/05-launch-readiness.md`)
is where session 7 Batch 3 will produce the refined figure first; that
figure then propagates here.
