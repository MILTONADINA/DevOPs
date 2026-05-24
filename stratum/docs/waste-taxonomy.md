# waste-taxonomy.md — Token Waste Categories

> **Phase 0 Deliverable.** This file must be filled in from real session data before Phase 1 begins.
> Template is pre-populated with hypothesized categories. Replace with what you actually observe.

---

## Instructions

After capturing at least 5 real Claude Code sessions using `scripts/capture-session.ts`, open each JSON file and manually inspect the message arrays. For each request, ask:

- Which tokens are directly relevant to answering the current query?
- Which tokens are present purely because of how the context window accumulates?
- Which tokens are structurally required (system prompt, tool definitions) vs. noise?

Fill in the table below with what you actually find.

---

## Observed Waste Categories

### Category 1: System Prompt Repetition

**Hypothesis:** The full system prompt (tool definitions, behavioral instructions) is re-sent on every turn, even when tools haven't changed.

**Observed in sessions:** <!-- list session IDs -->

**Estimated % of total tokens:** <!-- fill in -->

**Example (anonymized):**
```
<!-- paste a representative example from your captured sessions -->
```

**Notes:**
<!-- Is it actually the same bytes every time, or does it vary? -->
<!-- How many tokens is the average system prompt? -->

---

### Category 2: Tool Output Echo

**Hypothesis:** Tool call results (e.g., file contents, bash output) are echoed back in full on subsequent turns, even when only a small subset is relevant to the current query.

**Observed in sessions:** <!-- list session IDs -->

**Estimated % of total tokens:** <!-- fill in -->

**Example:**
```
<!-- paste example -->
```

**Notes:**
<!-- Are tool outputs typically short (bash exit codes) or long (file reads)? -->
<!-- What's the longest single tool output you observed? -->

---

### Category 3: Stale File Contents

**Hypothesis:** When Claude Code reads a file, the full file contents are injected into context and remain there for many subsequent turns, even after the developer has moved on to different files.

**Observed in sessions:** <!-- list session IDs -->

**Estimated % of total tokens:** <!-- fill in -->

**Notes:**
<!-- How many turns does file content typically persist? -->
<!-- Is it re-injected fresh each turn or carried over? -->

---

### Category 4: Repetitive Conversation History

**Hypothesis:** Older turns in the conversation are carried verbatim through every subsequent request, even when they have no bearing on the current query.

**Observed in sessions:** <!-- list session IDs -->

**Estimated % of total tokens:** <!-- fill in -->

**Notes:**
<!-- At what turn count does this become significant? -->
<!-- Does the pattern differ between short bug-fix sessions and long feature sessions? -->

---

### Category 5: Redundant Reasoning Traces

**Hypothesis:** Claude Code's extended thinking / chain-of-thought is sometimes included in the context window of subsequent turns, consuming tokens for reasoning that is no longer relevant.

**Observed in sessions:** <!-- list session IDs -->

**Estimated % of total tokens:** <!-- fill in -->

---

### Category 6: [Add your own observed categories]

**Description:**

**Observed in sessions:**

**Estimated % of total tokens:**

---

## Summary Table

| Category | Avg % of tokens | Frequency | Priority |
|---|---|---|---|
| System prompt repetition | | | |
| Tool output echo | | | |
| Stale file contents | | | |
| Repetitive conversation history | | | |
| Redundant reasoning traces | | | |
| (your category) | | | |

## #1 Waste Type

> **The single biggest source of token waste in Claude Code sessions is:**
> <!-- Fill this in. This becomes the first heuristic in Phase 1. -->

---

## Raw Session Statistics

| Session ID | Date | Total tokens | Estimated useful tokens | Waste % |
|---|---|---|---|---|
| session-001 | | | | |
| session-002 | | | | |
| session-003 | | | | |
| session-004 | | | | |
| session-005 | | | | |
| **Average** | | | | |

---

## Implications for Phase 1 Measurement Proxy

Based on the observed taxonomy, the Phase 1 proxy should detect and label:

<!-- List the 2-3 most impactful waste categories to measure first -->
<!-- These become the "waste heuristics" in src/proxy/heuristics/ -->

1.
2.
3.
