# Hooks Reference

Deterministic safety layer. Hooks fire on the tool calls Claude Code sends them, whatever the
agent intends.

Guarded: the agent cannot change its own gates or approvals. `protect-gates.sh` guards the
agent's Write, Edit, MultiEdit and NotebookEdit calls on `.claude/settings.json`,
`.claude/settings.local.json`, anything under `.claude/hooks/`, `.workflow/state/approvals.jsonl`,
`.workflow/state/install-manifest.json` and anything under `.workflow/state/originals/`. It compares
file identity, not spellings. Only an absolute path is accepted: a relative path, or one that starts with
`~`, exits 2 with `is not an absolute path`, because the file tools take absolute paths. The target is
resolved the way the kernel does: the deepest existing part of the path is resolved with `realpath`, so
symlinks and `..` count. It then blocks the call when the target is one of those files by `{dev, ino}`,
so a symlink or a hard link to one is caught too; when it is under one of those directories, with the
last component left unresolved as well, so a symbolic link inside a protected directory counts as inside
it even when it points out; when it is the same file (`{dev, ino}`) as an entry under one of those
directories, so a hard link to a hook or an original is caught; when it is at or under the real path a
symbolic link inside one of those directories points to, existing or not, so a link to a directory
protects files not yet made there and a dangling link protects its missing target; or when it is a file
or directory that does not exist yet under an existing directory with the same identity and name. The
walk of a protected directory follows real directories only (a symbolic link is one entry, so a linked
tree or a loop costs nothing; links nested inside a linked tree are not followed), goes eight levels deep and no further, and stops after 5000 entries;
past either limit the call exits 2, and the message says what to move out. Names fold the same way on
every platform: NFD, U+017F as `s`, and upper then lower case. The names are ASCII, so folding refuses
little that is not a gate. An error other than a missing path component exits 2.

`protect-gates-bash.sh` is a convenience guard, not a security boundary, and owner approvals must not
rely on it. It reads the command text only, and nothing on disk. It blocks a command when the text,
with `'`, `"` and `\` deleted, contains one of these paths: `.claude/settings.json`,
`.claude/settings.local.json`, `.claude/hooks`, `.workflow/state/approvals.jsonl`,
`.workflow/state/install-manifest.json` or `.workflow/state/originals` (folded on every platform, as the
file-tool check folds them). It also blocks a command with a `mv`, `rm`, `cp`, `ln`, `tar` or `rsync` word and a bare
`.claude`, `.workflow` or `.workflow/state` word. It lets a command through when it is a plain read:
the first word is `cat`, `head`, `tail`, `less`, `grep`, `ls`, `stat`, `wc`, `diff` or `jq`, or the
command is `git add`, `git commit` or `git status`; and outside quotes the command has no `>`, `|`,
`;`, `&`, parentheses, backtick, `$(` or newline, except `2>&1` and a trailing pipe into `head`,
`tail`, `wc`, `grep` or `sort`. `sort` is allowed in that pipe only without `-o`, `--output` or
`--compress-program`. `less` is a plain read only without `-o`, `-O`, `--log-file`, `+cmd`, `-k` or `--lesskey`, which
write a file or run a program.

Not caught, so the Bash check does not stop these:
- a `cd` into `.claude` or `.workflow/state`, then a relative write such as `echo x > hooks/a.sh`,
  in the same call or a later one, since the shell keeps its directory between calls;
- a path spelled with an extra `/` or a `.` component, such as `.claude//settings.json` or
  `.claude/./settings.json`, since the text match looks for the plain spelling;
- a path built at run time: a variable (`D=.claude; echo x > $D/settings.json`), a glob, or a
  command substitution in a word that names no gate;
- an interpreter or program that writes a file without naming it (`node -e`, `python -c`, a script);
- `git status` running a `core.fsmonitor` program, and `git add` or `git commit` running a filter or
  a hook, when `.git/config` or a hook is one the agent wrote (neither is guarded);
- any other tool call, and any path outside the list above.

Write approvals in `.workflow/state/approvals.jsonl` yourself, outside the agent, and keep the agent
from writing it.

## Wiring into Claude Code

Claude Code runs a hook only when `.claude/settings.json` names it. `devops init`
copies the hooks to `.claude/hooks/` and merges an entry into `.claude/settings.json`
for each hook it can wire (specs/release/npm-package.md REQ-15, AC-27). It keeps every
other key and hook in that file, never adds an entry whose command is already there,
and records what it added in the install manifest, so `devops uninstall` removes only
those entries.

A settings.json rewrite keeps what the user wrote. Init and uninstall write the file through a temp file they create exclusively under a unique name, so a `.claude/settings.json.tmp` the user already has is never read, overwritten or removed. The file keeps its indentation (a tab, or the spaces of its first indented line; 2 spaces for a new file or one with no indented line) and its trailing newline. A settings.json holding an integer above 2^53 is left unchanged with a warning, because JSON would round the number. Uninstall deletes an event array, or the `hooks` object, only when init created it and uninstall's removal emptied it; an empty array that was there before init stays (specs/release/npm-package.md AC-27, #426).

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

A payload with no `tool_input` (or a `null` one) is a missing field, not an empty call. For a
`pre` hook the runner writes one line to stderr, `HOOK: warning: tool_input is missing from the
tool call; <hook> runs without it`. A `command` or `file` hook reads `tool_input`, so for those the
call fails closed with exit 2 and `HOOK: tool_input is missing from the tool call -- failing closed`,
and the hook does not run. A `stdin` hook reads the raw payload itself, so it runs after the warning.
A `tool_input` that is present but not an object fails closed for a `pre` hook in every input mode. A
`post` hook always exits 0, so it never fails closed.

For `pre` hooks, exit 0 passes and exit 2 blocks. Any other outcome fails closed with
exit 2 and `failing closed` on stderr: a non-zero exit other than 2, a signal, a missing
hook, unparseable stdin, a missing or non-object `tool_input` (for a `command` or `file` hook),
or a project root that cannot be resolved (`CLAUDE_PROJECT_DIR`,
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
failed-extraction limits. Plain marker authenticity and broader tool coverage remain separate
MR-5/MR-4 work.

## Adding hooks

See `CONTRIBUTING.md`. Hooks must:
- Exit cleanly (no hangs)
- Complete in < 500ms p99
- Log to `.workflow/state/events.jsonl`
- Be idempotent

## Platform requirements

The `.sh` hooks under `hooks/` and `scripts/` use a Bash shebang
(`#!/usr/bin/env bash`) and POSIX shell semantics. They require a POSIX
shell (bash), which macOS and Linux provide natively. Configure Claude
Code (or the active agent) to invoke the hooks with `bash <hook>.sh`.
