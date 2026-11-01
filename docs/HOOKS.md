# Hooks Reference

Deterministic safety layer. Hooks fire regardless of agent intent. Cannot be
disabled by the agent.

## Universal hooks

### Pre-tool (fire before every tool call)

| Hook | Purpose | Blocks on |
|------|---------|-----------|
| `budget-brake.sh` | Hard USD ceiling with reserve-commit | Session/hour/day cap exceeded |
| `loop-detection.sh` | Repetition + stasis detection | Same call N times OR scratchpad stasis |
| `block-secrets.sh` | File access blocklist | Sensitive paths (.env, .pem, ssh) |
| `block-prod-write.sh` | Production write blocker | git push main, kubectl prod, terraform apply without approval |
| `block-rm-rf.sh` | Destructive command blocker | rm -rf outside whitelisted paths |
| `client-boundary.sh` | Cross-project access blocker | Read/Write/Edit/MultiEdit/NotebookEdit (writes) and Glob/Grep/LS/NotebookRead (reads) tool paths (every path field checked; leading `~` expanded with `HOME`, `~user` blocked; normalised, symlinks resolved) outside the project root, unless equal to or under a global read-only entry (reads only) or a `.workflow/client/path-allowlist.txt` line. Not registered by default (installed copy: `.claude/hooks/client-boundary.sh`); Bash commands are not inspected; the read-only list includes `$HOME/.cache/`, which can hold other projects' checkouts; only `file_path`, `path` and `notebook_path` are checked (a Glob `pattern` without `path` and a Grep `glob` are not); the allowlist and event log sit inside the root and are agent-writable; relative paths resolve against the project root. Every failure exits 2. See [PLAYBOOK](PLAYBOOK.md#multi-client-setup) |

### Post-tool (fire after every file write)

| Hook | Purpose |
|------|---------|
| `auto-format.sh` | Run biome/prettier/ruff/rustfmt/gofmt/shfmt |
| `gitleaks-scan.sh` | Detect secrets in just-written file |

### Session-start

| Hook | Purpose |
|------|---------|
| `load-baton.sh` | Read baton if recent, print status, verify profile |

### Session-end

| Hook | Purpose |
|------|---------|
| `write-baton.sh` | Compose handoff document |

## Graph Bash hooks

Actual registration determines which hooks run; see the
[DevOPs repository's `CLAUDE.md`](https://github.com/MILTONADINA/DevOPs/blob/main/CLAUDE.md) for that repository's own wiring. The graph's `deploy-gate.sh` and
`block-sealed-refs.sh` implement the finite literal-command policy in
[REQ-M16](../specs/graph/M-masterpiece-standard.md). The first checks scoped halt
and deploy authority; the second protects the exact sealed tag/branch identities.
Ordinary diagnostics and inert text remain available during halt. A marker
does not override halt or sealed-ref protection.

Ordinary non-force pushes using `--tags`, `--follow-tags` or `--all` require
deploy approval. The sealed-ref hook does not enumerate their implicit
destinations. Forced bulk or mirror ambiguity is refused, and an explicit
protected right-hand refspec destination stays blocked. This compatibility
policy does not mediate every implicit Git mutation.

Only a bare pushed NAME receives the branch exception after local lookup proves
a branch exists and no same-named tag exists. A colon refspec requires an
explicit `refs/heads/` right-hand destination for ordinary admission; otherwise
it is deploy-gated, even if a local branch has that name. The independent sealed
hook still refuses an explicit protected destination.

These two hooks require Node (the repository supports `>=22.12.0`) and an adjacent
`graph-command-classifier.mjs`. Selecting either graph hook through
`analyzer/install.ts` copies its required companion to `.claude/hooks/`; a
missing companion fails installation. Missing/unrunnable helpers and invalid
responses refuse hook invocation. Dry-run writes nothing to the target.
Installing the files does not register them with every agent or tool.

Arbitrary script contents, aliases/functions and generated programs are outside
this parser. The current JSON wrappers retain malformed/nonstring-input and
failed-extraction limits. Plain marker authenticity, protected file-tool paths
and broader tool coverage remain separate MR-5/MR-4/MR-6 work.

## Adding hooks

See `CONTRIBUTING.md`. Hooks must:
- Exit cleanly (no hangs)
- Complete in < 500ms p99
- Log to `.workflow/state/events.jsonl`
- Be idempotent

## Platform requirements

The `.sh` hooks under `hooks/` and `scripts/` use a Bash shebang
(`#!/usr/bin/env bash`) and POSIX shell semantics. They require a POSIX
shell (bash/zsh), which macOS and Linux provide natively. Configure Claude
Code (or the active agent) to invoke the hooks with `bash <hook>.sh`.
