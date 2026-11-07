// hooks/universal/pre-tool/block-rm-rf.sh: a recursive rm outside the project and its
// allowed roots exits 2, however its options are spelled, and a target the hook cannot
// read literally ($HOME, ~, `cmd`) or one that climbs out through .. is refused. Each
// case runs the hook from a disposable project directory; nothing is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-rm-rf.sh');

function decide(command) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'block-rm-rf-')));
  try {
    const project = path.join(dir, 'project');
    mkdirSync(project);
    const result = spawnSync('bash', [HOOK, command], { cwd: project, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
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
