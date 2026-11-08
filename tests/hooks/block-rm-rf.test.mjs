// hooks/universal/pre-tool/block-rm-rf.sh: a recursive rm outside the project and its
// allowed roots exits 2, however its options are spelled, and a target the hook cannot
// read literally ($HOME, ~, `cmd`) or one that climbs out through .. is refused. Each
// case runs the hook from a disposable project directory; nothing is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-rm-rf.sh');
const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'node_modules', '.cache', 'block-rm-rf-tests');

function decide(command, base = FIXTURES) {
  // The fixture must not sit under an allowed root such as /tmp (the Linux
  // tmpdir), or targets that climb out of the project land inside /tmp and are
  // rightly allowed. node_modules/.cache is inside the checkout instead.
  mkdirSync(base, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(base, 'block-rm-rf-')));
  try {
    const project = path.join(dir, 'project');
    mkdirSync(project);
    const result = spawnSync('/bin/bash', [HOOK, command], { cwd: project, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(result.error, undefined, String(result.error));
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BLOCKED = [
  'rm -rf /etc/x',
  'rm -r -f /etc/x',
  'rm -f -R /opt/x',
  'rm --force --recursive /opt/x',
  '/bin/rm -r /opt/x',
  'rm -rf $HOME',
  'rm -rf "${HOME}/x"',
  'rm -rf ~',
  'rm -rf ~/x',
  'rm -rf `pwd`/..',
  'rm -rf $(pwd)/..',
  'rm -rf ../../outside',
  'rm -rf src/../../outside',
  'rm -rf .',
  'rm -rf ..',
  'rm -rf /tmpevil',
  'rm -rf node_modules_evil/../../x',
  'rm -rf /',
  'rm -rf /*',
  'rm -rf *',
  'rm /etc/x -r',
];
const ALLOWED = [
  'rm -rf node_modules',
  'rm -rf ./dist',
  'rm -r build',
  'rm -rf src/old',
  'rm -rf /tmp/x',
  'rm file.txt',
  'ls -la',
  'rm a.txt && grep -r x .',
];

for (const command of BLOCKED) {
  test(`block-rm-rf refuses: ${command}`, () => {
    assert.equal(decide(command), 2);
  });
}
for (const command of ALLOWED) {
  test(`block-rm-rf allows: ${command}`, () => {
    assert.equal(decide(command), 0);
  });
}

// On Linux the system temp directory is /tmp, an allowed root. A project that
// lives there must still not delete itself, a parent of itself or /tmp.
for (const command of ['rm -rf .', 'rm -rf ..', 'rm -rf /tmp', 'rm -rf /var/tmp']) {
  test(`block-rm-rf refuses from a project under the system temp directory: ${command}`, () => {
    assert.equal(decide(command, tmpdir()), 2);
  });
}

// Runs the hook from a disposable project and returns its exit status and the
// lines it appended to .workflow/state/events.jsonl.
function runWithEvents(command) {
  mkdirSync(FIXTURES, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(FIXTURES, 'block-rm-rf-')));
  try {
    const project = path.join(dir, 'project');
    mkdirSync(project);
    const result = spawnSync('/bin/bash', [HOOK, command], { cwd: project, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(result.error, undefined, String(result.error));
    const log = path.join(project, '.workflow', 'state', 'events.jsonl');
    const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { status: result.status, lines: text.split('\n').filter((line) => line !== '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A double quote, a backslash and a newline in the command text. None of them is
// part of a path token, so the target stays src/old and the command is the whole string.
const SPECIAL = 'rm -rf src/old "\\\n"\\';

test('block-rm-rf escapes a destructive_in_project event line that holds quote, backslash and newline', () => {
  const { status, lines } = runWithEvents(SPECIAL);
  assert.equal(status, 0);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'destructive_in_project');
  assert.ok(event.target.endsWith('/project/src/old'), event.target);
  assert.equal(event.command, SPECIAL);
});

test('block-rm-rf writes one parseable rm_blocked line when a blocked command holds quote, backslash and newline', () => {
  const blocked = 'rm -rf /opt/x "\\\n"\\';
  const { status, lines } = runWithEvents(blocked);
  assert.equal(status, 2);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'rm_blocked');
  assert.equal(event.target, '/opt/x');
});
