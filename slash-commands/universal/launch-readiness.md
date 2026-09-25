---
name: launch-readiness
description: Produce the canonical launch-readiness tables derived only from blueprint.md, plan.md, docs/LAUNCH_READINESS.md, .workflow/state files and live git/gh output. Use when the user asks for status, launch readiness, where the project stands, or a progress report. --short gives the version roadmap and headline summary; --diff adds what changed since the last LR refresh.
---

# /launch-readiness

**Type**: Universal slash command
**Purpose**: Generate the canonical launch-readiness table set from markdown source-of-truth. Never fabricate; always derive.
**Source-of-truth**: `blueprint.md` §11.1 (anti-fabrication rule)
**Invocation**: `/launch-readiness` (no args) — produces full table set; the `--short` and `--diff` variants are described under Examples below.

---

## What this command does

Reads the following files in order and assembles the canonical launch-readiness table set:

1. **`blueprint.md`** — §3 (scope), §5 (version sequencing), §6 (quality bar)
2. **`plan.md`** — §11 (version envelope math), §10b (per-version recurring tasks), §12 (external integrations registry)
3. **`docs/LAUNCH_READINESS.md`** — current status snapshot + historical context
4. **`.workflow/state/polish-backlog.md`** — open/closed PB items (gitignored; local-truth-of-record)
5. **`.workflow/state/baton.md`** — latest session closure entry
6. **`.workflow/state/session-handoff.md`** — operational rules + carry-forward
7. **`git rev-parse HEAD`**, **`git tag --list`**, **`git branch -a`** — branch + tag reality
8. **`gh pr list --state all --limit 10`** — recent PR merge history
9. **`npm run validate:claims -- --all`** (optional, if requested) — current validator state

## Output format (canonical)

Nine tables in this order:

### 1. Version roadmap

| Version | Theme | Status | Hours done | Hours remaining | Progress | Ship gate |
|---|---|---|---:|---:|---:|---|

Cite source: `plan.md §11`.

### 2. Session-N idea-additions (if applicable)

| Pattern / Integration | Source | Lands in | Effort | Notes |
|---|---|---|---:|---|

Cite source: `plan.md §12` + most recent baton.md "Idea-additions round" subsection.

### 3. Polish backlog state

| PB | Status | Notes |
|---|---|---|

Cite source: `.workflow/state/polish-backlog.md`.

### 4. Validator state

| Metric | Value |
|---|---:|

Cite source: `npm run validate:claims -- --all` output OR last-known state recorded in baton.md.

### 5. Branch matrix

| Branch / Ref | SHA | Status |
|---|---|---|

Cite source: `git rev-parse <ref>` per row.

### 6. Recent PR history

| PR # | Title | Status | Merged at |
|---:|---|---|---|

Cite source: `gh pr list --state all --limit 10`.

### 7. Open carry-forward (non-blocking)

| Item | Triggered when | Effort |
|---|---|---:|

Cite source: `plan.md §10a`.

### 8. Pre-flight blockers for next version's kickoff

| Decision | Owner | Status |
|---|---|---|

Cite source: `plan.md §0` open questions OR latest session-handoff "Session N+1 entry point" subsection.

### 9. Headline summary

Three short paragraphs:
- **Where we are** (current version % progress + total envelope math)
- **What's next** (next version's first 2-3 work items)
- **Quality bar** (one-line reminder of standing rules)

---

## Anti-fabrication rule (binding)

**Absolute discipline**:

- **If a number isn't in the .md sources, surface that gap explicitly** ("not yet recorded in LR — refresh required"). Never invent.
- **Effort estimates** cite their source line in `plan.md`.
- **Validator counts** cite either live `validate:claims --all` output OR, for a claim that fails, the exception recorded for it in `.workflow/state/polish-backlog.md` or `plan.md` (name the claim and cite that entry).
- **Polish-backlog status** cites `.workflow/state/polish-backlog.md` even though gitignored (it is the local record of truth).
- **Branch matrix** cites `git rev-parse` / `git ls-remote` outputs, not memory.
- **PR history** cites `gh pr list` / `gh pr view` outputs, not memory.

**On disagreement between sources**: surface the conflict explicitly. Do not auto-resolve. Example: if plan.md §11 says ~644h remaining but LR says ~570h, the report shows BOTH numbers + labels the discrepancy + recommends which file to update.

---

## Refresh triggers (when LR file itself is updated)

The slash command produces the table from current sources. The underlying `docs/LAUNCH_READINESS.md` file is refreshed at:

1. Every version ship (v0.x.0 tag cut)
2. Every PR merge that adds, removes, or re-estimates `plan.md` tasks
3. Every Ideas → Artifacts iteration that adjusts envelope (per blueprint.md §11)
4. On explicit user request
5. Every session-end as part of the per-version recurring tasks (`plan.md §10b`)

When LR is refreshed via PR, the PR title is `Session N — LR refresh (post-<event>)` and the squash-merge SHA gets recorded in baton.md.

---

## Examples

### Full report

```
/launch-readiness
```

Produces all 9 tables above.

### Short report

```
/launch-readiness --short
```

Produces only the Version roadmap + Headline summary.

### Compare-to-last-snapshot

```
/launch-readiness --diff
```

Produces the canonical tables + a "What changed since last LR refresh" diff section showing version-progress deltas, new PB closures, validator state shifts.

---

## Why this exists

The user's standing instruction: "you will always track that from md. add the tracking to this projects development workflow."

This command fixes both the format and the discipline (anti-fabrication, derivation from the markdown sources), so every session and every contributor who installs the plugin produces the same status tables.

Companion docs:
- `blueprint.md` §11.1 — strategic framing
- `plan.md §0` — standing-rule reference
- `CLAUDE.md` — Claude Code session-start binding
