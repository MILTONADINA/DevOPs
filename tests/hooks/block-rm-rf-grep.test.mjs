// hooks/universal/pre-tool/block-rm-rf.sh: every grep pattern must compile on BSD and GNU
// grep (issue #425). A pattern that does not compile prints "grep: parentheses not balanced"
// and the check it guards silently never runs. A plain command must produce no stderr; the
// fork-bomb signature must be refused with its own message, not a grep error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-rm-rf.sh');

function runHook(command) {
  const result = spawnSync('bash', [HOOK, command], { cwd: path.resolve(import.meta.dirname, '..', '..'), encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

for (const command of ['ls', 'git status']) {
  test(`block-rm-rf prints nothing to stderr for: ${command}`, () => {
    const result = runHook(command);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });
}

test('block-rm-rf refuses rm -rf / with exit 2', () => {
  const result = runHook('rm -rf /');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DevOPs RM BLOCK/);
});

// Any function name and any spacing: the same function piped into itself in the background.
for (const command of [':(){ :|:& };:', 'b(){ b|b& };b', 'bomb() { bomb | bomb & }; bomb', ': () { : | : & } ; :']) {
  test(`block-rm-rf refuses the fork bomb ${JSON.stringify(command)} with its own message`, () => {
    const result = runHook(command);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /fork bomb signature/);
    assert.doesNotMatch(result.stderr, /grep:/);
  });
}

// Look-alikes that are not fork bombs pass.
for (const command of ['echo a|b&', 'f(){ g|h& };f']) {
  test(`block-rm-rf allows ${JSON.stringify(command)}`, () => {
    const result = runHook(command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
}
