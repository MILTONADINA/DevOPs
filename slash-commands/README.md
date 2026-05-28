# Slash Commands

User-invoked commands available in supported tools.

## DevOPs slash commands

| Command | Skill invoked | Purpose |
|---------|---------------|---------|
| `/checkpoint` | baton-handoff | Write session baton for handoff |
| `/resume` | (reads baton) | Resume from last session |
| `/security-scan` | security subagent | Run tiered security scan (gitleaks + semgrep + threat-model-validity) |
| `/verify-claims` | claim-validator | Re-run all proofs across claim corpus |
| `/session-summary` | session-summary | Generate human-reviewable report |
| `/threat-model` | owasp-asi-threat-model | Produce STRIDE + OWASP ASI 2026 threat model |
| `/ears-spec` | ears-spec-writing | Author EARS-formatted spec |
| `/analyze` | analyzer/scan.ts | Re-detect project stack |
| `/launch-readiness` | launch-readiness | Produce canonical LR table from markdown source-of-truth |
| `/borrow-idea` | integrations-curator | Research URL/repo → propose blueprint+plan delta with version + effort |
| `/emit-claim` | (claim ritual) | Wrap spec → check → log → YAML → validator → commit ritual for cleaner claim emission |

## Coexistence with Anthropic Claude Code built-in slash commands

Claude Code ships native slash commands (`/code-review`, `/security-review`, `/help`, `/clear`, `/model`, etc.). DevOPs slash commands COMPLEMENT — they do not collide with — the built-ins. Surface check confirmed Session 15 (plan.md §2f Task 3, ADR-014):

| Built-in (Anthropic) | DevOPs counterpart | Relationship |
|---|---|---|
| `/code-review` | (no DevOPs equivalent) | No collision. Anthropic's `/code-review` is the canonical author pre-flight for diff correctness; DevOPs does not duplicate it. Documented in `CONTRIBUTING.md` § "Per-PR review checklist". |
| `/security-review` | `/security-scan` | **Different names, complementary functions, no collision.** `/security-review` (Anthropic) runs AI-powered semantic analysis of the current diff. `/security-scan` (DevOPs) runs the tiered local scan stack (gitleaks for secrets, semgrep for static issues, `threat-model-validity` for custom OWASP-ASI lint). Layered defense: pattern-matching floor (DevOPs) + semantic ceiling (Anthropic). Both ship side-by-side; reviewers run both. |
| `/help`, `/clear`, `/model`, `/fast`, etc. | (none) | Anthropic CLI ergonomics; no DevOPs overlap. |

**No DevOPs slash command shadows or overrides an Anthropic built-in.** Tab-completion on `/sec...` surfaces both `/security-scan` (DevOPs) and `/security-review` (Anthropic) — this is intentional surface visibility, not a defect. Users running on platforms WITHOUT native Claude Code slash commands (Cursor, partial-support platforms) lose access to the Anthropic built-ins but still have the DevOPs commands via the underlying skill invocation.

### When the surfaces would collide (forward-looking)

If a future Anthropic Claude Code release introduces `/verify-claims`, `/threat-model`, `/launch-readiness`, `/emit-claim`, or any other name in the DevOPs command list above, the convention is:

1. Rename the DevOPs command (e.g., `/threat-model` → `/threat-model-stride-asi`).
2. Update this README, `.claude-plugin/plugin.json`, and the spec/ADR that anchors the renamed command.
3. Add a CHANGELOG entry under the appropriate version.
4. Preserve the renamed-from path as a backwards-compatible alias for one minor version (e.g., v0.X.0 introduces alias; v0.(X+2).0 removes it).

Re-verification trigger: re-run this surface check at every new Claude Code release that ships new slash commands. Anthropic publishes built-in commands at https://docs.anthropic.com/en/docs/claude-code/slash-commands.

## Tool support

| Tool | Slash command support |
|------|----------------------|
| Claude Code | native via `.claude-plugin/plugin.json` |
| Codex CLI | native (since v0.42) |
| Cursor | partial (via cursorrules) |
| Antigravity | native |
| Kiro | native (steering files map to commands) |

For tools without native slash commands, invoke the underlying skill by name.
