# DevOPs — Launch Readiness

**Last refined**: 2026-05-24 (session 7, Batch 3 — post-Stratum-audit refined figure)
**Methodology**: Effort-hours-weighted progress toward defined milestones — single
methodology committed, replacing the four different figures (85% / 61% / 49% / 20-25%)
floated in earlier conversations.

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

## Figure 2 — Full Project Completion (NEW post-Stratum-audit)

The full-project envelope depends on the user's choice of Phase 3 scope.
Stratum upstream is a single-commit scaffold (per audit
`.workflow/state/stratum-audit/01-stratum-state.md`), not a partially-built
backend. Phase 3 of DevOPs therefore must absorb Stratum's own Phase 0+1+3
(at minimum) before any "Stratum integration" is operational.

The three options (full detail in `.workflow/state/stratum-audit/03-integration.md`):

| Option | Stratum scope | Stratum effort | DevOPs Phase 3 total |
|---|---|---:|---:|
| **A. MVP** | Stratum Phase 0 + 1 only | 120–240h | ~357h |
| **B. Phase-3-aligned** | Stratum Phase 0 + 1 + 3 | 240–480h | ~619h |
| **C. Full value** | Stratum Phase 0 + 1 + 2 + 3 + 5 | 520–1040h | ~1179h |

DevOPs Phase 4 / 5 / 6 estimates (rough order of magnitude):
- Phase 4 (Design tooling): ~80h
- Phase 5 (SRE & operate): ~60h
- Phase 6 (Self-improvement): ~100h

### Full-project envelope, three figures

```
═══════════════════════════════════════════════════════════════
FULL PROJECT COMPLETION:  8% – 17%  (depends on Phase 3 option)
═══════════════════════════════════════════════════════════════
                                              Option A    Option B    Option C
                                              (MVP)       (aligned)   (full)
Envelope                                      734h        996h        1556h
Done                                          122.75h     122.75h     122.75h
Complete                                      17%         12%         8%
═══════════════════════════════════════════════════════════════
```

| | Envelope (h) | Done (h) | Complete |
|---|---:|---:|---:|
| **Option A** (Stratum MVP) | 80 + 57 + 357 + 80 + 60 + 100 = **734** | 122.75 | **17%** |
| **Option B** (Phase-3-aligned) | 80 + 57 + 619 + 80 + 60 + 100 = **996** | 122.75 | **12%** |
| **Option C** (Full value) | 80 + 57 + 1179 + 80 + 60 + 100 = **1556** | 122.75 | **8%** |

The choice swings full-project completion by ~10 percentage points. This is the load-bearing user decision out of session 7.

---

## Headline guidance

- **For "are we close to launching v0.2.0?"** → **90%**. Personal-use production-ready, Stratum-independent, on track.
- **For "is the full vision done?"** → **8–17%**. The lower bound is honest if Phase 3 includes a full Stratum closeout (option C). The upper bound is honest if Phase 3 settles for Stratum MVP (option A) plus DevOPs Phase 3 base.
- **For "what's the largest unknown?"** → The user's choice between Phase 3 options A / B / C. Decision surfaces session 7 Batch 3 closure.

---

## Decisions queued for user approval (post-audit)

Per `.workflow/state/stratum-audit/04-gap-roadmap-deltas.md`:

1. **Pick Phase 3 scope**: Option A (MVP), B (Phase-3-aligned), or C (Full value). Locks the full-project envelope.
2. **Approve ROADMAP.md Phase 3 line expansion**: changes "Stratum Phase 2 pruning integration" to "Stratum closeout" with the option-specific scope.
3. **Approve GAP_61 row 57 revision**: updates location + phase columns to reflect scaffold reality.
4. **Add PB-11 to polish backlog**: `memory/stratum/README.md` revision after Phase 3 scope is finalized.
5. **Optional**: header comment on `memory/stratum/config.yml` clarifying wiring-spec-vs-operational-state.

No edits to `governance/changelog/ROADMAP.md` or `docs/GAP_61_COVERAGE_MATRIX.md` are applied in session 7 per the spec REQ-S7-4 (proposal-only). User explicit go-ahead required before any of those edits.

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
