#!/usr/bin/env node
// scripts/graph-dashboard/server.mjs
//
// Read-only HTTP server for the graph-engineering pipeline dashboard.
//
// SINGLE-FILE CONSTRAINT (backlog T1): this is the only .mjs/.js module
// under scripts/graph-dashboard/. Every server-side concern added by later
// tasks (more routes, more config, more parsing) goes into THIS file --
// do not split it into helper modules.
//
// READ-ONLY FOR LIFE (backlog T1): this server has no auth. It must never
// gain a POST/PUT/DELETE route, or any GET route whose handler writes to a
// file, in this task or any later one. It only ever reads and serves.
//
// Config (each independently env-overridable, resolved once at startup):
//   GRAPH_DASHBOARD_PORT          default 4081
//   GRAPH_DASHBOARD_STATE_DIR     default "<git top-level>/.workflow/state"
//   GRAPH_DASHBOARD_JOURNAL_ROOT  default "~/.claude/projects/<slug>", where
//                                 <slug> is the git top-level path with
//                                 every "/" replaced by "-". When this env
//                                 var IS set, it is trusted as an
//                                 already-resolved root directory that
//                                 directly contains
//                                 <session-id>/subagents/workflows/wf_*/journal.jsonl
//                                 -- used verbatim, not re-derived.
//
// Ambiguity resolution (flagged at plan level): the backlog names this
// file's built-ins as "(http, fs, path, os, url)", but cleanly deriving the
// git top-level wants one more built-in, node:child_process. Chosen here:
// (a) child_process.execFileSync('git', ['rev-parse', '--show-toplevel'])
// -- NOT (b) a manual fs/path upward walk for a ".git" entry. Reasons:
//   1. It is still a Node built-in (node:child_process); the backlog's
//      constraint is "built-ins only", and this repo already shells out to
//      git the same way elsewhere (scripts/devops-cli.js).
//   2. It matches git's own definition of "top-level" exactly -- worktrees,
//      GIT_DIR/GIT_WORK_TREE overrides, bare repos -- cases a hand-rolled
//      upward walk would have to special-case or would get wrong. This
//      runs once at process startup, not per-request, so the one
//      subprocess spawn is a fixed, negligible cost.
//
// Security: binds to 127.0.0.1 ONLY, never 0.0.0.0. No auth exists.
//
// Usage:
//   npm run graph:dashboard
//   node scripts/graph-dashboard/server.mjs
//
// Exits 0 only on external kill (Ctrl-C / SIGINT, default Node handling).
// Exits 1 immediately -- no retry, no hang -- if the port is already in
// use (EADDRINUSE) or startup otherwise fails.

import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import { watch } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveGitTopLevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.error(`graph-dashboard: could not resolve the git repo root via "git rev-parse --show-toplevel": ${err.message}`);
    process.exit(1);
  }
}

function resolvePort() {
  const raw = process.env.GRAPH_DASHBOARD_PORT;
  const port = Number(raw);
  return raw && Number.isInteger(port) && port > 0 && port <= 65535 ? port : 4081;
}

const GIT_TOP_LEVEL = resolveGitTopLevel();
const PORT = resolvePort();
const STATE_DIR = path.resolve(GIT_TOP_LEVEL, process.env.GRAPH_DASHBOARD_STATE_DIR || '.workflow/state');
const JOURNAL_ROOT = process.env.GRAPH_DASHBOARD_JOURNAL_ROOT
  || path.join(os.homedir(), '.claude', 'projects', GIT_TOP_LEVEL.replaceAll('/', '-'));

const HOST = '127.0.0.1'; // Loopback only -- never 0.0.0.0. No auth exists.
const INDEX_HTML_PATH = path.join(SCRIPT_DIR, 'index.html');

// ---------------------------------------------------------------------------
// Run model reader (T2)
//
// Globs <JOURNAL_ROOT>/*/subagents/workflows/*/journal.jsonl and turns each
// run directory into an in-memory run model. Read-only: nothing here ever
// writes to a file.
//
// Ground truth below was established by directly inspecting this session's
// own 6 real run directories (verified empirically, not assumed from the
// orchestrator source alone -- 5 sprint-cycle.js runs plus one differently
// shaped "Refute" run from a different Workflow script) plus this run's own
// still-live 7th directory:
//
//   - Every journal.jsonl line is one JSON object. `type` is one of
//     launched | started | result | failed, and the field set per type is
//     exactly:
//       launched: {type}
//       started:  {type, key, agentId, label, phase}
//       result:   {type, key, agentId, result}   -- NO label/phase
//       failed:   {type, key, agentId}            -- NO label/phase
//     Despite label/phase being announced on `started`, `result` and
//     `failed` do NOT repeat them. `key` is a stable per-task key that is
//     empirically a 1:1 mapping with `label` in every real run inspected
//     (never two labels sharing a key, never one label spanning two keys),
//     including across a failed-then-retried task -- so `key` is the join
//     column that attaches a label-less result/failed event back to the
//     label its started event announced.
//   - `label` values actually seen: "planner", "coder:<taskId>",
//     "tester:<taskId>", "reviewer", "security", "validator", and (in the
//     one non-sprint-cycle run) "refute:<name>". <taskId> appears as both
//     "T1"-style and plain "1"-style depending on what that run's planner
//     emitted -- used verbatim below, never reformatted or normalized.
//   - `phase` values actually seen: "Plan", "Build", "Verify"
//     (sprint-cycle.js) and "Refute" (a different Workflow script -- proof
//     this reader must stay generic and not assume the sprint-cycle chain).
//     "Release" is a real phase name in sprint-cycle.js's own meta.phases,
//     but that script only calls its phase('Release') tracker AFTER every
//     agent() call has already returned (confirmed by reading
//     .claude/workflows/sprint-cycle.js), so a real journal `started` event
//     can never carry it. Its absence here is therefore normal, not a sign
//     of a parse failure.
//   - No journal line and no sibling agent-<id>.meta.json carries a
//     timestamp. Run-level activity window is derived from the earliest and
//     latest mtime of every file in the run directory; a given label's own
//     elapsed time is derived only from that label's *current* agentId's own
//     agent-<agentId>.jsonl + agent-<agentId>.meta.json pair (earliest
//     birthtime, latest mtime across just those two files).
//   - sprint-cycle.js's own source confirms `cycleId` and the final
//     `cycleOutcome`/`readyForPR` object are only ever returned to the
//     orchestrating session (the Workflow's `return` value) -- never written
//     into journal.jsonl, a meta.json, or anything else under the run
//     directory. They are therefore always surfaced below as explicit
//     `null`, never guessed at from other fields. The validator's own
//     {signed_off, reason} result, when the validator has completed, is the
//     closest available proxy for a cycle's outcome and is exposed
//     separately as `validatorOutcome` -- it is NOT the same thing as the
//     real cycleOutcome, which this reader can never see.
// ---------------------------------------------------------------------------

// Matches the literal `Backlog item: "..."` text sprint-cycle.js's own
// planner/reviewer/security/validator prompts embed (see the same file).
// Note: stops at the first `"`, so a backlog item whose text itself contains
// a literal double-quote would be captured only up to that point -- accepted
// as a known limitation of a best-effort, non-fabricated extra rather than a
// reason to hand-roll a more elaborate parser for a case not seen in any
// real captured run.
const BACKLOG_ITEM_RE = /Backlog item: "([^"]*)"/;

async function statSafe(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function listSubdirNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // Missing/unreadable directory -- zero entries, not an error. Covers a
    // JOURNAL_ROOT that doesn't exist yet on a fresh machine, a session
    // directory with no subagents/workflows subtree, etc.
    return [];
  }
}

// Walks <journalRoot>/*/subagents/workflows/*/ and keeps only the entries
// that actually have a journal.jsonl -- a manual two-level directory walk
// rather than a glob library, matching this file's built-ins-only, deps-free
// convention (see T1's ambiguity-resolution comment above).
async function discoverRunDirectories(journalRoot) {
  const runs = [];
  for (const sessionId of await listSubdirNames(journalRoot)) {
    const workflowsDir = path.join(journalRoot, sessionId, 'subagents', 'workflows');
    for (const workflowId of await listSubdirNames(workflowsDir)) {
      const runDir = path.join(workflowsDir, workflowId);
      const journalPath = path.join(runDir, 'journal.jsonl');
      const st = await statSafe(journalPath);
      if (st && st.isFile()) {
        runs.push({ sessionId, workflowId, runDir, journalPath });
      }
    }
  }
  return runs;
}

// Parses journal.jsonl as one JSON object per non-blank line. Each line is
// parsed in its own try/catch so one malformed line never stops the rest of
// the file being read or crashes the reader -- unlike T3's events.jsonl
// reader, a formal skipped-line count is not part of this task's spec, so
// this is parse robustness only, not a reported metric.
async function readJournalEvents(journalPath) {
  let raw;
  try {
    raw = await readFile(journalPath, 'utf-8');
  } catch (err) {
    console.error(`graph-dashboard: could not read ${journalPath}: ${err.message}`);
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip and move on -- see comment above.
    }
  }
  return events;
}

// Builds per-label state from a run's events, keyed by the raw label string
// exactly as it appears (coder:1 and coder:T1 are two distinct labels, never
// merged). Only three of the four states this task defines are ever written
// here directly from an event -- running/errored/done. "queued" is not a
// thing any event says; it is the absence of a label from this map, which
// deriveExpectedLabels()/buildNodes() below turn into explicit entries only
// where an expected chain is actually derivable (never fabricated).
function buildLabelStates(events) {
  const keyToLabel = new Map();
  const labels = new Map();

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const { type, key, agentId } = ev;

    if (type === 'started') {
      if (typeof ev.label !== 'string') continue; // malformed -- nothing to key state by
      keyToLabel.set(key, ev.label);
      labels.set(ev.label, {
        label: ev.label,
        status: 'running',
        phase: typeof ev.phase === 'string' ? ev.phase : null,
        key,
        agentId,
        result: null,
      });
    } else if (type === 'result') {
      const label = keyToLabel.get(key);
      if (!label) continue; // result for a key whose started event we never saw -- nothing to attach to
      const prev = labels.get(label) || { label, phase: null };
      labels.set(label, { ...prev, status: 'done', key, agentId, result: ev.result ?? null });
    } else if (type === 'failed') {
      const label = keyToLabel.get(key);
      if (!label) continue;
      const prev = labels.get(label) || { label, phase: null };
      labels.set(label, { ...prev, status: 'errored', key, agentId, result: null });
    }
    // 'launched' carries no key/label -- nothing to attach per-agent state to.
  }

  return labels;
}

// Run-level first/last activity: earliest/latest mtime across every file
// directly in the run directory (journal.jsonl + every agent-*.jsonl /
// agent-*.meta.json pair). Per the header comment, no file here carries a
// real timestamp field, so mtime is the only available proxy.
async function computeRunActivityWindow(runDir) {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return { firstActivityMs: null, lastActivityMs: null };
  }
  let firstActivityMs = null;
  let lastActivityMs = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const st = await statSafe(path.join(runDir, entry.name));
    if (!st) continue;
    if (firstActivityMs === null || st.mtimeMs < firstActivityMs) firstActivityMs = st.mtimeMs;
    if (lastActivityMs === null || st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs;
  }
  return { firstActivityMs, lastActivityMs };
}

// One label's own elapsed time: birth/mtime of just that label's *current*
// agentId's own agent-<agentId>.jsonl + agent-<agentId>.meta.json pair (the
// agentId carried on that label's own latest event -- not every agentId a
// retried label may have had historically). birthtimeMs can come back as 0
// on filesystems that don't support a real birth time; fall back to mtimeMs
// for "start" in that case rather than reporting a bogus 1970 date.
async function computeLabelTiming(runDir, agentId) {
  if (!agentId) return { startedAtMs: null, lastEventAtMs: null, elapsedMs: null };
  const stats = [
    await statSafe(path.join(runDir, `agent-${agentId}.jsonl`)),
    await statSafe(path.join(runDir, `agent-${agentId}.meta.json`)),
  ].filter(Boolean);
  if (stats.length === 0) return { startedAtMs: null, lastEventAtMs: null, elapsedMs: null };
  const starts = stats.map((s) => (s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs));
  const ends = stats.map((s) => s.mtimeMs);
  const startedAtMs = Math.min(...starts);
  const lastEventAtMs = Math.max(...ends);
  return { startedAtMs, lastEventAtMs, elapsedMs: Math.max(0, lastEventAtMs - startedAtMs) };
}

// Scans one agent-*.jsonl transcript for a genuine Backlog item occurrence.
// Only trusts a match carried directly as a plain-string message body (the
// real prompt an agent was launched with). A match nested inside a
// tool_result content block is rejected -- confirmed by direct inspection
// (wf_5ac06c9b-e2d/agent-aad5c817203c0835a.jsonl) that those are just an
// agent having read or grepped sprint-cycle.js's own source, which contains
// the literal unexpanded template text `Backlog item: "${backlogItem}"` --
// a false positive, not real data. The `!== '${backlogItem}'` check is a
// second, cheap guard against that same literal reaching here some other way.
async function scanFileForBacklogItem(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('Backlog item')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj && obj.message && obj.message.content;
    if (typeof content !== 'string') continue; // e.g. a tool_result content-block array -- not a real prompt
    const match = BACKLOG_ITEM_RE.exec(content);
    if (match && match[1] && match[1] !== '${backlogItem}') {
      return match[1];
    }
  }
  return null;
}

// Best-effort, non-fabricated: returns the backlog item text when found,
// null otherwise -- never guessed. Checks planner/reviewer/security/
// validator's own transcripts first (the roles confirmed to embed this
// text), then falls back to every other agent-*.jsonl in the run directory
// so a differently-shaped run (no planner/reviewer/security/validator
// labels at all, e.g. this session's own Refute run) still gets a chance.
async function findBacklogItem(runDir, labelStates) {
  const priorityNames = [];
  const seen = new Set();
  for (const label of ['planner', 'reviewer', 'security', 'validator']) {
    const state = labelStates.get(label);
    if (state && state.agentId) {
      const name = `agent-${state.agentId}.jsonl`;
      priorityNames.push(name);
      seen.add(name);
    }
  }

  let allNames = [];
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    allNames = entries
      .filter((e) => e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))
      .map((e) => e.name)
      .sort();
  } catch {
    allNames = [];
  }

  for (const name of [...priorityNames, ...allNames.filter((n) => !seen.has(n))]) {
    const found = await scanFileForBacklogItem(path.join(runDir, name));
    if (found) return found;
  }
  return null;
}

// The fixed sprint-cycle.js chain -- planner, then coder/tester per task id
// in the planner's own order, then reviewer/security/validator -- but only
// ever derived once the planner has actually finished and actually returned
// a tasks array; never assumed or fabricated for a run shaped differently
// (e.g. this session's own Refute run, which has no "planner" label at all
// and so yields an empty chain here, by design).
function deriveExpectedLabels(labelStates) {
  const plannerState = labelStates.get('planner');
  if (!plannerState || plannerState.status !== 'done') return [];
  const tasks = plannerState.result && Array.isArray(plannerState.result.tasks) ? plannerState.result.tasks : null;
  if (!tasks) return [];

  const chain = ['planner'];
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id) continue;
    chain.push(`coder:${task.id}`, `tester:${task.id}`);
  }
  chain.push('reviewer', 'security', 'validator');
  return chain;
}

// Merges the expected chain (when derivable) with actually-observed label
// state: a chain label with no observed state becomes an explicit `queued`
// placeholder (this is the only place "queued" is ever produced -- a label
// never seen is queued, per this task's per-agent state rule); any observed
// label outside the expected chain (the whole label set, for a run with no
// derivable chain) is still appended, in first-observed order, rather than
// silently dropped.
function buildNodes(labelStates, expectedLabels) {
  const nodes = [];
  const seen = new Set();

  for (const label of expectedLabels) {
    const state = labelStates.get(label);
    nodes.push(
      state || {
        label,
        status: 'queued',
        phase: null,
        key: null,
        agentId: null,
        result: null,
        startedAtMs: null,
        lastEventAtMs: null,
        elapsedMs: null,
      }
    );
    seen.add(label);
  }

  for (const [label, state] of labelStates) {
    if (!seen.has(label)) nodes.push(state);
  }

  return nodes;
}

function labelStatesToObject(labelStates) {
  const obj = {};
  for (const [label, state] of labelStates) obj[label] = state;
  return obj;
}

async function buildRunModel({ sessionId, workflowId, runDir, journalPath }) {
  const events = await readJournalEvents(journalPath);
  const labelStates = buildLabelStates(events);

  // Attach each observed label's own elapsed-time info (see
  // computeLabelTiming's header comment for exactly which files/fields).
  await Promise.all(
    Array.from(labelStates.values()).map(async (state) => {
      Object.assign(state, await computeLabelTiming(runDir, state.agentId));
    })
  );

  const [{ firstActivityMs, lastActivityMs }, backlogItem] = await Promise.all([
    computeRunActivityWindow(runDir),
    findBacklogItem(runDir, labelStates),
  ]);

  const expectedLabels = deriveExpectedLabels(labelStates);
  const nodes = buildNodes(labelStates, expectedLabels);
  const active = Array.from(labelStates.values()).some((s) => s.status === 'running');

  const validatorState = labelStates.get('validator');
  const validatorOutcome = validatorState && validatorState.status === 'done' ? validatorState.result : null;

  return {
    sessionId,
    workflowId,
    runDir,
    active, // true iff at least one label's latest event is 'started' with no later result/failed
    firstActivityMs,
    lastActivityMs,
    backlogItem, // best-effort, non-fabricated -- null when not found
    // Confirmed by reading .claude/workflows/sprint-cycle.js: neither of
    // these is ever written under a run directory, only returned to the
    // orchestrating session -- surfaced as explicit absence, never guessed.
    cycleId: null,
    cycleOutcome: null,
    // Closest available proxy for a cycle's outcome -- NOT the real
    // cycleOutcome above, which this reader can never see.
    validatorOutcome,
    labels: labelStatesToObject(labelStates), // raw, observed-only ground truth, keyed by label
    expectedLabels, // [] when no derivable planner task list; else the full sprint-cycle chain in order
    nodes, // expectedLabels merged with observed state (queued placeholders included) + any extra observed labels
  };
}

// Entry point for T5's snapshot assembly: builds a model for every run
// directory currently under journalRoot. One bad run directory (unreadable,
// unexpected shape) is logged and skipped rather than failing every other
// run's visibility -- support zero, one, or more than one run, and zero,
// one, or more than one *active* run (callers filter `.active` themselves;
// this makes no assumption about how many there are).
async function readGraphRuns(journalRoot = JOURNAL_ROOT) {
  const runDirs = await discoverRunDirectories(journalRoot);
  const settled = await Promise.allSettled(runDirs.map((r) => buildRunModel(r)));

  const runs = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      runs.push(outcome.value);
    } else {
      const err = outcome.reason;
      console.error(`graph-dashboard: failed to build run model for ${runDirs[i].runDir}: ${(err && (err.stack || err.message)) || err}`);
    }
  });

  runs.sort((a, b) => (b.lastActivityMs ?? -Infinity) - (a.lastActivityMs ?? -Infinity));
  return runs;
}

// ---------------------------------------------------------------------------
// Events log reader (T3)
//
// Reads <STATE_DIR>/events.jsonl -- the flat, append-only audit log that
// hooks and slash-commands write to (see CONTRIBUTING.md's "MUST log to
// .workflow/state/events.jsonl" rule, docs/HOOKS.md, and the various
// hooks/universal/**/*.sh scripts that append to it). Same one-JSON-value-
// per-non-blank-line contract and per-line try/catch resilience as T2's
// journal reader above (readJournalEvents), except this task's spec makes
// the skipped-line count a first-class, reported part of the result instead
// of a swallowed implementation detail.
//
// Ground truth verified directly against the real file at the time this was
// written: of 189 non-blank lines, exactly 10 are genuinely unparseable --
// confirmed by direct inspection to be orphaned raw-shell-output fragments
// (e.g. a multi-line `command` field's contents landing as bare, unquoted
// lines -- see .workflow/state/events.jsonl around lines 11-29) that some
// other process appended into the log, NOT valid JSON objects split across
// multiple lines. No multi-line-join / bracket-balancing recovery would
// rescue these -- they are genuinely orphaned, not reassemblable -- so, as
// confirmed sufficient by that inspection, this reader does exactly what
// T2's does: strict one-JSON-value-per-non-blank-line, an independent
// try/catch per line, skip and move on. No multi-line recovery logic is
// added here.
//
// Read-only, like every reader in this file: never writes to eventsPath or
// anywhere else.
// ---------------------------------------------------------------------------

// A missing file (ENOENT) is the normal, expected state -- a fresh checkout
// with no hooks wired yet (see this file's own header comment) or simply a
// project that hasn't logged an event yet -- so it is not logged as an
// error, just reported back as zero events/zero skipped. Any other read
// failure (permissions, etc.) is a genuine problem and IS logged, mirroring
// readJournalEvents's convention above.
async function readEventsLog(eventsPath = path.join(STATE_DIR, 'events.jsonl')) {
  let raw;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`graph-dashboard: could not read ${eventsPath}: ${err.message}`);
    }
    return { events: [], skippedLines: 0 };
  }

  const events = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank line -- not counted as either parsed or skipped
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      skippedLines++; // malformed/orphaned fragment -- skip and move on, never throw
    }
  }
  return { events, skippedLines };
}

// ---------------------------------------------------------------------------
// Kill switch, pending approvals, autonomy phase, and cycle history readers
// (T4)
//
// Four small, independent, read-only readers for the dashboard's top bar and
// history panel. Every one degrades to an empty/default result -- never a
// crash -- when its source is missing, exactly like T2's and T3's readers
// above: a fresh checkout with no .workflow/state/graph-halt, no
// .workflow/state/graph-approvals/, or a differently-shaped governance doc
// is the normal case on a machine that has never run a cycle yet, not an
// error condition.
//
// None of these four is wired into a route by this task -- see T2's own
// "Entry point for T5's snapshot assembly" comment above; a later task is
// expected to compose T2/T3/T4's readers into one served response.
// ---------------------------------------------------------------------------

// --- (a) Kill switch ---------------------------------------------------

// .workflow/state/graph-halt: created by /graph-halt (see
// slash-commands/universal/graph-halt.md), removed by /graph-resume. Its
// mere existence is what hooks/universal/pre-tool/deploy-gate.sh and /sprint
// treat as "halted" -- deploy-gate.sh does not care about the file's
// contents, only that it is there -- so this reader mirrors that: `halted`
// is existence alone, and `raw` is the file's contents handed back exactly
// as written (typically a one-line JSON blob /graph-halt produced, but
// never parsed here -- a human reading the dashboard wants to see what was
// actually written, not this reader's own re-interpretation of it).
async function readKillSwitch(haltPath = path.join(STATE_DIR, 'graph-halt')) {
  let raw;
  try {
    raw = await readFile(haltPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`graph-dashboard: could not read ${haltPath}: ${err.message}`);
    }
    return { halted: false, raw: null }; // absent (or unreadable) -- the normal not-halted state, not an error
  }
  return { halted: true, raw };
}

// --- (b) Pending approvals ----------------------------------------------

// .workflow/state/graph-approvals/: written by /sprint-approve (see
// slash-commands/universal/sprint-approve.md) as flat marker files named
// "<cycle id>.deploy", "<cycle id>.billing-1", "<cycle id>.billing-2". This
// reader only lists what is currently sitting there -- it does not group by
// cycle, does not check the two-distinct-approver rule, and does not read
// any marker's own contents; that interpretation belongs to
// deploy-gate.sh (the actual gate), not to a read-only lister. Same
// missing-directory convention as T2's own listSubdirNames above: any
// failure to list (directory absent, or present but empty) is zero pending
// approvals, not an error.
async function readPendingApprovals(approvalsDir = path.join(STATE_DIR, 'graph-approvals')) {
  try {
    const entries = await readdir(approvalsDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// --- (c) Current autonomy phase ------------------------------------------

// governance/graph/autonomy-config.yml, read from the git repo root (not
// relative to this script). This repo carries no YAML-parsing dependency
// and T1's constraint is built-ins only, so per the backlog's explicit
// instruction this is a plain line/regex scan of the raw text, not a real
// YAML parse. Anchored to the START of the line (the "m" flag's per-line
// "^") so only the file's genuine top-level `phase:` key can ever match --
// every other phase-shaped key in that file is either indented under a
// parent (the `phase_0:`/`phase_1:`/`phase_2:` entries nested under
// `gates.merge_to_main`) or spelled differently entirely
// (`phase_2_entry_criteria:`, `loosens_in_phase_2:`), so none of those can
// be mistaken for it.
//
// NAMING COLLISION WARNING: this integer (0/1/2) is the GLOBAL
// pilot-maturity autonomy phase for the dashboard's top bar -- per that
// file's own comment: 0 = pilot (full human gate on every step), 1 = inner
// loop autonomous with deploy/billing still gated, 2 = low-risk
// merge-to-main may loosen. It is unrelated to, and must never be merged
// under the same object key as, T2's per-label `phase` field
// (Plan/Build/Verify/Release -- one run's own progress through
// sprint-cycle.js's stages, not the program's autonomy level). Whatever
// later task composes these readers into one snapshot should keep this one
// under its own distinct name (e.g. autonomyPhase), never bare `phase`.
//
// T5 UPDATE: T5's own explicit spec requires the *snapshot's top-level* key
// to be named `phase` (see assembleSnapshot()'s header comment, in the
// Route handlers section below). That does not violate this warning: T2's
// per-label `phase` never reaches the snapshot's top level -- it only ever
// appears several layers down, at runs[i].nodes[j].phase /
// runs[i].labels[<label>].phase, a different key path in a different
// object. Anything else added directly to the snapshot's own top level
// must still keep clear of bare `phase`.
//
// Missing file, missing key, or a non-integer value all degrade to `null`.
const AUTONOMY_PHASE_RE = /^phase:\s*(\d+)/m;

async function readAutonomyPhase(configPath = path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'autonomy-config.yml')) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`graph-dashboard: could not read ${configPath}: ${err.message}`);
    }
    return null;
  }
  const match = AUTONOMY_PHASE_RE.exec(raw);
  if (!match) return null; // key not found / doc reshaped -- degrade to null, never guessed
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

// --- (d) Cycle history -----------------------------------------------------

// governance/graph/stability-dashboard.md, read from the git repo root:
// parses its one Markdown table (columns: Cycle, Date, Backlog item,
// Outcome, Deploy/billing gate hit?, Claim-validator result,
// Change-failure?, Notes) into an array of plain objects, one per data row,
// in the table's own top-to-bottom order. Cell text is handed back exactly
// as written (trimmed of surrounding whitespace only) -- backticks, bold
// markers, em dashes and the rest of a row's own Markdown are left intact,
// not re-interpreted, mirroring (a)'s own "raw contents" choice above: a
// rendering decision belongs to whatever later consumes this, not to the
// reader.
//
// This is a plain line-oriented scan (split on "|", matching this file's
// no-heavyweight-parser convention -- see (c) above), not a real
// Markdown/CommonMark table parser, with one deliberate accommodation for a
// case seen in the real file: a row can legitimately contain a literal "|"
// inside inline code, which a real table renderer tolerates but a naive
// split does not. Directly inspected in
// governance/graph/stability-dashboard.md's phase0-005-test-suites row
// (Notes column): the text "`cmd | tail; $?` captured tail's status"
// contains exactly such a pipe, which is why that one real row already has
// one more delimiter-shaped "|" than the header's 8 columns imply.
// splitMarkdownTableRow below handles this the only reasonable way a
// non-Markdown-aware scanner can for a KNOWN, fixed column count: once more
// "|"-shaped delimiters are found than there are columns, the earliest ones
// are trusted as the real column boundaries (this table's leftmost columns
// are short, structured fields -- a cycle id, a date -- far less likely to
// carry inline code than free-text Notes) and every surplus is folded back
// into the final column with its "|" restored, rather than misaligning
// every later column or dropping the row outright.
const CYCLE_TABLE_COLUMNS = ['Cycle', 'Date', 'Backlog item', 'Outcome', 'Deploy/billing gate hit?', 'Claim-validator result', 'Change-failure?', 'Notes'];
const CYCLE_TABLE_KEYS = ['cycle', 'date', 'backlogItem', 'outcome', 'deployBillingGateHit', 'claimValidatorResult', 'changeFailure', 'notes'];

function splitMarkdownTableRow(line, expectedCells) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null; // not a table row -- caller treats this as "the table ended here"
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const parts = inner.split('|');
  if (parts.length > expectedCells) {
    // Surplus delimiter-shaped "|" -- fold the overflow back into the final
    // column (see the header comment above).
    const head = parts.slice(0, expectedCells - 1);
    const tail = parts.slice(expectedCells - 1).join('|');
    return [...head, tail].map((cell) => cell.trim());
  }
  return parts.map((cell) => cell.trim());
}

function isTableSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

async function readCycleHistory(dashboardPath = path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'stability-dashboard.md')) {
  let raw;
  try {
    raw = await readFile(dashboardPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`graph-dashboard: could not read ${dashboardPath}: ${err.message}`);
    }
    return [];
  }

  const lines = raw.split('\n');
  const expectedCells = CYCLE_TABLE_COLUMNS.length;

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitMarkdownTableRow(lines[i], expectedCells);
    if (cells && cells.length === expectedCells && cells.every((cell, idx) => cell === CYCLE_TABLE_COLUMNS[idx])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return []; // doc reshaped or the table is gone -- degrade to empty, never guessed

  const separatorCells = headerIdx + 1 < lines.length ? splitMarkdownTableRow(lines[headerIdx + 1], expectedCells) : null;
  if (!separatorCells || !isTableSeparatorRow(separatorCells)) return []; // header text matched outside a real table

  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const cells = splitMarkdownTableRow(lines[i], expectedCells);
    if (!cells) break; // first non-row line ends the table
    if (cells.length !== expectedCells) continue; // short/malformed row -- skip it, never fabricate missing columns
    const row = {};
    CYCLE_TABLE_KEYS.forEach((key, idx) => { row[key] = cells[idx]; });
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Route handlers (GET-only, read-only -- see the header note above)
// ---------------------------------------------------------------------------

async function serveIndexHtml(req, res) {
  try {
    const html = await readFile(INDEX_HTML_PATH);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`graph-dashboard: failed to read index.html: ${err.message}\n`);
  }
}

// --- Snapshot assembly (T5) -------------------------------------------------
//
// Composes T2's run-model reader, T3's events-log reader, and T4's four
// kill-switch / pending-approvals / autonomy-phase / cycle-history readers
// into ONE JSON-serializable snapshot object. This is the single shared
// assembly function for the whole dashboard: serveSnapshot() below (GET
// /api/snapshot) calls it directly, and T6's SSE endpoint is expected to
// call this exact same function on every tick rather than duplicating any
// of this -- see this file's own header note ("Write this as one shared
// assembly function") and T4's own comment above readKillSwitch ("a later
// task is expected to compose T2/T3/T4's readers into one served
// response").
//
// Every key here is the direct, unreshaped return value of exactly one
// reader above -- this function does no filtering/renaming/re-nesting of
// its own:
//   runs         <- readGraphRuns()        (T2)  array of run models
//   events       <- readEventsLog()        (T3)  { events, skippedLines } --
//                    the skipped-line count the UI needs (see T3's own
//                    header comment) lives at events.skippedLines, not a
//                    separate top-level key
//   halt         <- readKillSwitch()       (T4a) { halted, raw }
//   approvals    <- readPendingApprovals() (T4b) array of marker filenames
//   phase        <- readAutonomyPhase()    (T4c) integer 0/1/2, or null --
//                    see the NAMING COLLISION WARNING + "T5 UPDATE" note
//                    above readAutonomyPhase: deliberately bare `phase`
//                    here, per this task's own explicit spec, and it does
//                    not collide with T2's nested per-label `phase`
//   cycleHistory <- readCycleHistory()     (T4d) array of table rows -- the
//                    one addition beyond the 5 required keys ("plus
//                    whatever else the UI needs ... T4d's cycle-history
//                    rows")
//
// All six reads are independent, read-only, side-effect-free reads of
// unrelated files/directories, so they run concurrently via Promise.all.
// Every reader above already degrades to an empty/default/null result
// instead of throwing when its source is missing (see each one's own
// header comment) -- so a snapshot is always produced, even on a bone-dry
// fresh checkout with no runs, no events, no halt file, no approvals, and
// no governance docs.
async function assembleSnapshot() {
  const [runs, events, halt, approvals, phase, cycleHistory] = await Promise.all([
    readGraphRuns(),
    readEventsLog(),
    readKillSwitch(),
    readPendingApprovals(),
    readAutonomyPhase(),
    readCycleHistory(),
  ]);
  return { runs, events, halt, approvals, phase, cycleHistory };
}

// GET /api/snapshot (T5): thin HTTP wrapper only -- all the real work is
// assembleSnapshot() above, which T6's SSE endpoint is expected to call
// directly too rather than duplicating any of this logic.
async function serveSnapshot(req, res) {
  try {
    const snapshot = await assembleSnapshot();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot));
  } catch (err) {
    console.error(`graph-dashboard: failed to assemble /api/snapshot: ${err.stack || err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
  }
}

// --- SSE broadcast (T6) -----------------------------------------------------
//
// GET /events: on connect, sends one immediate snapshot event carrying T5's
// exact JSON (assembleSnapshot() -- the same single shared function
// serveSnapshot() calls above, reused verbatim here too, per this task's own
// spec and per T5's "Snapshot assembly" comment above), then keeps the
// response open and pushes a fresh snapshot event to every connected client
// whenever anything relevant changes.
//
// "Anything relevant" is watched two ways, running simultaneously, never one
// instead of the other:
//   1. fs.watch() on every source below (the six fixed paths this task
//      names, plus one dynamic entry per currently-active run directory --
//      T2's own `active` definition, see buildRunModel()'s comment: "true
//      iff at least one label's latest event is 'started' with no later
//      result/failed"). This is a LATENCY OPTIMIZATION only: it can push an
//      update well under EVENTS_POLL_INTERVAL_MS after a real change.
//   2. An UNCONDITIONAL setInterval poll, every EVENTS_POLL_INTERVAL_MS,
//      that re-runs assembleSnapshot() -- which itself freshly re-reads
//      every one of these same sources, see assembleSnapshot()'s own header
//      comment -- and broadcasts the result NO MATTER WHAT, never gated on
//      any "did this actually change" comparison. This is the CORRECTNESS
//      GUARANTEE: fs.watch is well known to be unreliable for nested
//      directories on macOS (this project's own dev platform), and a watch
//      on a path that doesn't exist yet can't even be installed (fs.watch
//      throws synchronously on a missing path -- see watchPathSafe below,
//      most commonly hit for <STATE_DIR>/graph-halt, which per T4a's own
//      comment above readKillSwitch is normally ABSENT). Every connected
//      client is therefore guaranteed a current snapshot at least once every
//      EVENTS_POLL_INTERVAL_MS regardless of whether any fs.watch above
//      ever fires at all.
//
// Never writes to any of these paths -- both mechanisms only ever trigger a
// call to the same read-only assembleSnapshot() T5 already wrote; nothing in
// this section opens a watched path for anything but fs.watch's own
// read-only listener API.
//
// Broadcasting is server-wide, not per-client: one shared set of fs.watch
// watchers and one shared poll timer (installed once -- see the bottom
// "Server bootstrap" section) serve every connection in sseClients at once.
// -----------------------------------------------------------------------------

const EVENTS_POLL_INTERVAL_MS = 2000;

// One open SSE response per connected GET /events client. Broadcasting is
// just "write the same formatted event to everything in this set"; a client
// is added on connect and removed on disconnect (see serveEvents below).
const sseClients = new Set();

// path -> the fs.watch() FSWatcher currently installed for it. Covers both
// the six fixed sources below (installed once, never removed) and,
// dynamically, one entry per currently-active run directory (added/removed
// as runs start/finish -- see refreshRunWatchers). Keyed by path so
// re-attempting an already-watched source is a cheap no-op, never a leaked
// duplicate watcher.
const sseWatchers = new Map();

// The six fixed, permanent watch sources this task names (the seventh --
// "each currently-active run's own directory" -- is dynamic; see
// refreshRunWatchers below, not listed here).
const SSE_FIXED_WATCH_PATHS = [
  JOURNAL_ROOT,
  path.join(STATE_DIR, 'events.jsonl'),
  path.join(STATE_DIR, 'graph-halt'),
  path.join(STATE_DIR, 'graph-approvals'),
  path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'autonomy-config.yml'),
  path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'stability-dashboard.md'),
];

// Installs one fs.watch() listener for `p` unless one is already installed.
// Every failure mode degrades to "not watched, try again later" rather than
// a crash -- fs.watch throws synchronously for a path that doesn't exist yet
// (the common case: JOURNAL_ROOT or graph-approvals/ on a fresh checkout,
// graph-halt whenever the kill switch isn't set -- see T2's/T4's own
// comments above), and a watch that dies later (the platform emits 'error',
// e.g. because the file was removed rather than merely modified) is closed
// and dropped the same way. Per this section's header comment, the
// 2-second poll is the correctness guarantee regardless, and every caller of
// this function (installFixedWatchers every tick, refreshRunWatchers every
// tick) retries every not-currently-watched path again on the very next
// tick, so a failed install here is never fatal, just deferred.
function watchPathSafe(p) {
  if (sseWatchers.has(p)) return;
  try {
    const watcher = watch(p, () => onSourceChanged());
    watcher.on('error', () => {
      watcher.close();
      sseWatchers.delete(p);
    });
    sseWatchers.set(p, watcher);
  } catch {
    // Missing path (or a platform that can't watch this particular entry)
    // -- see header comment above.
  }
}

// Installs (or retries) all six fixed sources. Idempotent and cheap to call
// every tick -- see watchPathSafe's own header comment for why a retry loop
// is worth running repeatedly rather than once at startup only.
function installFixedWatchers() {
  for (const p of SSE_FIXED_WATCH_PATHS) watchPathSafe(p);
}

// Keeps the dynamic slice of sseWatchers in sync with T2's own `active`
// definition: installs a watcher for every currently-active run's runDir
// not already watched, and drops any previously-watched run directory that
// is no longer active (finished, or its run directory is simply gone) --
// without ever touching one of the six fixed sources above.
function refreshRunWatchers(runs) {
  const activeDirs = new Set(runs.filter((r) => r.active).map((r) => r.runDir));
  for (const dir of activeDirs) watchPathSafe(dir);
  for (const [watchedPath, watcher] of sseWatchers) {
    if (SSE_FIXED_WATCH_PATHS.includes(watchedPath)) continue; // fixed sources are never removed
    if (!activeDirs.has(watchedPath)) {
      watcher.close();
      sseWatchers.delete(watchedPath);
    }
  }
}

// One snapshot, formatted as one SSE message. JSON.stringify escapes every
// literal newline inside any string value as the two characters `\n`, so the
// result is always exactly one line -- safe to place whole on a single
// "data:" line with no additional framing.
function formatSseEvent(snapshot) {
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

// Writes one snapshot to every currently-open client. A client whose socket
// already died (but whose 'close' listener -- see serveEvents -- hasn't run
// yet) throws on write; caught per-client so one dead connection never
// blocks the rest of the broadcast, and cleaned up here immediately rather
// than waiting on its own 'close' event.
function broadcastSnapshot(snapshot) {
  if (sseClients.size === 0) return;
  const payload = formatSseEvent(snapshot);
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Shared by both change-detection mechanisms (see this section's header
// comment): fetch one fresh snapshot via T5's own assembleSnapshot() --
// never duplicated, never called directly by anything else in this section
// -- retry any not-yet-installed fixed watcher, keep the active-run watcher
// set current, and broadcast to whoever is connected. A failed read is
// logged and swallowed exactly like every route handler in this file: one
// bad tick must never crash the process or the poll loop that drives it.
async function refreshAndBroadcast() {
  let snapshot;
  try {
    snapshot = await assembleSnapshot();
  } catch (err) {
    console.error(`graph-dashboard: /events failed to refresh snapshot: ${err.stack || err.message}`);
    return;
  }
  installFixedWatchers();
  refreshRunWatchers(snapshot.runs);
  broadcastSnapshot(snapshot);
}

// fs.watch's own listener entry point -- deliberately ignorant of which
// specific source fired or how (eventType/filename are unused): whatever
// changed, the correct response is always the same, re-run the shared
// refresh above.
function onSourceChanged() {
  refreshAndBroadcast().catch((err) => {
    console.error(`graph-dashboard: /events change-triggered refresh failed: ${err.stack || err.message}`);
  });
}

// GET /events (T6): mirrors serveSnapshot()'s own error-handling shape --
// assemble first, and only commit to a 200 + SSE headers once that
// succeeds, so a failed initial read still gets a normal 500 instead of an
// SSE stream that opens and immediately goes silent forever. On success, the
// client is registered in sseClients (a broadcast target for every later
// change) and immediately sent its own first snapshot event; the connection
// is then left open -- no res.end() here -- until the client disconnects.
async function serveEvents(req, res) {
  let snapshot;
  try {
    snapshot = await assembleSnapshot();
  } catch (err) {
    console.error(`graph-dashboard: /events failed to assemble initial snapshot: ${err.stack || err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  sseClients.add(res);
  refreshRunWatchers(snapshot.runs); // as-current-as-possible active-run watch coverage the moment a client shows up
  res.write(formatSseEvent(snapshot));

  req.on('close', () => {
    sseClients.delete(res);
  });
}

// Exact-path GET routes. T2+ add more entries here; never add a non-GET
// method or a handler that writes to disk (see the read-only note above).
const routes = new Map([
  ['/', serveIndexHtml],
  ['/api/snapshot', serveSnapshot],
  ['/events', serveEvents],
]);

// Host-header allow-list (cycle-6 security finding, TP-warning): binding to
// 127.0.0.1 stops remote connections but not DNS rebinding -- a hostname whose
// record flips to 127.0.0.1 after a browser tab already treats it as
// same-origin could read /api/snapshot and /events. Only the loopback names
// this server is reachable by are accepted; anything else is refused before
// routing (the same closure Vite/webpack-dev-server shipped for their local
// no-auth servers). Requests without a Host header (HTTP/1.0 clients) are
// refused too: every legitimate client here is a browser or curl.
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', `127.0.0.1:${PORT}`,
  'localhost', `localhost:${PORT}`,
]);

function isAllowedHost(hostHeader) {
  return typeof hostHeader === 'string' && ALLOWED_HOSTS.has(hostHeader.trim().toLowerCase());
}

async function requestHandler(req, res) {
  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: this dashboard only answers to 127.0.0.1 / localhost\n');
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    pathname = undefined; // Malformed request-line URL -- fall through to 404.
  }

  const handler = req.method === 'GET' ? routes.get(pathname) : undefined;
  if (handler) {
    await handler(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((err) => {
    // Backstop: a route handler threw instead of handling its own errors.
    // Never let that hang the response or crash the whole process.
    console.error(`graph-dashboard: unhandled request error: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error\n');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`graph-dashboard: port ${PORT} is already in use (EADDRINUSE). Stop the process using it, or set GRAPH_DASHBOARD_PORT to a free port.`);
    process.exit(1);
  }
  console.error(`graph-dashboard: failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`graph-dashboard: listening on http://${HOST}:${PORT}`);
  console.log(`graph-dashboard: state dir    = ${STATE_DIR}`);
  console.log(`graph-dashboard: journal root = ${JOURNAL_ROOT}`);
});

// GET /events (T6) live-update machinery: install the six fixed fs.watch
// watchers immediately, then start the unconditional correctness-guarantee
// poll (see the "SSE broadcast (T6)" section above for why both run
// forever, independent of whether any client is currently connected).
// Deliberately NOT inside the "SSE broadcast" section above -- this is a
// startup side effect (like server.listen() itself), and every test file
// that marker-extracts this file's pure library code for in-process testing
// (see tests/graph-dashboard/*.test.mjs) stops before this "Server
// bootstrap" section precisely so that importing an extracted slice never
// binds a real port or, now, never starts a real fs.watch/setInterval
// loop either.
installFixedWatchers();
setInterval(() => {
  refreshAndBroadcast().catch((err) => {
    console.error(`graph-dashboard: /events poll tick failed: ${err.stack || err.message}`);
  });
}, EVENTS_POLL_INTERVAL_MS);
