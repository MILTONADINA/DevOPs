// Tests for T10 (slash-commands/universal/sprint.md's one-line dashboard-URL
// addition).
//
// This is a one-line documentation addition, not new runtime behavior, so
// "testing it" means: (a) verifying the line's factual claims (default host,
// default port, override env var name) against server.mjs's real, shipped
// constants -- never a hand-copied re-statement of today's values, so this
// keeps catching drift if server.mjs's HOST/PORT/env-var-name ever change
// without sprint.md being updated to match -- and (b) verifying the line
// sits where T10's own spec says it must: immediately after the
// Workflow({...}) invocation block, so a `/sprint` reader actually sees it
// right where they'd look.
//
// Deliberately does NOT assert "exactly one line was added and nothing else
// in the file changed" -- that is a property of the specific T10 edit
// (checked once, structurally, via `git diff` in the tester's own one-off
// proof for T10; see claim-2026-09-15-104's caveats), not a durable
// invariant of sprint.md's ongoing content. Asserting it here would make
// this suite fail on every future, legitimate edit to sprint.md.
//
// Run with: node --test tests/graph-dashboard/sprint-doc.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPRINT_MD_PATH = path.join(REPO_ROOT, 'slash-commands', 'universal', 'sprint.md');
const SERVER_MJS_PATH = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

let sprintMd, serverSrc;

before(async () => {
  sprintMd = await readFile(SPRINT_MD_PATH, 'utf-8');
  serverSrc = await readFile(SERVER_MJS_PATH, 'utf-8');
});

test('server.mjs still hardcodes HOST to a real, extractable loopback literal', () => {
  const match = /const HOST = '([^']+)';/.exec(serverSrc);
  assert.ok(match, 'expected to find the HOST constant declaration in server.mjs');
  assert.equal(
    match[1],
    '127.0.0.1',
    "HOST changed in server.mjs -- sprint.md's dashboard-URL line needs updating to match"
  );
});

test("server.mjs's resolvePort() fallback default is still extractable and numeric", () => {
  const match = /port > 0 && port <= 65535 \? port : (\d+);/.exec(serverSrc);
  assert.ok(match, "expected to find resolvePort()'s numeric fallback in server.mjs");
  assert.equal(
    match[1],
    '4081',
    "default port changed in server.mjs -- sprint.md's dashboard-URL line needs updating to match"
  );
});

test('server.mjs still names the override env var GRAPH_DASHBOARD_PORT', () => {
  assert.match(
    serverSrc,
    /process\.env\.GRAPH_DASHBOARD_PORT/,
    "env var name changed in server.mjs -- sprint.md's dashboard-URL line needs updating to match"
  );
});

test('sprint.md names the dashboard URL, with the real host/port/override env var, immediately after the Workflow({...}) block', () => {
  const host = /const HOST = '([^']+)';/.exec(serverSrc)[1];
  const port = /port > 0 && port <= 65535 \? port : (\d+);/.exec(serverSrc)[1];

  const fenceMarker = '```\nWorkflow({';
  const blockStart = sprintMd.indexOf(fenceMarker);
  assert.notEqual(blockStart, -1, 'expected the Workflow({...}) fenced code block in sprint.md');
  const closeFence = '\n```\n';
  const closeIdx = sprintMd.indexOf(closeFence, blockStart + fenceMarker.length);
  assert.notEqual(closeIdx, -1, 'expected a closing code fence after the Workflow({...}) block');

  const nextLine = sprintMd.slice(closeIdx + closeFence.length).split('\n')[0];
  assert.ok(
    nextLine.includes(`http://${host}:${port}`),
    `expected the line right after the Workflow block to name http://${host}:${port}, got: ${JSON.stringify(nextLine)}`
  );
  assert.ok(
    nextLine.includes('GRAPH_DASHBOARD_PORT'),
    `expected the override env var name in that line, got: ${JSON.stringify(nextLine)}`
  );
  assert.match(
    nextLine,
    /override/i,
    'expected the line to note this is an override-able default, not just a bare URL'
  );
});

test('sprint.md is otherwise unchanged in shape: every pre-existing section heading is still present', () => {
  for (const heading of ['## Before running', '## Running it', '## After running']) {
    assert.ok(sprintMd.includes(heading), `expected heading "${heading}" to still be present in sprint.md`);
  }
});
