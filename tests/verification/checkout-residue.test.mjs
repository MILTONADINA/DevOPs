// specs/verification/committed-claims.md REQ-4/REQ-10: CI prepares only known inactive checkout residue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, linkSync, renameSync, rmSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const STEP = 'Prepare checkout residue for committed claims';
const KNOWN = '[core]\n\tsparseCheckout = false\n\tsparseCheckoutCone = false\n[index]\n\tsparse = false\n';
const CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/fixture/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[http "https://github.com/"]\n\textraheader = X-Fixture: inert\n';
const SENTINEL = 'PRIVATE_CHECKOUT_RESIDUE_SENTINEL';
assert.equal(Buffer.byteLength(KNOWN), 83, 'pinned checkout residue prerequisite');
function stepRun() {
  const doc = parseDocument(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(doc.errors, [], 'workflow parse prerequisite');
  const steps = doc.toJS().jobs.validate.steps;
  const matches = steps.filter(step => step.name === STEP);
  assert.ok(matches.length > 0, 'FEATURE_ABSENT: named checkout residue preparation step');
  assert.equal(matches.length, 1); const selected = matches[0];
  assert.equal(typeof selected.run, 'string'); assert.ok(selected.run.trim());
  assert.doesNotMatch(selected.run, /\$\{\{/);
  assert.equal(selected['working-directory'], undefined, 'preparation must use canonical checkout CWD');
  assert.ok(steps.indexOf(selected) < steps.findIndex(step => step.name === 'Validate committed claim metadata'), 'preparation must precede strict committed validation');
  return selected.run;
}
function snapshot(root, omitted = []) {
  return readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name); if (omitted.includes(file)) return [];
    const stat = lstatSync(file);
    const identity = { mode: stat.mode, ino: stat.ino, nlink: stat.nlink };
    if (stat.isDirectory()) return [[file, 'directory', { mode: stat.mode, ino: stat.ino }], ...snapshot(file, omitted)];
    return [[file, identity, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : createHash('sha256').update(readFileSync(file)).digest('hex')]];
  });
}
function withFixture(run) {
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'checkout-residue-')));
  try {
    const cwd = path.join(outer, 'repo'); const bin = path.join(outer, 'bin');
    for (const dir of [path.join(cwd, '.git/refs'), path.join(cwd, '.git/objects'), bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(cwd, '.git/HEAD'), 'ref: refs/heads/fixture\n');
    const config = path.join(cwd, '.git/config'); const residue = path.join(cwd, '.git/config.worktree');
    writeFileSync(config, CONFIG); symlinkSync(process.execPath, path.join(bin, 'node'));
    run({ outer, cwd, config, residue,
      invoke() {
        const source = stepRun();
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', source], {
          cwd, env: { PATH: bin, HOME: cwd, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.error, undefined); assert.equal(result.signal, null);
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(output, /MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /);
        assert.equal(output.includes(SENTINEL), false);
        return { ...result, output };
      },
    });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

test('checkout residue absence succeeds without mutation', () => withFixture(f => {
  const before = snapshot(f.outer); const result = f.invoke();
  assert.equal(result.status, 0, result.output); assert.match(result.output, /checkout residue: absent/);
  assert.deepEqual(snapshot(f.outer), before);
}));
test('checkout residue removes only the exact inactive pinned-checkout bytes', () => withFixture(f => {
  writeFileSync(f.residue, KNOWN); const before = snapshot(f.outer, [f.residue]); const result = f.invoke();
  assert.equal(result.status, 0, result.output); assert.match(result.output, /checkout residue: removed known inactive settings/);
  assert.equal(existsSync(f.residue), false); assert.deepEqual(snapshot(f.outer, [f.residue]), before);
}));
for (const [name, change] of [
  ['unexpected bytes', f => writeFileSync(f.residue, `[core]\n\tunknown = ${SENTINEL}\n`)],
  ['active sparse setting', f => writeFileSync(f.residue, KNOWN.replace('sparseCheckout = false', 'sparseCheckout = true'))],
  ['oversized residue', f => writeFileSync(f.residue, KNOWN + ' ')],
  ['directory residue', f => mkdirSync(f.residue)],
  ['redirected git directory even with absent residue', f => { const target = path.join(f.outer, 'owned-git'); renameSync(path.join(f.cwd, '.git'), target); symlinkSync(target, path.join(f.cwd, '.git')); }],
  ['gitfile even with absent residue', f => { const target = path.join(f.outer, 'owned-git'); renameSync(path.join(f.cwd, '.git'), target); writeFileSync(path.join(f.cwd, '.git'), 'gitdir: ' + target + '\n'); }],
  ['redirected residue', f => { const target = path.join(f.outer, 'owned-residue'); writeFileSync(target, KNOWN); symlinkSync(target, f.residue); }],
  ['redirected config', f => { const target = path.join(f.outer, 'owned-config'); renameSync(f.config, target); symlinkSync(target, f.config); writeFileSync(f.residue, KNOWN); }],
  ['shared hardlink residue', f => { const target = path.join(f.outer, 'owned-residue'); writeFileSync(target, KNOWN); linkSync(target, f.residue); assert.equal(lstatSync(f.residue).nlink, 2); }],
  ['indirect include config', f => { writeFileSync(f.config, `[include]\n\tpath = ${SENTINEL}\n`); writeFileSync(f.residue, KNOWN); }],
  ['worktree extension config', f => { writeFileSync(f.config, '[extensions]\n\tworktreeConfig = true\n'); writeFileSync(f.residue, KNOWN); }],
  ['invalid UTF-8 config', f => { writeFileSync(f.config, Buffer.from([0xc3, 0x28])); writeFileSync(f.residue, KNOWN); }],
  ['continued config', f => { writeFileSync(f.config, '[core]\n\tbare = fal' + '\\' + '\nse\n'); writeFileSync(f.residue, KNOWN); }],
  ['oversized config', f => { writeFileSync(f.config, '#'.repeat(65537)); writeFileSync(f.residue, KNOWN); }],
]) test(`checkout residue refuses ${name} unchanged`, () => withFixture(f => {
  change(f); const before = snapshot(f.outer); const result = f.invoke();
  assert.notEqual(result.status, 0, result.output); assert.match(result.output, /checkout residue: unavailable or unsupported/);
  assert.deepEqual(snapshot(f.outer), before);
}));
