// specs/ops/analyzer-detection.md REQ-5 (AC-5): webhook detection reads at most the
// 2,000-entry budget. Reuses the fs.Dir counter preload from tests/fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const COUNTER = path.join(ROOT, 'tests/fixtures/count-dir-reads.mjs');
const SPEC = 'specs/ops/analyzer-detection.md';
const MARKER = 'webhook-idempotency';

function withProject(files, fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-webhook-')));
  try {
    // A manifest keeps the extension-language walk out of the count.
    for (const [name, content] of Object.entries({ 'package.json': '{"name":"x"}', ...files })) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function analyzeCounted(dir) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'dir-count-')), 'counts');
  try {
    const r = spawnSync(process.execPath, [CLI, 'analyze'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--import=${COUNTER}`, DIR_COUNT_ROOT: dir, DIR_COUNT_OUT: out },
    });
    const counts = { opened: 0, reads: 0, closed: 0 };
    for (const name of readdirSync(path.dirname(out))) {
      const c = JSON.parse(readFileSync(path.join(path.dirname(out), name), 'utf8'));
      for (const k of Object.keys(counts)) counts[k] += c[k];
    }
    // `analyze` prints only a skill count; the recommended skills are in the profile.
    const profile = readFileSync(path.join(dir, '.workflow/profile.yml'), 'utf8');
    return { r, counts, profile };
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

test(`a tree larger than the budget is read within it (${SPEC}#ac-5)`, () => {
  withProject({}, dir => {
    mkdirSync(path.join(dir, 'src'));
    for (let i = 0; i < 2500; i++) writeFileSync(path.join(dir, 'src', `f${i}.txt`), '');
    for (let i = 0; i < 2500; i++) writeFileSync(path.join(dir, `r${i}.txt`), '');
    const { r, counts } = analyzeCounted(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(counts.reads > 0, JSON.stringify(counts));
    assert.ok(counts.reads <= 2000, JSON.stringify(counts));
    assert.equal(counts.closed, counts.opened, JSON.stringify(counts));
  });
});

test(`a webhook indicator in a normal tree is still found (${SPEC}#ac-5)`, () => {
  withProject({ 'src/routes/pay.ts': "app.post('/webhooks/stripe', h);" }, dir => {
    const { r, profile } = analyzeCounted(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(profile.includes(MARKER), profile);
  });
});

test(`a tree without an indicator does not report one (${SPEC}#ac-5)`, () => {
  withProject({ 'src/a.ts': 'export const a = 1;' }, dir => {
    const { r, profile } = analyzeCounted(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!profile.includes(MARKER), profile);
  });
});

test(`the scan stops reading once an indicator is found (${SPEC}#ac-5)`, () => {
  withProject({ 'src/a.ts': "const s = 'Stripe-Signature';" }, dir => {
    for (let i = 0; i < 1500; i++) writeFileSync(path.join(dir, `r${i}.txt`), '');
    const { r, counts, profile } = analyzeCounted(dir);
    assert.ok(profile.includes(MARKER), profile);
    assert.ok(counts.reads < 100, JSON.stringify(counts));
  });
});

test(`a symlinked folder is not followed (${SPEC}#ac-5)`, () => {
  withProject({}, dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-outside-')));
    try {
      writeFileSync(path.join(outside, 'h.ts'), "route('/webhook/x')");
      mkdirSync(path.join(dir, 'src'));
      symlinkSync(outside, path.join(dir, 'src', 'link'));
      const { r, profile } = analyzeCounted(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!profile.includes(MARKER), profile);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
