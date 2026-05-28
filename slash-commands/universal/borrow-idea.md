---
name: borrow-idea
description: Research a URL / repo / feature and propose blueprint+plan delta with version assignment + effort estimate, per Ideas → Artifacts workflow (blueprint.md §11). User-only invocation (has side effects: writes a proposal file under .workflow/state/integration-proposals/). The proposal is then applied by user-explicit follow-up.
disable-model-invocation: true
---

# /borrow-idea

Formalizes the **Ideas → Artifacts workflow** established Session 14 (blueprint.md §11 + plan.md §13).

## Usage

```
/borrow-idea <url-or-feature-description>
```

Examples:

```
/borrow-idea https://github.com/<owner>/<repo>
/borrow-idea Claude Code just shipped /security-review
/borrow-idea what if we added a queue-based extractor for Phase 3?
```

## What this command does

1. **Spawns the `integrations-curator` subagent** (`subagents/universal/integrations-curator.md`) with the given input as its research target.
2. The subagent executes the 7-step loop:
   - Research the source (`gh repo view` for GitHub; WebSearch for features; read README + LICENSE)
   - Synthesize borrow / integrate / reject / defer recommendation with explicit reasoning
   - Version-assign (pick the version where it ships)
   - Effort estimate (honest range; cite source)
   - Propose blueprint.md + plan.md diffs
   - Add ADR placeholder name
   - Surface open questions
3. **Writes the proposal** to `.workflow/state/integration-proposals/<timestamp>-<slug>.md`
4. **Outputs a one-paragraph summary** + path to full proposal
5. **Waits for user confirmation** before applying any changes to blueprint.md / plan.md / LR

## Anti-fabrication rule (binding per blueprint §11.1)

- Every claim cites source (URL line + author OR `gh` output OR `WebSearch` result)
- No vague version assignment — "eventually" is forbidden
- No silent envelope bloat — every proposal updates `plan.md §11` math explicitly
- For Anthropic first-party tools: default to **integrate**, not replace
- For external repos: borrow patterns/ideas, not code (license + maintenance reasons)

## Discipline rules (per blueprint §11)

- Each proposal stands alone — no implicit dependencies on other proposed-but-not-applied integrations
- If a new integration would push v1.0.0 past 24 months part-time, surface the timeline impact and ask explicitly whether to defer
- Cite source repo + license in the proposal
- Add ADR placeholder so future code lands with documented rationale

## Output format

The subagent writes a structured Markdown proposal:

```markdown
# Integration proposal: <name>

**Source**: <URL>
**License**: <MIT/Apache/etc>
**Recommendation**: BORROW pattern / INTEGRATE / REJECT / DEFER
...
## Version assignment
**Lands in**: v0.X.x
## Effort estimate
**Range**: ~Xh - ~Yh
## Proposed blueprint.md diff
...
## Proposed plan.md diff
...
## Envelope math impact
**Current to v1.0.0**: ~Nh
**After this integration**: ~(N+Z)h
## Open questions for user
...
```

The full template is in `subagents/universal/integrations-curator.md`.

## After running the command

User reviews the proposal. To apply:

```
"apply the proposal at .workflow/state/integration-proposals/<file>"
```

Then I'll:
- Apply the blueprint.md + plan.md diffs verbatim from the proposal
- Add the ADR placeholder to `governance/decisions/`
- Update the External integrations registry (`plan.md §12`)
- Update `docs/LAUNCH_READINESS.md` envelope math
- Open a PR per PB-17 Option β

## When to NOT use this command

- For implementation work (use `/ears-spec` + relevant subagents)
- For status reporting (use `/launch-readiness`)
- For dispute resolution between sources (escalate to user directly)

## Cross-references

- `blueprint.md §11` — Ideas → Artifacts workflow (strategic frame)
- `blueprint.md §11.1` — canonical reporting + anti-fabrication
- `plan.md §13` — workflow doc (mirror)
- `plan.md §12` — external integrations registry
- `subagents/universal/integrations-curator.md` — autonomous executor
