# Slash Commands

User-invoked commands available in supported tools.

| Command | Skill invoked | Purpose |
|---------|---------------|---------|
| `/checkpoint` | baton-handoff | Write session baton for handoff |
| `/resume` | (reads baton) | Resume from last session |
| `/security-scan` | security subagent | Run tiered security scan |
| `/verify-claims` | claim-validator | Re-run all proofs |
| `/session-summary` | session-summary | Generate human-reviewable report |
| `/threat-model` | owasp-asi-threat-model | Produce STRIDE+ASI model |
| `/ears-spec` | ears-spec-writing | Author EARS spec |
| `/analyze` | analyzer/scan.ts | Re-detect project stack |

## Tool support

| Tool | Slash command support |
|------|----------------------|
| Claude Code | native via `.claude-plugin/plugin.json` |
| Codex CLI | native (since v0.42) |
| Cursor | partial (via cursorrules) |
| Antigravity | native |
| Kiro | native (steering files map to commands) |

For tools without native slash commands, invoke the underlying skill by name.
