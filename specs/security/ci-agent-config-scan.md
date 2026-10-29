# CI scan of the agent settings

**Status**: draft

**Scope:** the `agent-config` job in `.github/workflows/security-scan.yml` and
`scripts/check-agent-config.mjs`. It reads `.claude/settings.json` and
`mcp-configs/**/*.json`, so a change to those files, or to `hooks/` scripts the
settings name, is checked on every pull request.

The Agile Graph engine pin (`scripts/agile-graph-pin-diff.mjs`) holds MCP tool-definition
hashes only, and its `security-scan` needs the engine package, which is not in the root
lockfile. This repository therefore carries a local, dependency-free rule set; it does not
add a dependency.

## REQ-1 — Broad permissions fail

**Enforced by:** job:.github/workflows/security-scan.yml#agent-config; test:tests/ci/agent-config-scan.test.mjs
WHEN `.claude/settings.json` allows a tool without a scope (a bare tool name, `*`,
`Tool(*)` or `Tool(**)`; a bare `mcp__server__tool` name is a single tool and is exempt) or sets `defaultMode` to `bypassPermissions`, THE JOB SHALL fail
unless a reviewed baseline entry names that finding.

## REQ-2 — Unpinned MCP servers fail

**Enforced by:** job:.github/workflows/security-scan.yml#agent-config; test:tests/ci/agent-config-scan.test.mjs
WHEN a server under `mcp-configs/` starts a package through `npx`, `bunx`, `pnpx` or
`uvx` without an exact `name@x.y.z` version (no version, a tag such as `latest`, or a
range), THE JOB SHALL fail unless a reviewed baseline entry names that finding.

## REQ-3 — Hooks must run reviewed files, and the baseline is the only exception

**Enforced by:** job:.github/workflows/security-scan.yml#agent-config; test:tests/ci/agent-config-scan.test.mjs
WHEN a command hook in `.claude/settings.json` runs no file under `hooks/`, names a
`hooks/` file that does not exist, or fetches or pipes into a shell, THE JOB SHALL fail
unless a reviewed baseline entry names that finding. IF an input file, or the baseline file, is missing or malformed THEN
the checker SHALL exit 2 rather than pass. A finding is named in
`governance/agent-config-baseline.json` as `rule:file:detail`; adding a key is a reviewed
change (CODEOWNERS), and fixing the finding is preferred.

The hook rule is a mention check, not a parser: a command that names an existing `hooks/` file and does not fetch or pipe into a shell passes, even if it also runs other commands. The single baselined hook is the SessionStart `runtime/scripts/session-start-context.ts` tsx hook in `.claude/settings.json`; its key embeds a hash of the full command, so any edit to it fails the job until the entry is re-reviewed. Every future hook that runs a repository script outside `hooks/` needs a baseline entry, by design.
