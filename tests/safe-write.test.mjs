// specs/phase-2/F-skill-provenance.md REQ-F10: unit checks for analyzer/safe-write.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnsafeWriteError, writeInside } from '../analyzer/safe-write.js';

function withDir(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'safe-write-')));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('writeInside with exclusive creates a new file and never replaces one (REQ-F10)', () => {
  withDir(dir => {
    writeInside(dir, 'a/new.txt', 'first', { exclusive: true });
    assert.equal(readFileSync(path.join(dir, 'a/new.txt'), 'utf8'), 'first');
    assert.throws(() => writeInside(dir, 'a/new.txt', 'second', { exclusive: true }), /EEXIST/);
    assert.equal(readFileSync(path.join(dir, 'a/new.txt'), 'utf8'), 'first');
  });
});

test('writeInside with exclusive refuses a link at the destination and leaves its target alone (REQ-F10)', () => {
  withDir(dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'safe-write-outside-')));
    try {
      writeFileSync(path.join(outside, 'victim'), 'outside');
      symlinkSync(path.join(outside, 'victim'), path.join(dir, 'link'));
      symlinkSync(path.join(outside, 'missing'), path.join(dir, 'dangling'));
      for (const name of ['link', 'dangling'])
        assert.throws(() => writeInside(dir, name, 'x', { exclusive: true }), UnsafeWriteError, name);
      assert.equal(readFileSync(path.join(outside, 'victim'), 'utf8'), 'outside');
      assert.throws(() => readFileSync(path.join(outside, 'missing')), /ENOENT/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
