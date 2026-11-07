# Budget brake

**Status**: implemented (story #356)
**Spec ID**: security/budget-brake
**Decision context**: `hooks/universal/pre-tool/budget-brake.sh` is a Claude Code PreToolUse hook. Claude Code blocks a call only when a hook exits 2; any other nonzero exit lets the call through. So every failure path of the brake has to end in exit 2 to fail closed.

## Problem

The session total piped `grep` into `awk` under `set -o pipefail`. A ledger with no line for the current session made `grep` exit 1, and the hook ended with exit 1, so the call went through and the session was never capped (#356). The hourly and daily totals turned an unreadable ledger into zero spend, and the malformed-cost check could fail open on SIGPIPE.

## Requirements

### REQ-1 — A session with no ledger line is capped
**Enforced by:** test:tests/hooks/budget-brake.test.mjs
WHEN the ledger holds no line for the current session, THE BRAKE SHALL count that session's spend as zero, SHALL record a reserve under the caps, and SHALL block (exit 2) a reserve that would pass the session cap.

### REQ-2 — The session id is compared as text
**Enforced by:** test:tests/hooks/budget-brake.test.mjs
THE BRAKE SHALL total only ledger lines whose `session_id` equals the current session id as text, and SHALL NOT treat the id as a pattern.

### REQ-3 — A ledger the brake cannot read blocks the call
**Enforced by:** test:tests/hooks/budget-brake.test.mjs
IF the ledger path exists but is not a regular file, or the brake cannot read it, THEN THE BRAKE SHALL block the call (exit 2) and name the ledger, and SHALL NOT count it as zero spend. A missing ledger counts as zero spend.

### REQ-4 — A malformed cost blocks at any ledger size
**Enforced by:** test:tests/hooks/budget-brake.test.mjs
IF any ledger line holds a `cost_usd` that is not a plain non-negative decimal, THEN THE BRAKE SHALL block the call (exit 2), however large the ledger is.

## Acceptance criteria

- AC-1 (REQ-1): a ledger holding only other sessions; reserve 0.10 exits 0 and appends a reserve line for the session; reserve 100 exits 2 and names the session cap; with no ledger file the reserve is recorded as before; a session whose own lines exceed the cap exits 2.
- AC-2 (REQ-2): a ledger line for session `aXb` does not count toward session `a.b`.
- AC-3 (REQ-3): an unreadable ledger, or a directory at the ledger path, exits 2 with a message naming the ledger.
- AC-4 (REQ-4): a negative cost on the first line of a ledger larger than a pipe buffer exits 2.
