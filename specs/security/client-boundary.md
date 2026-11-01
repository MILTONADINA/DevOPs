# Client boundary hook

**Scope:** `hooks/universal/pre-tool/client-boundary.sh`, the PreToolUse hook
that keeps file tools inside the current project root. It is not registered
by default (see `docs/PLAYBOOK.md`, Multi-client setup). Bash commands are not
inspected. A call with no `tool_name` is treated as operation `access`, so the
read-only global list does not apply to it. Only `tool_input.file_path`,
`path` and `notebook_path` are inspected: a Glob `pattern` without a `path`
and a Grep `glob` are not. The allowlist and the event log live inside the
root, so the agent can write them. Relative paths resolve against the project
root (the hook's working directory), not the session's cwd. The global
read-only list includes `$HOME/.cache/`, which can hold other projects'
checkouts; reads there are allowed (a known exposure, not changed here).

**Status**: implemented

## REQ-1 — Read the tool call from stdin

**Enforced by:** test:tests/hooks/client-boundary.test.mjs
WHEN stdin is not a terminal and is non-empty, THE HOOK SHALL take the path
from `tool_input.file_path`, `tool_input.path` and `tool_input.notebook_path`
(every present field is checked; one outside path blocks the call) and the
operation from `tool_name`. WHEN the JSON has no such field, THE HOOK
SHALL exit 0. IF the input is not a JSON object (an array is not), THEN THE HOOK SHALL exit 2.
WHEN stdin is empty, THE HOOK SHALL use `$1` (path) and `$2` (operation).

WHEN a path starts with `~` or `~/`, THE HOOK SHALL expand it with `HOME`, and
SHALL exit 2 if `HOME` is unset or not absolute. IF a path starts with `~user`,
THEN THE HOOK SHALL exit 2.

## REQ-2 — Compare normalised paths by directory boundary

**Enforced by:** test:tests/hooks/client-boundary.test.mjs
THE HOOK SHALL resolve symlinks, `.` and `..` (symlinks first, as the kernel
does) before comparing, and SHALL treat a path as inside a directory only when
it equals the directory or starts with it plus `/`. IF the path is outside the
project root and matches no global read-only entry (reads only) or allowlist
line, THEN THE HOOK SHALL exit 2.

## REQ-3 — Never evaluate the allowlist

**Enforced by:** test:tests/hooks/client-boundary.test.mjs
THE HOOK SHALL expand only a leading `~`, `$HOME` or `${HOME}` in an allowlist
line, and SHALL trim trailing blanks. IF a line still contains `$` or a
backtick, or is not an absolute path, or starts with `~`, `$HOME` or `${HOME}`
while `HOME` is unset or not absolute, THEN THE HOOK SHALL ignore it and print
a warning to stderr.

## REQ-4 — Fail closed with valid events

**Enforced by:** test:tests/hooks/client-boundary.test.mjs
IF the hook cannot decide (missing `node`, unresolvable path, a symlink it
cannot read) or fails unexpectedly, THEN THE HOOK SHALL exit 2, never 1. WHEN it
blocks, THE HOOK SHALL append a `boundary_blocked` line to
`.workflow/state/events.jsonl` that parses as JSON for any path, and SHALL still
exit 2 when that message or line cannot be written.

## Acceptance criteria

### AC-1 (REQ-1)
**Given** stdin JSON naming an outside path, an inside path, no path, `{`, `[]`,
an outside `path` beside an inside `file_path`, and `~/x`, `~user/x` **When**
the hook runs **Then** it exits 2, 0, 0, 2, 2, 2, 2 and 2. Test: "stdin JSON"
and "malformed stdin" in `tests/hooks/client-boundary.test.mjs`.

### AC-2 (REQ-2)
**Given** a sibling directory sharing the root prefix, a `..` escape, a symlink
to an outside file, and `link/../x` **When** the hook runs **Then** each exits
2. Test: the sibling, dot-dot and symlink cases in the same file.

### AC-3 (REQ-3)
**Given** allowlist lines `$(touch S)` and a backtick form **When** the hook
runs **Then** neither command runs, the lines are reported as ignored and the
outside path exits 2. Test: "allowlist lines are never evaluated".

### AC-4 (REQ-4)
**Given** a blocked path containing `"`, `\` and a newline, an unwritable event
log, a failing `readlink`, and an unset `HOME` with allowlist `~/` **When** the
hook runs **Then** the event line parses with `JSON.parse` and every other case
exits 2. Test: "event line is valid JSON", "event log cannot be written",
"failing readlink" and "unset HOME with an allowlist".
