// Tests for T9 (scripts/graph-dashboard/README.md).
//
// This is a documentation deliverable, not new runtime behavior, so "testing
// it" means verifying its factual claims against the real, shipped source
// (server.mjs, index.html, package.json) rather than server.mjs's own
// behavior (already covered by reader.test.mjs / events-reader.test.mjs /
// state-readers.test.mjs / snapshot.test.mjs / events-sse.test.mjs /
// index-html.test.mjs). Every assertion below either does a precise
// structural check against the real source text, or -- for the one
// boundary-condition-heavy claim (the PORT env var's fallback rule) --
// extracts and actually EXECUTES the real shipped resolvePort() function
// against synthetic process.env shapes, matching this project's established
// "test the real source, never a reimplementation" convention (see
// reader.test.mjs's own header comment).
//
// Run with: node --test tests/graph-dashboard/readme.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile as writeTempFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'README.md');
const SERVER_MJS_PATH = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'index.html');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

let readme, serverSrc, indexHtml, pkg;

before(async () => {
  readme = await readFile(README_PATH, 'utf-8');
  serverSrc = await readFile(SERVER_MJS_PATH, 'utf-8');
  indexHtml = await readFile(INDEX_HTML_PATH, 'utf-8');
  pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf-8'));
});

// README.md is hand-wrapped Markdown prose (~80 cols), so a real multi-word
// phrase can legitimately have a line break (plus leading indentation) where
// a plain string literal has a single space -- that is a formatting detail,
// never a content defect, and this test file must not be brittle to it (nor
// should a future re-wrap of the same prose spuriously break this suite).
// This checks a phrase tolerantly: every run of literal spaces in `phrase`
// matches one-or-more whitespace characters (of any kind, newlines
// included) in the real text; every other character matches literally.
function includesPhrase(text, phrase) {
  const pattern = phrase
    .split(/ +/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(pattern).test(text);
}

// ---------------------------------------------------------------------------
// Meta: the file exists, is substantive, and has the three sections the
// backlog item explicitly requires.
// ---------------------------------------------------------------------------

test('README.md exists and is substantive', () => {
  assert.ok(existsSync(README_PATH), 'scripts/graph-dashboard/README.md does not exist');
  assert.ok(readme.length > 2000, `README.md looks too thin to cover the required sections (${readme.length} chars)`);
});

test('README.md has the three required top-level sections', () => {
  assert.ok(readme.includes('## Running it'), 'missing "## Running it" section');
  assert.ok(readme.includes('## What it shows'), 'missing "## What it shows" section');
  assert.ok(readme.includes('## What it deliberately does NOT do'), 'missing "## What it deliberately does NOT do" section');
});

// ---------------------------------------------------------------------------
// "Running it": npm run graph:dashboard, default URL, three env var
// overrides with defaults.
// ---------------------------------------------------------------------------

test('documents the real npm script and its real underlying command', () => {
  assert.equal(pkg.scripts['graph:dashboard'], 'node scripts/graph-dashboard/server.mjs',
    'package.json\'s graph:dashboard script no longer matches what the README documents');
  assert.ok(readme.includes('npm run graph:dashboard'));
  assert.ok(readme.includes('node scripts/graph-dashboard/server.mjs'));
});

test('documents the real default URL (host + port)', () => {
  assert.ok(serverSrc.includes("const HOST = '127.0.0.1';"), 'server.mjs no longer hardcodes HOST to 127.0.0.1');
  assert.ok(readme.includes('http://127.0.0.1:4081'), 'README does not state the default URL as http://127.0.0.1:4081');
});

test('documents all three env vars by exact name, each with its real default', () => {
  for (const name of ['GRAPH_DASHBOARD_PORT', 'GRAPH_DASHBOARD_STATE_DIR', 'GRAPH_DASHBOARD_JOURNAL_ROOT']) {
    assert.ok(serverSrc.includes(`process.env.${name}`), `server.mjs no longer reads process.env.${name}`);
    assert.ok(readme.includes('`' + name + '`'), `README does not name ${name}`);
  }
  // PORT default: 4081, from resolvePort()'s own fallback literal.
  assert.ok(serverSrc.includes('port <= 65535 ? port : 4081;'), 'resolvePort() default literal changed from 4081');
  assert.ok(readme.includes('`4081`'), 'README does not state 4081 as the PORT default');

  // STATE_DIR default: resolved against GIT_TOP_LEVEL, not cwd -- the exact
  // source line is the load-bearing behavior the README's "resolved against
  // the git top-level, not your current directory" claim depends on.
  assert.ok(
    serverSrc.includes("path.resolve(GIT_TOP_LEVEL, process.env.GRAPH_DASHBOARD_STATE_DIR || '.workflow/state')"),
    'STATE_DIR resolution no longer matches the source line the README describes'
  );
  assert.ok(readme.includes('<git top-level>/.workflow/state'), 'README does not state the STATE_DIR default correctly');
  assert.ok(includesPhrase(readme, 'resolved against the git top-level, not your current directory'),
    'README drops the relative-override-resolution nuance');

  // JOURNAL_ROOT default: ~/.claude/projects/<git-top-level-with-/-replaced-by-->.
  assert.ok(serverSrc.includes(".claude', 'projects'"), 'server.mjs no longer builds JOURNAL_ROOT under ~/.claude/projects');
  assert.ok(serverSrc.includes("GIT_TOP_LEVEL.replaceAll('/', '-')"), 'server.mjs no longer slugifies the git top-level path this way');
  assert.ok(readme.includes('~/.claude/projects/<slug>'), 'README does not state the JOURNAL_ROOT default correctly');
  // The README quotes server.mjs's own header comment on what a
  // pre-resolved override is trusted to directly contain -- verify that
  // exact phrase still exists in both places, not just one.
  assert.ok(serverSrc.includes('wf_*/journal.jsonl'), 'server.mjs header comment no longer uses this exact run-path shape');
  assert.ok(readme.includes('wf_*/journal.jsonl'), 'README no longer quotes the exact run-path shape server.mjs documents');
});

test('states that STATE_DIR does not cover the two governance/graph/ doc paths', () => {
  assert.ok(includesPhrase(readme, 'does **not** cover everything'), 'README drops the STATE_DIR-does-not-cover-everything caveat');
  // Both governance doc readers must default from GIT_TOP_LEVEL, never STATE_DIR.
  assert.ok(serverSrc.includes("path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'autonomy-config.yml')"),
    'autonomy-config.yml is no longer resolved from GIT_TOP_LEVEL');
  assert.ok(serverSrc.includes("path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'stability-dashboard.md')"),
    'stability-dashboard.md is no longer resolved from GIT_TOP_LEVEL');
  assert.ok(readme.includes('governance/graph/autonomy-config.yml'));
  assert.ok(readme.includes('governance/graph/stability-dashboard.md'));
});

// resolvePort()'s exact boundary behavior, actually executed (not just
// pattern-matched) against the real shipped function -- extracted the same
// marker-based, write-to-a-real-module-and-import() way reader.test.mjs
// extracts T2's reader section (see that file's own before() hook), NOT via
// the Function constructor: this repo's security-review tooling flags
// new Function(...string...) as a code-injection-shaped pattern even when,
// as here, the interpolated text is this repo's own trusted source, and the
// import() approach the project already established for this exact
// "test the real shipped source without importing the whole side-effectful
// server.mjs" problem avoids that shape entirely. process.env is mutated
// only for the extracted call itself and restored in `finally`.
test('resolvePort() really does fall back to 4081 for anything not a valid 1..65535 integer (incl. unset)', async () => {
  const start = serverSrc.indexOf('function resolvePort() {');
  assert.notEqual(start, -1, 'could not find resolvePort() in server.mjs -- has it been renamed?');
  const end = serverSrc.indexOf('\n}', start);
  assert.notEqual(end, -1, 'could not find the end of resolvePort()');
  const section = serverSrc.slice(start, end + 2);
  const footer = '\n\nexport { resolvePort };\n';

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-readme-resolveport-'));
  const modulePath = path.join(tmpDir, 'resolve-port-under-test.mjs');
  await writeTempFile(modulePath, section + footer);

  const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'GRAPH_DASHBOARD_PORT');
  const originalValue = process.env.GRAPH_DASHBOARD_PORT;
  try {
    const { resolvePort } = await import('file://' + modulePath);

    const callWith = (value) => {
      if (value === undefined) delete process.env.GRAPH_DASHBOARD_PORT;
      else process.env.GRAPH_DASHBOARD_PORT = value;
      return resolvePort();
    };

    assert.equal(callWith(undefined), 4081, 'unset should fall back to 4081');
    assert.equal(callWith('4081'), 4081);
    assert.equal(callWith('8080'), 8080, 'a valid override port should be honored');
    assert.equal(callWith('1'), 1, 'lower boundary 1 should be honored');
    assert.equal(callWith('65535'), 65535, 'upper boundary 65535 should be honored');
    assert.equal(callWith('0'), 4081, '0 is out of the 1..65535 range');
    assert.equal(callWith('-1'), 4081, 'negative is invalid');
    assert.equal(callWith('65536'), 4081, 'above 65535 is invalid');
    assert.equal(callWith('3.5'), 4081, 'non-integer is invalid');
    assert.equal(callWith('abc'), 4081, 'non-numeric is invalid');
    assert.equal(callWith(''), 4081, 'empty string is falsy -> default');
  } finally {
    if (hadOriginal) process.env.GRAPH_DASHBOARD_PORT = originalValue;
    else delete process.env.GRAPH_DASHBOARD_PORT;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// "What it shows": mirrors T7/T8's real sections.
// ---------------------------------------------------------------------------

test('documents the real snapshot/SSE transport and its 2s unconditional poll', () => {
  assert.ok(serverSrc.includes("['/api/snapshot', serveSnapshot]"));
  assert.ok(serverSrc.includes("['/events', serveEvents]"));
  // README prose hard-wraps (confirmed: "GET" / "/api/snapshot" straddle a
  // line break in the source), so match on the endpoint paths alone.
  assert.ok(readme.includes('/api/snapshot'));
  assert.ok(readme.includes('/events'));
  assert.ok(serverSrc.includes('const EVENTS_POLL_INTERVAL_MS = 2000;'), 'poll interval changed from 2000ms');
  assert.ok(includesPhrase(readme, 'every 2 seconds'), 'README no longer states the 2-second unconditional poll');
});

test('documents the real top-bar stat labels', () => {
  for (const label of ['Autonomy phase', 'Pending approvals', 'Skipped malformed events']) {
    assert.ok(indexHtml.includes(label), `index.html no longer shows the "${label}" stat`);
    assert.ok(includesPhrase(readme, label), `README no longer documents the "${label}" stat`);
  }
});

test('documents the real autonomy-phase labels verbatim (including the real em dash, not a plain hyphen)', () => {
  for (const label of [
    'Pilot — full human gate on every step',
    'Autonomous inner loop — deploy/billing still gated',
    'Low-risk merge-to-main may loosen',
  ]) {
    assert.ok(indexHtml.includes(label), `index.html no longer uses the exact label "${label}"`);
    assert.ok(includesPhrase(readme, label), `README no longer quotes the exact label "${label}"`);
  }
});

test('documents the halt banner as existence-only, contents shown verbatim', () => {
  assert.ok(serverSrc.includes('return { halted: true, raw };'), 'readKillSwitch no longer returns raw contents unmodified');
  assert.ok(readme.includes('.workflow/state/graph-halt'));
  assert.ok(includesPhrase(readme, 'existence alone means halted'));
  assert.ok(includesPhrase(readme, 'never interpreted, only displayed verbatim'));
});

test('documents the exact four node states and the real node-chain shape', () => {
  assert.ok(indexHtml.includes("var NODE_STATES = ['queued', 'running', 'done', 'errored'];"), 'the four node states changed in index.html');
  for (const stateVar of ['--state-queued', '--state-running', '--state-done', '--state-errored']) {
    assert.ok(indexHtml.includes(stateVar), `index.html no longer defines ${stateVar}`);
  }
  for (const word of ['queued', 'running', 'done', 'errored', 'planner', 'reviewer', 'security', 'validator']) {
    assert.ok(readme.includes(word), `README no longer mentions "${word}"`);
  }
});

test('documents the real "last 10 runs" cap on the Recent runs panel', () => {
  assert.ok(indexHtml.includes('allRuns.slice(0, 10)'), 'the recent-runs cap is no longer exactly 10');
  assert.ok(includesPhrase(readme, 'last 10'), 'README no longer states the 10-run cap');
});

test('documents the real gate-event badge categories', () => {
  for (const cat of ['blocked', 'approved', 'warning', 'info', 'other']) {
    assert.ok(indexHtml.includes(`gate-badge--${cat}`), `index.html no longer has a gate-badge--${cat} category`);
  }
  assert.ok(includesPhrase(readme, 'blocked / approved / warning / info / other'), 'README no longer lists the exact 5 gate-event categories');
});

test('documents the real cycle-history source table', () => {
  assert.ok(serverSrc.includes("path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'stability-dashboard.md')"));
  assert.ok(readme.includes('governance/graph/stability-dashboard.md'));
  assert.ok(includesPhrase(readme, "document's own top-to-bottom order"));
});

test('documents the real footer connection states', () => {
  for (const stateText of ['Connecting', 'Live', 'Reconnecting']) {
    assert.ok(indexHtml.includes(stateText), `index.html no longer has connection-state text "${stateText}"`);
    assert.ok(readme.includes(stateText));
  }
  assert.ok(includesPhrase(readme, 'Reconnection is automatic'));
});

// ---------------------------------------------------------------------------
// "What it deliberately does NOT do" -- the section this task explicitly
// says must not be glossed over. Every sub-claim here is independently
// re-verified against the real source, not taken on the coder's word or on
// T7/T8's tester claims alone.
// ---------------------------------------------------------------------------

test('server.mjs truly has zero write-capable fs calls', () => {
  const writePrimitives = /writeFile|appendFile|createWriteStream|fs\.write|unlink|rmdir|mkdir|rename\(|chmod/;
  assert.doesNotMatch(serverSrc, writePrimitives, 'server.mjs now contains a write-capable fs call -- README\'s "no write access ever" claim is stale');
});

test('server.mjs truly routes exactly 3 GET-only paths and 404s everything else', () => {
  const start = serverSrc.indexOf('const routes = new Map([');
  assert.notEqual(start, -1, 'could not find the routes table');
  const end = serverSrc.indexOf(']);', start);
  const section = serverSrc.slice(start, end);
  const entries = section.match(/\[\s*'[^']*'\s*,/g) || [];
  assert.equal(entries.length, 3, `expected exactly 3 routes, found ${entries.length}`);
  assert.ok(section.includes("'/'") && section.includes("'/api/snapshot'") && section.includes("'/events'"));
  assert.ok(serverSrc.includes("req.method === 'GET' ? routes.get(pathname) : undefined"),
    'requestHandler no longer gates every dispatch on GET');

  assert.ok(includesPhrase(readme, 'Every route is `GET`-only'));
  assert.ok(includesPhrase(readme, 'three paths (`/`, `/api/snapshot`, `/events`)'));
});

test('index.html truly has zero mutating controls and exactly one fetch + one EventSource', () => {
  // `href=` is anchored to <a ...>: the page's only href is the inline
  // `data:,` favicon (PB-56), which is not a control and fetches nothing --
  // index-html.test.mjs pins that <link> to exactly that value.
  assert.doesNotMatch(indexHtml, /<button|<form|<input|<select|<textarea|<a\s[^>]*href=/i, 'index.html now has a link/form/input-shaped element');
  assert.doesNotMatch(indexHtml, /\son[a-z]+\s*=/i, 'index.html now has an inline on*= handler');
  assert.doesNotMatch(indexHtml, /['"](POST|PUT|DELETE|PATCH)['"]/, 'index.html now references a mutating HTTP method');
  assert.doesNotMatch(indexHtml, /XMLHttpRequest|WebSocket|sendBeacon/, 'index.html now uses a non-fetch/SSE transport');

  const fetchCalls = (indexHtml.match(/fetch\(/g) || []).length;
  const eventSourceCalls = (indexHtml.match(/EventSource\(/g) || []).length;
  assert.equal(fetchCalls, 1, `expected exactly 1 fetch(...) call, found ${fetchCalls}`);
  assert.equal(eventSourceCalls, 1, `expected exactly 1 EventSource(...) construction, found ${eventSourceCalls}`);

  assert.ok(includesPhrase(readme, 'zero mutating controls of any kind'));
  assert.ok(readme.includes('/sprint-approve') && readme.includes('/graph-halt') && readme.includes('/graph-resume') && readme.includes('`/sprint`'));
});

test('the four named slash commands the README defers control to actually exist', () => {
  for (const cmd of ['sprint-approve.md', 'graph-halt.md', 'graph-resume.md', 'sprint.md']) {
    const p = path.join(REPO_ROOT, 'slash-commands', 'universal', cmd);
    assert.ok(existsSync(p), `slash-commands/universal/${cmd} does not exist -- README names a command that isn't real`);
  }
});

test('cycleId and cycleOutcome really are hardcoded null with no other assignment anywhere', () => {
  const cycleIdOccurrences = serverSrc.match(/cycleId:[^\n]*/g) || [];
  const cycleOutcomeOccurrences = serverSrc.match(/cycleOutcome:[^\n]*/g) || [];
  assert.equal(cycleIdOccurrences.length, 1, `expected exactly one "cycleId:" key in server.mjs, found ${cycleIdOccurrences.length}`);
  assert.equal(cycleOutcomeOccurrences.length, 1, `expected exactly one "cycleOutcome:" key in server.mjs, found ${cycleOutcomeOccurrences.length}`);
  assert.ok(cycleIdOccurrences[0].trim().startsWith('cycleId: null'), `cycleId is no longer hardcoded null: ${cycleIdOccurrences[0]}`);
  assert.ok(cycleOutcomeOccurrences[0].trim().startsWith('cycleOutcome: null'), `cycleOutcome is no longer hardcoded null: ${cycleOutcomeOccurrences[0]}`);

  assert.ok(readme.includes('**`cycleId`**'));
  assert.ok(readme.includes('cycleOutcome') && readme.includes('readyForPR'));
  assert.ok(includesPhrase(readme, 'not recoverable today'));
  assert.ok(readme.includes('always `null`'));
});

test('documents backlogItem as best-effort/non-fabricated, matching the real scraper', () => {
  assert.ok(serverSrc.includes('async function findBacklogItem('), 'findBacklogItem() was renamed or removed');
  assert.ok(serverSrc.includes('Backlog item: "'), 'the scraped prompt-text marker changed');
  assert.ok(readme.includes('backlogItem'));
  assert.ok(readme.includes('best-effort'));
  assert.ok(readme.includes('never-fabricated'));
});

test('documents validatorOutcome as an explicitly-labeled proxy, matching the real three UI strings', () => {
  assert.ok(indexHtml.includes('function describeValidatorOutcome('), 'describeValidatorOutcome() was renamed or removed');
  for (const label of ['Signed off', 'Not signed off', 'not yet available']) {
    assert.ok(indexHtml.includes(label), `index.html no longer uses the validator-outcome label "${label}"`);
  }
  assert.ok(readme.includes('validatorOutcome'));
  assert.ok(readme.includes('proxy'));
  assert.ok(includesPhrase(readme, 'is **not** the same thing as the real'));
});

test('documents per-node state and elapsed time as derived from journal events and file times', () => {
  assert.ok(serverSrc.includes('function buildLabelStates('), 'buildLabelStates() was renamed or removed');
  for (const evType of ["type === 'started'", "type === 'result'", "type === 'failed'"]) {
    assert.ok(serverSrc.includes(evType), `server.mjs no longer branches on ${evType}`);
  }
  assert.ok(serverSrc.includes('async function computeLabelTiming('), 'computeLabelTiming() was renamed or removed');
  assert.ok(serverSrc.includes('birthtimeMs'), 'the birthtime-based elapsed-time derivation changed');
  assert.ok(readme.includes('journal.jsonl'));
  assert.ok(readme.includes('mtimes/birthtimes'));
});
