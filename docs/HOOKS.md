# Hooks Reference

Deterministic safety layer. Hooks fire on the tool calls Claude Code sends them, whatever the
agent intends.

Guarded: the agent cannot change its own gates or approvals. `protect-gates.sh` blocks the
agent's Write, Edit, MultiEdit and NotebookEdit calls on `.claude/settings.json`,
`.claude/settings.local.json`, anything under `.claude/hooks/`, `.workflow/state/approvals.jsonl`,
`.workflow/state/install-manifest.json` and anything under `.workflow/state/originals/`. It resolves
the path first (a relative path from the project root, a leading `~`, symlinks, `..`, and letter
case on macOS and Windows). `protect-gates-bash.sh` blocks a Bash command that names one of those
paths: a relative form such as `.claude/settings.json` or `.claude/hooks`, a token that resolves to
one, or a bare `approvals.jsonl`, `settings.json`, `settings.local.json` or `install-manifest.json`.
It lets the command through only when it is a plain read: the first word is `cat`, `head`, `tail`,
`less`, `grep`, `rg`, `ls`, `stat`, `wc` or `diff`, or `jq` with no `-i`, or the command is
`git status` (`git diff`, `log` and `show` can write with `--output` or run a configured
external diff, so they are not plain reads; nor is `rg --pre`); and the command has no `>`, `|`, `;`, `&`,
parentheses, backtick, `$(` or newline. Reads by a file tool are not guarded.

Not guarded, and the Bash check is only a heuristic: a Bash command that builds one of these paths
at run time (a variable, a glob, an interpreter that writes the file without naming it) gets past
it. Any other path the agent can write is outside these hooks. Write approvals in
`.workflow/state/approvals.jsonl` yourself, outside the agent, and keep the agent from writing it.

## Wiring into Claude Code

Claude Code runs a hook only when `.claude/settings.json` names it. `devops init`
copies the hooks to `.claude/hooks/` and merges an entry into `.claude/settings.json`
for each hook it can wire (specs/release/npm-package.md REQ-15, AC-27). It keeps every
other key and hook in that file, never adds an entry whose command is already there,
and records what it added in the install manifest, so `devops uninstall` removes only
those entries.

A pre or post hook is named as

    node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/run-hook.mjs" <pre|post> <hook-file> <stdin|command|file>

`run-hook.mjs` (from `hooks/claude-code/run-hook.mjs`, copied beside the hooks) reads the
tool call that Claude Code sends on stdin and gives the hook the input it takes:

- `stdin`: the hook gets `--payload-stdin` and the raw payload bytes;
- `command`: the hook gets `tool_input.command` as one argument;
- `file`: the hook runs once for each distinct non-empty one of `tool_input.file_path`,
  `tool_input.notebook_path`, `tool_input.path` and `tool_response.filePath`, with that string as
  its one argument. For `pre`, the first non-zero result decides.

A call whose field is absent or empty has nothing to check: the runner exits 0 without
running the hook. The runner is Node only, with no dependencies, and runs each hook with
`bash` and no shell, so the argument is never parsed by one. It runs only the hook names
in its own allowlist.

For `pre` hooks, exit 0 passes and exit 2 blocks. Any other outcome fails closed with
exit 2 and `failing closed` on stderr: a non-zero exit other than 2, a signal, a missing
hook, unparseable stdin, or a project root that cannot be resolved (`CLAUDE_PROJECT_DIR`,
else the git top level). Each `pre` command in `.claude/settings.json` ends in `|| exit 2`,
so a `node` missing from Claude Code's PATH, or a runner that cannot start, also blocks the
call instead of exiting with a code Claude Code lets through. For `post` hooks the exit is always 0, and a non-zero hook exit
is printed to stderr; the exception is `gitleaks-scan.sh`, whose exit 2 passes through
so Claude Code shows the leak.

| Hook | Event | Matcher | Input |
|------|-------|---------|-------|
| `deploy-gate.sh` | `PreToolUse` | `Bash` | stdin |
| `block-sealed-refs.sh` | `PreToolUse` | `Bash` | stdin |
| `block-prod-write.sh` | `PreToolUse` | `Bash` | command |
| `block-rm-rf.sh` | `PreToolUse` | `Bash` | command |
| `block-new-dependency.sh` | `PreToolUse` | `Bash` | command |
| `block-secrets.sh` | `PreToolUse` | `Read\|Write\|Edit\|MultiEdit\|NotebookEdit` | file |
| `protect-gates.sh` | `PreToolUse` | `Write\|Edit\|MultiEdit\|NotebookEdit` | file |
| `protect-gates-bash.sh` | `PreToolUse` | `Bash` | command |
| `gitleaks-scan.sh` | `PostToolUse` | `Write\|Edit\|MultiEdit` | file |
| `load-baton.sh` | `SessionStart` | none | (plain command) |

`load-baton.sh` is named as `cd "${CLAUDE_PROJECT_DIR:-.}" && bash .claude/hooks/load-baton.sh || true`
and has no matcher. The `cd` makes it read the project root's baton, and create `.workflow/` only there.

Every other copied hook is named by `devops init` with its reason and is not wired:

- `budget-brake.sh`: needs a per-call cost estimate that Claude Code does not give.
- `loop-detection.sh`: needs a tool name and arguments; not wired until it is tested with real payloads.
- `auto-format.sh`: opt-in: it rewrites files.
- `sync-lr-refined-date.sh`: edits `docs/LAUNCH_READINESS.md`, which only this repository has.
- `client-boundary.sh`: not registered by default.
- `external-content-boundary.sh`: its HMAC check needs the session key from `rotate-session-key.sh`, which is not wired.
- `rotate-session-key.sh`: rotates the session key that `external-content-boundary.sh` checks; not wired while that hook is not.
- `write-baton.sh`: overwrites a hand-written baton; write it with `/checkpoint` instead.
- `graph-preflight.sh`: part of the Agile Graph pipeline, which the npm package excludes.

To wire another hook by hand, add its entry to `.claude/settings.json` in the same
format, and only after you have made sure the hook gets the input it needs (for a
pre or post hook, through `run-hook.mjs`). This repository's own `.claude/settings.json`
is a working example.

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
| `block-new-dependency.sh` | New-dependency gate | npm/pnpm/yarn/bun, pip/uv/poetry or `cargo add` of a name not declared in the project manifest |

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
