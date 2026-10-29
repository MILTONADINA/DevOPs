// Backlog-item spec check: a spec holding [NEEDS CLARIFICATION] must not enter a cycle (story dv-covers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clarificationMarkers } from '../../scripts/lint-spec-status.mjs';

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'lint-spec-status.mjs');

test('a marker in the spec body is reported with its line number', () => {
  const text = '# S\n\n**Status**: approved\n\n## Requirements\n\nThe toy widget shall [NEEDS CLARIFICATION: how many?] spin.\n';
  assert.deepEqual(clarificationMarkers(text), [{ line: 7, text: 'The toy widget shall [NEEDS CLARIFICATION: how many?] spin.' }]);
});

test('a clean spec, a marker inside fenced code and one inside an HTML comment report nothing', () => {
  assert.deepEqual(clarificationMarkers('# S\n\n## R\n\nAll clear.\n'), []);
  assert.deepEqual(clarificationMarkers('# S\n```\n[NEEDS CLARIFICATION]\n```\n'), []);
  assert.deepEqual(clarificationMarkers('# S\n<!-- [NEEDS CLARIFICATION] -->\nok\n'), []);
  assert.deepEqual(clarificationMarkers('# S\nsee the word NEEDS CLARIFICATION without brackets\n'), []);
});

test('the marker is found with CRLF endings and a marker after a closed comment on the same line', () => {
  assert.equal(clarificationMarkers('# S\r\n[NEEDS CLARIFICATION]\r\n').length, 1);
  assert.equal(clarificationMarkers('# S\n<!-- c --> [NEEDS CLARIFICATION]\n').length, 1);
});

test('the CLI --item exits 1 naming file:line for a marked spec and 0 for a clean one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clar-'));
  try {
    const bad = path.join(dir, 'bad.md');
    const good = path.join(dir, 'good.md');
    writeFileSync(bad, '# S\n\n[NEEDS CLARIFICATION]\n');
    writeFileSync(good, '# S\n\nfine\n');
    const failed = spawnSync(process.execPath, [SCRIPT, '--item', bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /bad\.md:3: \[NEEDS CLARIFICATION\]/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--item', good], { encoding: 'utf8' }).status, 0);
    const missing = spawnSync(process.execPath, [SCRIPT, '--item', path.join(dir, 'nope.md')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
