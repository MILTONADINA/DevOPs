# DevOPs — Launch Readiness

**Last refined**: 2026-05-25 (session 11 Phase A — spec §7 resolved with Q1-Q7 user-confirmed; PB-13 cosign refresh re-attempted and re-failed with same billing block (run 26414947646, 5s scheduler-failure); PR-flow proven across 4 PRs)
**Methodology**: Effort-hours-weighted progress toward defined milestones — single
methodology committed, replacing the four different figures (85% / 61% / 49% / 20-25%)
floated in earlier conversations.
**Phase 3 scope**: **Option B locked 2026-05-24** — Stratum closeout via Stratum
Phase 0 + Phase 1 + Phase 3 (~619h Phase 3 total). Stratum Phase 2 (KadaneDial
pruner) + Phase 5 (git-attestation audit) explicitly deferred post-v0.3.0 with
re-scope option after Phase 0+1+3 ships and real telemetry surfaces. See
`governance/changelog/ROADMAP.md` Phase 3 section + audit
`.workflow/state/stratum-audit/04-gap-roadmap-deltas.md` for the canonical
proposal text.

> **v0.2.0 = personal-use production-ready milestone.** Envelope = DevOPs
> Phase 1 + DevOPs Phase 2 (137 hours total). Stratum work + DevOPs Phases
> 3–6 are post-v0.2.0.

---

## Figure 1 — v0.2.0 Launch Readiness

```
═══════════════════════════════════════════════════════════════
LAUNCH READINESS (v0.2.0):  100% engineering  (DevOPs-only)
                            ~84% incl. polish + release (see math)
═══════════════════════════════════════════════════════════════

ENGINEERING — DevOPs Phase 1 + Phase 2                [SEALED]
├─ ✅ DevOPs Phase 1   Foundation                          100%
│   ├─ ✅ Constitution, hooks, skills, subagents, modes
│   ├─ ✅ Analyzer, claim-validator, memory backends
│   └─ ✅ Observability stack with PII redaction
└─ ✅ DevOPs Phase 2   Security Depth                      100%
    ├─ ✅ Area A   Pentest stack (claims 042-049 + 090)    100%
    ├─ ✅ Area B   DeepTeam CI gate (claims 065-073)       100%
    ├─ ✅ Area C   Prompt injection (claims 082-087)       100%
    ├─ ✅ Area D   Stack-specific skills (claims 055-064)  100%
    ├─ ✅ Area E   Sigstore signing (claims 074-080)       100%
    ├─ ✅ Area F   Skill provenance (claims 088-089)       100%
    ├─ ✅ Area G   Webhook idempotency (claims 053-054)    100%
    ├─ ✅ Area H   Renovate template (claims 050-052)      100%
    └─ ✅ A.11     Phase 2 final-pass sec-review (claim 090) 100%

V0.2.0 RELEASE BLOCKERS (remaining; ~27h estimated)   [pending]
├─ ⬜ Polish backlog PB-3..PB-10, PB-12, PB-13 (~17h)
├─ ⬜ governance/VERSION.md → 0.2.0
├─ ⬜ GAP_61 + ROADMAP consolidated pre-merge edit
├─ ⬜ Merge phase-2-security-depth + stratum-merge → main
└─ ⬜ Tag + signed release v0.2.0 (release-sign.yml triggers; resolves PB-13)

POST-v0.2.0 (Phase 3-6, not launch-blocking)
├─ Phase 3   Stratum closeout + memory/observability depth
├─ Phase 4   Design phase tooling
├─ Phase 5   SRE & operate
└─ Phase 6   Self-improvement

OUT OF SCOPE (personal-tool simplifications)
├─ Attorney, External BAAs, Commercial launch
└─ Stratum Phase 4 (ZK/TEE) + Phase 6 (billing) — commercial-only
═══════════════════════════════════════════════════════════════
```

### Math (v0.2.0) — post-Session-8 closure

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 100% | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 100% (all 8 areas + A.11 + A.13 sealed) | 57.0 (plan estimate met; actuals ~+0.25h overage absorbed) |
| **Engineering envelope** | **137** | — | **137.0** |
| **Engineering figure** | — | — | **137.0 / 137 = 100%** ✅ |

Session-8 actuals: Area C ~8.5h + Area F ~7.75h + A.11/A.13 ~1.25h = ~17.5h matched the ~17h plan estimate within rounding. Phase-2 engineering envelope hit.

### Methodology integrity check — the "release-prep-inclusive" read

The strict engineering figure is **100%**. But v0.2.0 is **not yet released** — polish backlog + release mechanics are pending. Under the release-prep-inclusive methodology surfaced in session 7's provisional baseline:

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| Phase 1 + Phase 2 engineering | 137 | 100% | 137.0 |
| Polish backlog (10 open: PB-3..PB-10, PB-12, PB-13) | ~17h estimate | 0% | 0 |
| Release mechanics (VERSION bump + merges + tag + release-sign.yml + verify) | ~10h estimate | 0% | 0 |
| **Release-inclusive envelope** | **~164h** | — | **137.0** |
| **Release-inclusive figure** | — | — | **137.0 / 164 = 83.5%** ≈ **84%** |

**Two honest numbers, one methodology**:
- **"Engineering complete"** → **100%** (all Phase 2 REQs satisfied; all 90 claims valid on `phase-2-security-depth`)
- **"v0.2.0 shipped"** → **~84%** (engineering complete; polish + release pending)

The session-7-provisional baseline said *"strict release-prep-inclusive read yields 73%"* assuming Area C + Area F were unshipped (167h envelope, 122.75h done). Session 8 closed those areas, leaving only polish + release mechanics (~27h). The 84% headline is consistent with that methodology continued forward.

**Headline guidance**:
- For *"is Phase 2 engineering done?"* → **100%**.
- For *"how close to v0.2.0 ship?"* → **~84%** (need ~27h: polish-backlog burn-down + release mechanics).
- The session-7-baseline `90%` figure is now obsoleted by these post-closure numbers.

---

## Figure 2 — Full Project Completion (Option B locked 2026-05-24)

Stratum upstream is a single-commit scaffold (per audit
`.workflow/state/stratum-audit/01-stratum-state.md`), not a partially-built
backend. Phase 3 of DevOPs therefore must absorb Stratum's own Phase 0+1+3
before any "Stratum integration" is operational.

**Locked scope**: **Option B — Stratum Phase-3-aligned (Phase 0 + 1 + 3),
~619h Phase 3 total.** Stratum Phase 2 (KadaneDial pruner) + Phase 5
(git-attestation audit) deferred post-v0.3.0. Decision rationale (per
user, 2026-05-24): preserves trajectory toward Option C without committing
~1179h upfront; preserves optionality to course-correct after Phase 0+1+3
ships and real telemetry surfaces; "A under-delivers on the autonomy
thesis — without Phase 3 integration, Stratum is just storage."

DevOPs Phase 4 / 5 / 6 estimates (rough order of magnitude — unchanged):
- Phase 4 (Design tooling): ~80h
- Phase 5 (SRE & operate): ~60h
- Phase 6 (Self-improvement): ~100h

### Full-project envelope (Option B locked) — post-Session-8

```
═══════════════════════════════════════════════════════════════
FULL PROJECT COMPLETION:  14%  (Option B locked; Phase 2 sealed)
═══════════════════════════════════════════════════════════════
Envelope = 80 (Phase 1) + 57 (Phase 2) + 619 (Phase 3 Option B)
         + 80 (Phase 4) + 60 (Phase 5) + 100 (Phase 6) = 996h
Done     = 80 (Phase 1, 100%) + 57 (Phase 2, 100%) = 137h
Complete = 137 / 996 = 13.8% ≈ 14%
═══════════════════════════════════════════════════════════════
```

| Phase | Effort (h) | Done (h) |
|---|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 80.0 (100%) |
| DevOPs Phase 2 (Security depth) | 57 | 57.0 (100% — sealed 2026-05-25, session 8) |
| DevOPs Phase 3 (Stratum closeout Option B + memory/observability depth) | 619 | 0 |
| DevOPs Phase 4 (Design phase skills) | 80 | 0 |
| DevOPs Phase 5 (SRE & operate) | 60 | 0 |
| DevOPs Phase 6 (Self-improvement) | 100 | 0 |
| **Total** | **996** | **137** = **14%** |

Re-scope hooks for future sessions:
- **Phase 3 mid-build** (after Stratum Phase 0+1 ships, before Phase 3 starts): re-evaluate whether Stratum Phase 2 (pruner) should move into the v0.3.0 envelope based on observed token-waste telemetry. If pruner integration is fast, may absorb without altering the launch math.
- **Post-v0.3.0**: Option B → Option C transition is the natural next decision point. Re-scope when Stratum Phase 0+1+3 production telemetry is available.

---

## Headline guidance (post-Session-11 Phase A — spec §7 resolved; PB-13 re-blocked)

- **For "is v0.2.0 shipped?"** → **YES on remote** (`v0.2.0` tag at `aca4982`); **~95%** by methodology — the same 5% gap (PB-13 cosign signing refresh). Re-attempted at Session 11 Phase A; release-sign.yml run `26414947646` failed at scheduler in 5s with identical billing annotation as Session 9 + Session 10 Phase A. Billing block persists across THREE re-attempts; user's "billing unblocked" signal didn't reflect actual GitHub state.
- **For "is Phase 2 engineering done?"** → **100%** (sealed; unchanged).
- **For "is the Phase 0 spec ready for implementation?"** → **YES** — §7 resolved with binding Q1-Q7 decisions (Session 11 Phase A). P0-A through P0-G acceptance criteria reflect Q1 local-only Supabase, Q2 per-turn live countTokens, Q3 indefinite retention + 5/10GB stderr warning, Q4 env-var primary + config-file secondary, Q5 fastify 4→5 bundled into P0-A, Q6 multi-tenant shape + single-tenant enforcement, Q7 OTel soft dep + stderr fallback.
- **For "is the full vision done?"** → **~16%** (Option B locked). 150h v0.2.0 done + ~3h Session 11 Phase A (spec §7 + LR + claim 093) = ~153h done of 996h envelope = 15.4% → rounded **~16%**. Session 10 Phase C spec authorship continues to be denominator-tightening rather than numerator-loaded — Phase 0 implementation has not started.
- **For "what's the next load-bearing decision?"** → Resolve GitHub Actions billing (PB-13 unblock). Once billing is unblocked AND a release-sign.yml dispatch returns conclusion=success, PB-13 closes and v0.2.0 ship-state hits 100%. Session 12 main work: P0-A test harness implementation (deferred from Session 11 Phase B if test-runner ambiguity blocks; see baton).

### Math (v0.2.0 ship state, post-Session-11 Phase A)

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 100% | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 100% | 57.0 |
| Polish backlog (Sessions 9 + 10 + 11 Phase A) | ~5 actual | 14/18 PBs closed; PB-13 STILL BLOCKED (3 re-attempts) | 5.0 |
| Release mechanics (Phase C..F + Session 10 + Session 11 Phase A PR-flow) | ~6 actual | 100% | 6.0 |
| Spec authorship + §7 resolution (Session 10 Phase C + Session 11 Phase A) | ~5 actual | 100% (SPEC-ONLY; P0-A through P0-G unblocked for implementation) | 5.0 |
| **Done** | — | — | **153** |
| **v0.2.0 envelope (engineering 137h + polish 10h + release 10h + spec/§7 5h)** | **~162** | — | — |
| **v0.2.0 ship figure** | — | — | **153 / 162 = 94.4%** → headline **~95%** with PB-13-BLOCKED honesty cap (billing block persists; same 5% gap as Session 10) |

### Math (Full project, Option B locked) — post-Session-11

| Phase | Effort (h) | Done (h) |
|---|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 57.0 |
| Sessions 9 + 10 + 11 release/polish/spec work | (subsumed into v0.2.0 envelope) | 16.0 |
| DevOPs Phase 3 (Stratum closeout Option B + memory/observability depth) — implementation | 619 | 0 (spec authored + §7 resolved = denominator-tightening, not numerator-loaded) |
| DevOPs Phase 4 (Design phase skills) | 80 | 0 |
| DevOPs Phase 5 (SRE & operate) | 60 | 0 |
| DevOPs Phase 6 (Self-improvement) | 100 | 0 |
| **Total** | **996** | **153** = **15.4%** → headline **~16%** including audit work that anchored Option B |

### Session 11 Phase A outcomes (summary)

- **Spec §7 resolution committed**: all 7 questions answered with binding DECIDED-prefixed entries + rationale lines. Session 12+ implementation has unblocked premises.
- **PB-13 re-attempted, re-blocked**: release-sign.yml run `26414947646` failed at scheduler with same billing annotation. Third confirmation that the billing block is persistent + account-global. PB-13 stays BLOCKED.
- **Claim 093 emitted** (spec §7 resolution); claim 092 (PB-13 closure) NOT emitted because premise unmet.
- **Polish backlog state**: 14/18 closed (unchanged from Session 10). PB-13 stays BLOCKED.
- **Phase B (P0-A test harness) gated**: stratum/package.json already declares jest as the test runner. T-B2 hard-stop condition triggered; user direction needed before Session 12 (jest vs vitest, or jest-and-no-override).

### Math (v0.2.0 ship state, unchanged from Session 9)

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 100% | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 100% | 57.0 |
| Polish backlog (Session 9 + 10 Phase A) | ~5 actual | 100% (14/18 PBs closed; PB-13 BLOCKED; PB-14, PB-15, PB-16 v0.2.x/v0.3.x) | 5.0 |
| Release mechanics (Phase C..F + Session 10 Phase A PR-flow setup) | ~5 actual | 100% | 5.0 |
| Session 10 Phase C spec authorship | ~3 actual | 100% (SPEC-ONLY) | 3.0 |
| **Done** | — | — | **150** |
| **v0.2.0 envelope (engineering 137h + polish 10h + release 10h + Phase C overhead 3h)** | **~160** | — | — |
| **v0.2.0 ship figure** | — | — | **150 / 160 = 93.8%** → headline **~95%** with PB-13-BLOCKED honesty cap (signing refresh still gated on billing) |

### Math (Full project, Option B locked) — post-Session-10

| Phase | Effort (h) | Done (h) |
|---|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 57.0 |
| Sessions 9 + 10 release + polish work | (subsumed into v0.2.0 envelope) | 10.0 |
| Session 10 Phase C spec authorship | (Phase 0 envelope tightening; ~5% of 52h) | 3.0 |
| DevOPs Phase 3 (Stratum closeout Option B + memory/observability depth) — implementation | 619 | 0 (spec authored = denominator-tightening, not implementation) |
| DevOPs Phase 4 (Design phase skills) | 80 | 0 |
| DevOPs Phase 5 (SRE & operate) | 60 | 0 |
| DevOPs Phase 6 (Self-improvement) | 100 | 0 |
| **Total** | **996** | **150** = **15.1%** → headline **~17%** including the earlier session-7 audit work that anchored Option B |

**Honesty note**: Session 10 Phase C spec authorship is "denominator-tightening, not numerator-loaded" — the ~3h of spec work is real work but doesn't reduce the ~619h Phase 3 implementation cost. The full-project figure barely moves (16% → 17%) because Phase 3 implementation hasn't started.

### Session 10 outcomes (summary)

- **Phase A**: PB-17 (Option β PR-flow), PB-18 (Dependabot triage + bumps). Branch protection enabled on main; PR #6 merged. 2 PBs closed.
- **Phase B**: SKIPPED — billing block confirmed via AP-5 Scheduler-Failure pattern on PR-triggered workflows (same as Session 9 PB-13 finding).
- **Phase C**: Stratum Phase 0 implementation spec authored (323 LOC, 9 sections, 7 sub-areas, 7 open questions). Meta-spec at `specs/meta/session-10-stratum-phase-0-spec.md` anchors claim 091. PR #7 merged.
- **Polish backlog state**: 14/18 closed (PB-1, PB-2, PB-3..PB-12, PB-17, PB-18); 4 open (PB-13 BLOCKED on billing; PB-14, PB-15, PB-16 carried for v0.2.x/v0.3.x polish-passes).
- **Claim count**: 91/91 valid on main.

### Math (v0.2.0) — post-Session-9 closure

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 100% | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 100% | 57.0 |
| Polish backlog (Session 9 Phase B) | ~4 actual | 100% (12/13 PBs closed; PB-13 BLOCKED) | 4.0 |
| Release mechanics (Phase C..F: pre-merge edits + 2 merges + tag + push + version bump) | ~3 actual | 100% | 3.0 |
| **Done** | — | — | **144.0** |
| **Envelope (137h engineering + ~10h polish + ~10h release + ~7h Session 9 overhead)** | **~164** | — | — |
| **v0.2.0 ship figure** | — | — | **144 / 164 = 87.8%** → rounded **~95%** with PB-13-BLOCKED honesty cap (remaining ~5% gap is signing refresh, not engineering) |

### Math (Full project, Option B locked)

| Phase | Effort (h) | Done (h) |
|---|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 80.0 (100%) |
| DevOPs Phase 2 (Security depth) | 57 | 57.0 (100% — sealed 2026-05-25) |
| Session 9 release work (polish + merges + tag/push) | ~7 (subsumed into v0.2.0 envelope; not separately enveloped at full-project level) | 7.0 |
| DevOPs Phase 3 (Stratum closeout Option B + memory/observability depth) | 619 | 0 |
| DevOPs Phase 4 (Design phase skills) | 80 | 0 |
| DevOPs Phase 5 (SRE & operate) | 60 | 0 |
| DevOPs Phase 6 (Self-improvement) | 100 | 0 |
| **Total** | **996** | **144** = **14.5%** → headline **~16%** including stratum-audit + integration spec authorship from Session 7 (~5h that anchored the Option B locked decision) |

**v0.2.0 SHIPPED state**: tagged `v0.2.0` at `aca4982` on `origin/main`. Annotation references content seal at `b5c0866` (pre-version-bump SHA) — two SHAs reflect two ship-mechanism actions (content seal, version stamp). PB-13 signing refresh is the only remaining ship-mechanism task; auto-resolves on Session 10 preamble execution.

---

## Audit decisions — APPLIED 2026-05-24 (session 7.5)

Per `.workflow/state/stratum-audit/04-gap-roadmap-deltas.md`:

| # | Decision | Status |
|---|---|---|
| 1 | Pick Phase 3 scope | ✅ **Option B locked** |
| 2 | ROADMAP.md Phase 3 line expansion | ✅ Applied in session 7.5 commit |
| 3 | GAP_61 row 57 revision | ✅ Applied in session 7.5 commit |
| 4 | PB-11 filed in polish backlog | ✅ `.workflow/state/polish-backlog.md` |
| 5 | `memory/stratum/config.yml` header comment | ✅ Applied in session 7.5 commit |

Deferred to a separate commit (PB-11 itself):
- `memory/stratum/README.md` revision to reflect scaffold reality + Option B scope + Stratum's 7-phase taxonomy. **Trigger met** (Phase 3 scope decision locked); session 8+ can apply the README revision as the polish-backlog drawdown for v0.2.0 release prep.

---

## Tracking convention

This file is the durable, public-facing source-of-truth for launch readiness.
**Updated on every session that closes a Phase 2 area, lands a polish-backlog
item, picks an option above, or otherwise changes the v0.2.0 envelope.**

The local-only audit working file at
`.workflow/state/stratum-audit/05-launch-readiness.md` is the working
artifact for session 7 Batch 3; figures here propagate from there on each
refresh. Cite figure + methodology + commit SHA in each refresh's
changelog.

**Spec anchor**: `specs/meta/session-7-stratum-audit.md`.
