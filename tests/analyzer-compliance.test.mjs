// specs/ops/analyzer-detection.md REQ-6 (AC-6): README compliance terms match as
// whole words, ordinary words such as "minor" and "graphics" add no scope, and
// analyze prints the term behind each scope (#351).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readmeCompliance } from '../analyzer/compliance.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/ops/analyzer-detection.md#ac-6';

function analyze(readme) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-compliance-')));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"name":"toy"}');
    writeFileSync(path.join(dir, 'README.md'), readme);
    const r = spawnSync(process.execPath, [CLI, 'analyze'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return { stdout: r.stdout, profile: readFileSync(path.join(dir, '.workflow/profile.yml'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scopes = text => readmeCompliance(text).map(hit => hit.scope);

test(`ordinary words that contain or equal a compliance term add no scope (${SPEC})`, () => {
  for (const text of [
    'This is a minor release of a small graphics helper library.',
    'Spawns a child process; be patient while it starts.',
    'Renders the children of each node. Education is a sector we may support later.',
    'A morphing graphic, a philosophy and a kidney-shaped button.',
    'Renders the children of a node with its data.',
  ]) assert.deepEqual(scopes(text), [], text);
});

test(`stated children's or health data still yields COPPA or HIPAA (${SPEC})`, () => {
  assert.deepEqual(scopes("This app processes children's data for schools."), ['COPPA']);
  assert.deepEqual(scopes('Stores student records and parent accounts.'), ['COPPA']);
  assert.deepEqual(scopes('Built for users under 13.'), ['COPPA']);
  assert.deepEqual(scopes('We never sell data about children.'), ['COPPA']);
  assert.deepEqual(scopes('Keeps patient records; HIPAA applies.'), ['HIPAA']);
  assert.deepEqual(scopes('Handles PHI for clinics.'), ['HIPAA']);
});

test(`a graphics library README gets no compliance scope and no coppa-audit (${SPEC})`, () => {
  const { stdout, profile } = analyze('# toy\n\nThis is a minor release of a small graphics helper library.\n');
  assert.match(stdout, /Compliance scope: \(none detected\)/);
  assert.doesNotMatch(profile, /coppa-audit|children's data|PHI/);
});

test(`analyze prints the README term behind each compliance scope (${SPEC})`, () => {
  const { stdout, profile } = analyze("# toy\n\nThis app processes children's data.\n");
  assert.match(stdout, /Compliance scope: COPPA \(README: "children's data"\)/);
  assert.match(profile, /coppa-audit/);
});
