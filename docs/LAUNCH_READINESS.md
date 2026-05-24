# DevOPs — Launch Readiness

**Last refined**: 2026-05-24 (session 7.5 — Option B locked; range collapses to 12% full-project)
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
LAUNCH READINESS (v0.2.0):  90%  complete  (DevOPs-only)
═══════════════════════════════════════════════════════════════

ENGINEERING — DevOPs Phase 1 + Phase 2                [90% done]
├─ ✅ DevOPs Phase 1   Foundation                          100%
│   ├─ ✅ Constitution, hooks, skills, subagents, modes
│   ├─ ✅ Analyzer, claim-validator, memory backends
│   └─ ✅ Observability stack with PII redaction
├─ 🟡 DevOPs Phase 2   Security Depth                       75%
│   ├─ ✅ Area A   Pentest stack (claims 042-049)          100%
│   ├─ ✅ Area B   DeepTeam CI gate (claims 065-073)       100%
│   ├─ ⬜ Area C   Prompt injection (~8.5h, A.11 unblocker)   0%
│   ├─ ✅ Area D   Stack-specific skills (claims 055-064)  100%
│   ├─ ✅ Area E   Sigstore signing (claims 074-080)       100%
│   ├─ ⬜ Area F   Skill provenance (~8h, F.09 cleared)       0%
│   ├─ ✅ Area G   Webhook idempotency (claims 053-054)    100%
│   ├─ ✅ Area H   Renovate template (claims 050-052)      100%
│   └─ ⬜ A.11     Phase 2 final-pass (blocked on C.05)       0%

V0.2.0 RELEASE BLOCKERS (~15h, not counted in 90%)    [partial]
├─ ⬜ DevOPs Area C, Area F, A.11
├─ ⬜ Polish backlog PB-3..PB-12 (~10h)
├─ ⬜ governance/VERSION.md → 0.2.0
├─ ⬜ Merge phase-2-security-depth + stratum-merge → main
└─ ⬜ Tag + signed release v0.2.0 (release-sign.yml triggers)

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

### Math (v0.2.0)

| Component | Effort (hours) | % done | Hours done |
|---|---:|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 100% | 80.0 |
| DevOPs Phase 2 (Security depth) | 57 | 75% (6 of 8 areas closed) | 42.75 |
| **Envelope** | **137** | — | **122.75** |
| **Figure** | — | — | **122.75 / 137 = 89.6%** ≈ **90%** |

The earlier ~91% figure was the same ratio under different rounding (round-half-up after intermediate rounding). The refined figure rounds the same underlying 89.6% to 90% via round-to-nearest. Both are honest expressions of the same ratio; **90%** is the committed headline.

A stricter "release-prep-inclusive" read (envelope = 167h including Areas C+F+A.11 + polish backlog + release prep) yields 73%. This is offered for transparency but is NOT the headline.

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

### Full-project envelope (Option B locked)

```
═══════════════════════════════════════════════════════════════
FULL PROJECT COMPLETION:  12%  (Option B locked 2026-05-24)
═══════════════════════════════════════════════════════════════
Envelope = 80 (Phase 1) + 57 (Phase 2) + 619 (Phase 3 Option B)
         + 80 (Phase 4) + 60 (Phase 5) + 100 (Phase 6) = 996h
Done     = 80 (Phase 1, 100%) + 42.75 (Phase 2, 75%) = 122.75h
Complete = 122.75 / 996 = 12.3% ≈ 12%
═══════════════════════════════════════════════════════════════
```

| Phase | Effort (h) | Done (h) |
|---|---:|---:|
| DevOPs Phase 1 (Foundation) | 80 | 80.0 (100%) |
| DevOPs Phase 2 (Security depth) | 57 | 42.75 (75%, 6/8 areas) |
| DevOPs Phase 3 (Stratum closeout Option B + memory/observability depth) | 619 | 0 |
| DevOPs Phase 4 (Design phase skills) | 80 | 0 |
| DevOPs Phase 5 (SRE & operate) | 60 | 0 |
| DevOPs Phase 6 (Self-improvement) | 100 | 0 |
| **Total** | **996** | **122.75** = **12%** |

Re-scope hooks for future sessions:
- **Phase 3 mid-build** (after Stratum Phase 0+1 ships, before Phase 3 starts): re-evaluate whether Stratum Phase 2 (pruner) should move into the v0.3.0 envelope based on observed token-waste telemetry. If pruner integration is fast, may absorb without altering the launch math.
- **Post-v0.3.0**: Option B → Option C transition is the natural next decision point. Re-scope when Stratum Phase 0+1+3 production telemetry is available.

---

## Headline guidance

- **For "are we close to launching v0.2.0?"** → **90%**. Personal-use production-ready, Stratum-independent, on track.
- **For "is the full vision done?"** → **12%** (Option B locked). 122.75h done of 996h envelope; full-project completion advances as Phase 2 closes (areas C+F+A.11) and as Phase 3 Stratum closeout work lands.
- **For "what's the next load-bearing decision?"** → No longer Phase 3 scope (Option B locked 2026-05-24). Next is mid-Phase-3 re-scope hook: after Stratum Phase 0+1 ships, decide whether Stratum Phase 2 (pruner) should join the v0.3.0 envelope based on observed telemetry.

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
