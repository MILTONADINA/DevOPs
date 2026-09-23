import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('stability table measures environment faults separately from change failures', () => {
  const file = readFileSync(path.join(ROOT, 'governance', 'graph', 'stability-dashboard.md'), 'utf8');
  const header = file.split('\n').find((line) => line.startsWith('| Cycle |'));
  assert.match(header, /\| Change-failure\? \| Environment faults \| Notes \|/);
  const cycle6 = file.split('\n').find((line) => line.startsWith('| `phase1-006-graph-dashboard`'));
  assert.match(cycle6, /\| 3: api 2, environment 1; resume time unrecorded \|/);
});
