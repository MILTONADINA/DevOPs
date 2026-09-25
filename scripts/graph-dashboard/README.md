# Graph Dashboard

A read-only, live-updating view of the graph-engineering pipeline (the
`plan -> code -> test -> review -> security -> validate` cycle that
`.claude/workflows/sprint-cycle.js` drives). Everything on the page is
reconstructed by `scripts/graph-dashboard/server.mjs` from Claude Code's
own session journals, `.workflow/state/`, and two `governance/graph/`
documents — nothing is stored, tracked, or invented by the dashboard
itself.

## Running it

```bash
npm run graph:dashboard
```

That's a thin wrapper (see `package.json`) around:

```bash
node scripts/graph-dashboard/server.mjs
```

Run it from inside this git working tree — any subdirectory works, since
the server resolves the repository root from its own file location. It then
listens in the foreground until you stop it (Ctrl-C / SIGINT); if its port
is already taken (`EADDRINUSE`) or startup otherwise fails, it exits 1
immediately instead of retrying or hanging.

**Default URL**: `http://127.0.0.1:4081`

The server binds to `127.0.0.1` only — never `0.0.0.0` — and has no
authentication of any kind. That's an acceptable default only because it
never accepts a write; see "What it deliberately does NOT do" below. It
also answers only to the loopback names it is reachable by: a request
whose `Host` header is not `127.0.0.1` or `localhost` (with or without the
port) gets `403` before any route runs. That closes the DNS-rebinding gap a
loopback bind alone leaves open — a page from another origin whose hostname
is later pointed at `127.0.0.1` cannot read `/api/snapshot` or `/events`
(the same allow-list Vite and webpack-dev-server ship for the same reason).

### Env var overrides

Each is independently overridable and resolved once, at process startup:

| Variable | Default | What it controls |
| --- | --- | --- |
| `GRAPH_DASHBOARD_PORT` | `4081` | The port the server listens on. Anything that isn't a valid integer in `1..65535` (unset included) falls back to the default. |
| `GRAPH_DASHBOARD_STATE_DIR` | `<git top-level>/.workflow/state` | Where the events log, kill switch, and pending-approval markers are read from (see below). A relative override is resolved against the git top-level, not your current directory. |
| `GRAPH_DASHBOARD_JOURNAL_ROOT` | `~/.claude/projects/<slug>` (`<slug>` = the git top-level path with every `/` replaced by `-`) | The directory holding this project's Claude Code session journals. When set, it is trusted as an already-resolved root that directly contains `<session-id>/subagents/workflows/wf_*/journal.jsonl` — used exactly as given, never re-derived. |

`GRAPH_DASHBOARD_STATE_DIR` does **not** cover everything the dashboard
reads. The autonomy-phase and cycle-history panels read
`governance/graph/autonomy-config.yml` and
`governance/graph/stability-dashboard.md`; both are always resolved from
the git top-level and are unaffected by this variable.

## What it shows

The whole page is driven by one JSON snapshot, served at `GET
/api/snapshot` and pushed over `GET /events` (Server-Sent Events) — once
immediately on connect, again on every change the server detects, and
unconditionally every 2 seconds regardless, as a correctness backstop.
There is no manual refresh control, and none is needed.

### Top bar
- **Autonomy phase** — the pilot-maturity phase (0, 1, or 2) from
  `governance/graph/autonomy-config.yml`, labeled "Pilot — full human gate
  on every step" / "Autonomous inner loop — deploy/billing still gated" /
  "Low-risk merge-to-main may loosen". This is a *global* program setting,
  unrelated to any single run's own Plan/Build/Verify/Release progress
  below — the two are never the same field.
- **Pending approvals** — how many marker files currently sit in
  `.workflow/state/graph-approvals/` (written by `/sprint-approve`). The
  dashboard just counts them; it does not evaluate the two-distinct-
  approver / deploy-vs-billing rule — that logic belongs to
  `hooks/universal/pre-tool/deploy-gate.sh`, the actual gate.
- **Skipped malformed events** — how many lines in
  `.workflow/state/events.jsonl` failed to parse as JSON on the most
  recent read.

### Halt banner
Shown, full-width and impossible to miss, whenever
`.workflow/state/graph-halt` exists — existence alone means halted; the
file's contents are never interpreted, only displayed verbatim.

### Pipeline graph
One card per currently **active** run (a run with at least one node whose
latest event is `started` with no later `result`/`failed`), read from this
project's own journals under `GRAPH_DASHBOARD_JOURNAL_ROOT`. Each card
shows:
- A title (the run's scraped backlog item, falling back to its workflow
  id) and its session id / workflow id.
- A Plan / Build / Verify / Release phase strip, current phase
  highlighted.
- The node chain — `planner -> [coder:T<n> -> tester:T<n>]* -> reviewer ->
  security -> validator` — in the exact order the server produced it. Each
  node shows its role, task id (if any), status, and elapsed time. Exactly
  four statuses exist: **queued** (gray), **running** (blue, pulsing,
  live-ticking elapsed time), **done** (green), **errored** (red).

An empty state is shown instead of blank space when nothing is active.

### Recent runs
The last 10 runs, active or finished, newest activity first: session id /
workflow id, an Active/Finished badge, last-activity time, the scraped
backlog item, and the validator-outcome proxy — see "NOT recoverable"
below for exactly what that is and is not.

### Gate events
`.workflow/state/events.jsonl`, newest first. Each row is badged by a
best-guess category — blocked / approved / warning / info / other —
derived from the event's own `event` field, with every extra field the
event carries shown verbatim underneath.

### Cycle history
The Markdown table in `governance/graph/stability-dashboard.md`, one card
per row, in the document's own top-to-bottom order, every cell shown
exactly as written in the source.

### Footer
Connection status only — `Connecting…` / `Live` / `Reconnecting…` — plus
how long ago the last snapshot arrived. Reconnection is automatic.

## What it deliberately does NOT do

This is a **viewer**, not a control surface. Every point below is a
permanent design constraint, not a gap slated to be filled in later.

- **No write access to the repo, or to `.workflow/state`, under any
  circumstance.** Every route is `GET`-only — `server.mjs` routes exactly
  three paths (`/`, `/api/snapshot`, `/events`) and returns 404 for
  everything else, including every non-`GET` method. No route handler
  ever opens a file for writing. The file's own header comment pins this
  down as a standing rule for every future change to it, not just its
  current behavior: it must never gain a mutating route, in this task or
  any later one.
- **No button, link, form, or endpoint anywhere that approves, halts,
  resumes, or triggers a cycle.** The shipped page has zero mutating
  controls of any kind: no `<button>`, `<input>`, `<select>`,
  `<textarea>`, `<form>`, or `<a href=` (the page's only `href` is the
  inline `data:,` favicon, which fetches nothing); no inline `on*=`
  handlers; no
  `POST`/`PUT`/`DELETE`/`PATCH` anywhere in it; no `XMLHttpRequest`,
  `WebSocket`, or `sendBeacon`. Exactly one `fetch()` call (`GET
  /api/snapshot`) and one `EventSource` (`GET /events`) exist, and both
  are read-only. Approving a gate (`/sprint-approve`), halting
  (`/graph-halt`), resuming (`/graph-resume`), and triggering a cycle
  (`/sprint`) all stay slash commands, run deliberately by a human in a
  session — this dashboard cannot do any of them today, and must never
  grow a way to.
- **One field is not shown today**, not approximated, not partially shown,
  always `null`:
  - **A labeled final outcome record (`cycleOutcome` / `readyForPR`)**

  Confirmed by reading `.claude/workflows/sprint-cycle.js` itself: it is
  returned only to the orchestrating session, as the Workflow's own return
  value, and is not written into `journal.jsonl`, any `agent-*.meta.json`,
  or the run record. The **`cycleId`**, unavailable until masterpiece MR-15,
  is joined by `runId` from `.workflow/state/graph-cycles/<cycleId>/run.json`
  (REQ-R10) whenever a run record exists, and is `null` otherwise.

  What **is** recoverable, and only on a best-effort, never-fabricated
  basis:
  - **`backlogItem`** — scraped from the literal `Backlog item: "..."` text
    that `sprint-cycle.js`'s own planner/reviewer/security/validator
    prompts embed, by scanning agent transcripts for it. `null`, plainly,
    when no such text is found anywhere in the run directory — never
    guessed. (A backlog item whose own text contains a literal `"` is
    truncated at that quote — a known limitation of scraping prompt text
    this way, not a bug.)
  - **`validatorOutcome`** — the validator's own `{signed_off, reason}`
    result, once the validator node has finished; the closest available
    proxy for a cycle's real outcome, and labeled as a proxy everywhere it
    appears ("Signed off — <reason>" / "Not signed off — <reason>" / "not
    yet available"). It is **not** the same thing as the real
    `cycleOutcome`/`readyForPR` record above — this dashboard cannot see
    whether every gate a cycle depends on was actually satisfied
    end-to-end, only what the validator node itself reported.
  - **Per-node state** (queued / running / done / errored / stale) — derived
    from `journal.jsonl`'s `started` / `result` / `failed` events, joined back
    to a label via each event's own `key`. A node the journal still calls
    running is shown **stale** when its agent files have been silent for 18
    minutes and its run's record (below) does not say `running`, or for 3
    hours when the record does. Live agents have gone quiet for up to 74
    minutes, but an orchestrator that dies leaves its record at `running`. A
    stale node does not make its run active (masterpiece REQ-M24, PB-57).
  - **Cycle id and run state** — joined by `runId` from
    `.workflow/state/graph-cycles/<cycleId>/run.json` (REQ-R10). The earlier
    run of a resumed cycle, named in the record's `resumedFrom`, is joined to
    the same cycle as `superseded`. A sprint run with no run record is
    labelled `NOT_OBSERVED`; a Workflow run that is not a sprint cycle is
    labelled as such. Nothing here is guessed.
  - **Elapsed time**, per node and per run — derived entirely from
    filesystem mtimes/birthtimes (a node's own `agent-<id>.jsonl` +
    `agent-<id>.meta.json`; every file in the run directory for the run's
    own first/last activity window), because no journal line and no meta
    file carries a real timestamp field of its own.
