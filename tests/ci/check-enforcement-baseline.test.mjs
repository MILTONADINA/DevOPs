// specs/graph/enforcement-traceability.md REQ-6: fixed CI Git authority, not checker execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const STEP = 'Prepare enforcement baseline';
const INTRO = '98648cfc6710a80444943165ab7dcd2c80f86210';
const TARGET = 'governance/enforcement-baseline.json';
const SENTINEL = 'PRIVATE_ENFORCEMENT_BASELINE_SENTINEL';
const EMPTY = '{"schema_version":1,"enforced":[]}\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function inlineBody() {
  const doc = parseDocument(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(doc.errors, [], 'workflow parse prerequisite');
  const steps = doc.toJS().jobs.validate.steps;
  const matches = steps.filter(step => step.name === STEP);
  assert.ok(matches.length, 'FEATURE_ABSENT: named enforcement baseline preparation step');
  assert.equal(matches.length, 1);
  const selected = matches[0];
  assert.equal(selected.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.ok(["github.event_name == 'pull_request'", "${{ github.event_name == 'pull_request' }}"].includes(selected.if));
  assert.equal(selected['working-directory'], undefined);
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.ok(steps.indexOf(checkout) < steps.indexOf(selected));
  const ratchet = steps.find(step => step.run?.trim() === 'node scripts/check-enforcement.mjs --ratchet .workflow/state/enforcement-base.json');
  assert.ok(ratchet && steps.indexOf(selected) < steps.indexOf(ratchet));
  assert.equal(ratchet.if, selected.if);
  assert.doesNotMatch(selected.run, /\$\{\{/);
  const match = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\n?$/.exec(selected.run);
  assert.ok(match, 'exact inline Node wrapper prerequisite');
  assert.equal(match[0], selected.run);
  assert.equal(match[1].split(`const INTRODUCTION_BASE_SHA = '${INTRO}';`).length, 2);
  return match[1];
}

function snapshot(root, omit = []) {
  return readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name);
    if (omit.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory', stat.mode], ...snapshot(file, omit)];
    return [[file, stat.mode, stat.nlink, stat.isSymbolicLink() ? readlinkSync(file) : sha(readFileSync(file))]];
  });
}

function once(source, from, to) {
  assert.equal(source.split(from).length, 2, 'single literal fixture seam');
  return source.replace(from, to);
}

function withFixture(run, { freshParents = false } = {}) {
  const source = inlineBody(); // Feature guard must precede fixture creation or any Git/tool launch.
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'enforcement-base-')));
  try {
    const cwd = path.join(outer, 'repo'); mkdirSync(cwd);
    const env = { PATH: '/usr/bin:/bin', HOME: cwd, XDG_CONFIG_HOME: cwd, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
    function git(args, input) {
      const result = spawnSync('/usr/bin/git', args, { cwd, env, input, encoding: 'buffer', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(result.error, undefined, 'owned Git fixture prerequisite');
      assert.equal(result.signal, null); assert.equal(result.status, 0, 'owned Git setup failed');
      return result.stdout.toString('utf8').trim();
    }
    git(['init', '--initial-branch=fixture', '--template=']);
    assert.ok(lstatSync(path.join(cwd, '.git')).isDirectory());
    assert.equal(git(['rev-parse', '--show-toplevel']), cwd, 'must never borrow parent Git metadata');
    for (const [key, value] of [['user.name', 'MR17 Fixture'], ['user.email', 'mr17@example.invalid'],
      ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false']]) git(['config', '--local', key, value]);
    writeFileSync(path.join(cwd, 'fixture.txt'), 'owned synthetic repository\n');
    git(['add', '--', 'fixture.txt']); git(['commit', '-m', 'owned introduction']);
    const initial = git(['rev-parse', 'HEAD']);
    const output = path.join(cwd, '.workflow/state/enforcement-base.json');
    if (!freshParents) mkdirSync(path.dirname(output), { recursive: true });
    const f = {
      outer, cwd, output, source, initial, git,
      baseline(bytes, mode = '100644') {
        const oid = git(['hash-object', '-w', '--stdin'], bytes);
        git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${TARGET}`]);
        git(['commit', '-m', 'owned baseline']);
        const commit = git(['rev-parse', 'HEAD']);
        assert.equal(git(['ls-tree', commit, '--', TARGET]), `${mode} blob ${oid}\t${TARGET}`);
        return commit;
      },
      bootstrapSource() { return once(source, `const INTRODUCTION_BASE_SHA = '${INTRO}';`, `const INTRODUCTION_BASE_SHA = '${initial}';`); },
      invoke(base = initial, body = source, extraEnv = {}) {
        const childEnv = { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C', LC_ALL: 'C', ...extraEnv };
        if (base !== null) childEnv.BASE_SHA = base;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', body], {
          cwd, env: childEnv, encoding: 'utf8', timeout: 12000, maxBuffer: 65536,
        });
        assert.equal(result.error, undefined, 'inline Node/tool harness failure');
        assert.equal(result.signal, null);
        assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /);
        assert.equal((result.stdout + result.stderr).includes(SENTINEL), false);
        return result;
      },
    };
    run(f);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

function accepted(f, result, bytes) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'enforcement baseline: prepared\n'); assert.equal(result.stderr, '');
  assert.deepEqual(readFileSync(f.output), Buffer.from(bytes));
  const info = lstatSync(f.output); assert.ok(info.isFile()); assert.equal(info.nlink, 1);
}
function refused(f, result, before, omit = []) {
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'enforcement baseline: unavailable\n');
  assert.deepEqual(snapshot(f.outer, omit), before);
}

test('enforcement baseline preserves exact committed bytes and ignores staged worktree/environment overrides', () => withFixture(f => {
  const bytes = Buffer.from('{\n  "schema_version": 1, "enforced": []\n}\n\n'); const base = f.baseline(bytes);
  mkdirSync(path.join(f.cwd, 'governance')); writeFileSync(path.join(f.cwd, TARGET), SENTINEL); f.git(['add', '--', TARGET]);
  const before = snapshot(f.outer, [f.output]);
  accepted(f, f.invoke(base, f.source, { GIT_DIR: path.join(f.outer, 'missing'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true', GITHUB_TOKEN: SENTINEL }), bytes);
  assert.deepEqual(snapshot(f.outer, [f.output]), before);
}));
test('enforcement baseline creates ordinary missing state parents', () => withFixture(f => {
  const base = f.baseline(EMPTY); const beforeGit = snapshot(path.join(f.cwd, '.git'));
  accepted(f, f.invoke(base), EMPTY);
  assert.deepEqual(snapshot(path.join(f.cwd, '.git')), beforeGit);
  assert.ok(lstatSync(path.dirname(f.output)).isDirectory());
}, { freshParents: true }));
test('enforcement baseline bootstraps only a proven empty lookup at its frozen introduction', () => withFixture(f => {
  assert.equal(f.git(['ls-tree', '-z', f.initial, '--', TARGET]), '');
  const before = snapshot(f.outer, [f.output]); accepted(f, f.invoke(f.initial, f.bootstrapSource()), EMPTY);
  assert.deepEqual(snapshot(f.outer, [f.output]), before);
}));
test('enforcement baseline rejects a different successfully resolved absent commit', () => withFixture(f => {
  f.git(['commit', '--allow-empty', '-m', 'different absence']); const other = f.git(['rev-parse', 'HEAD']);
  assert.notEqual(other, f.initial); assert.equal(f.git(['ls-tree', '-z', other, '--', TARGET]), '');
  const before = snapshot(f.outer); refused(f, f.invoke(other, f.bootstrapSource()), before);
}));
test('enforcement baseline rejects absent or malformed captured base values privately', () => withFixture(f => {
  const before = snapshot(f.outer);
  for (const value of [null, '', 'A'.repeat(40), f.initial + '\n', ' ' + f.initial, '--help']) {
    // Null means omit the variable; other values are passed literally.
    refused(f, f.invoke(value), before);
  }
}));
test('enforcement baseline does not bootstrap a missing commit object', () => withFixture(f => {
  const before = snapshot(f.outer); refused(f, f.invoke('f'.repeat(40), f.bootstrapSource()), before);
}));
test('enforcement baseline rejects blob and annotated-tag objects as base commits', () => withFixture(f => {
  const blob = f.git(['hash-object', '-w', '--stdin'], 'owned blob'); f.git(['tag', '-a', 'owned-tag', '-m', 'owned tag']);
  const tag = f.git(['rev-parse', 'refs/tags/owned-tag']); const before = snapshot(f.outer);
  for (const oid of [blob, tag]) refused(f, f.invoke(oid), before);
}));
test('enforcement baseline rejects executable, symlink and tree entries', () => {
  for (const mode of ['100755', '120000', 'tree']) withFixture(f => {
    let base;
    if (mode === 'tree') {
      mkdirSync(path.join(f.cwd, TARGET), { recursive: true }); writeFileSync(path.join(f.cwd, TARGET, 'child'), SENTINEL);
      f.git(['add', '--', TARGET]); f.git(['commit', '-m', 'owned tree']); base = f.git(['rev-parse', 'HEAD']);
      assert.match(f.git(['ls-tree', base, '--', TARGET]), /^040000 tree /);
    } else base = f.baseline(SENTINEL, mode);
    const before = snapshot(f.outer); refused(f, f.invoke(base), before);
  });
});
test('enforcement baseline preserves an inclusive one-MiB blob without parsing JSON', () => withFixture(f => {
  const bytes = Buffer.alloc(1024 * 1024, 32); const base = f.baseline(bytes); const before = snapshot(f.outer, [f.output]);
  accepted(f, f.invoke(base), bytes); assert.deepEqual(snapshot(f.outer, [f.output]), before);
}));
test('enforcement baseline refuses a blob one byte over its cap', () => withFixture(f => {
  const base = f.baseline(Buffer.alloc(1024 * 1024 + 1, 32)); const before = snapshot(f.outer);
  refused(f, f.invoke(base), before);
}));
test('enforcement baseline refuses existing or redirected staging paths unchanged', () => {
  for (const change of ['existing', 'output-link', 'workflow-link', 'state-link', 'file-parent']) withFixture(f => {
    const base = f.baseline(EMPTY); const owned = path.join(f.outer, 'owned-sentinel'); writeFileSync(owned, SENTINEL);
    if (change === 'existing') writeFileSync(f.output, SENTINEL);
    else if (change === 'output-link') symlinkSync(owned, f.output);
    else if (change === 'file-parent') { rmSync(path.dirname(f.output), { recursive: true }); writeFileSync(path.dirname(f.output), SENTINEL); }
    else {
      const from = change === 'workflow-link' ? path.join(f.cwd, '.workflow') : path.dirname(f.output);
      const to = path.join(f.outer, 'owned-directory'); renameSync(from, to); symlinkSync(to, from);
    }
    const before = snapshot(f.outer); refused(f, f.invoke(base), before);
  });
});

function fakeGit(f, scenario) {
  const file = path.join(f.outer, 'fake-git'); const log = path.join(f.outer, 'git-calls.jsonl');
  writeFileSync(path.join(f.outer, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');
const log=${JSON.stringify(log)}, scenario=${JSON.stringify(scenario)};
fs.appendFileSync(log,JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
const args=process.argv.slice(2), at=args.findIndex(x=>x==='cat-file'||x==='ls-tree'), op=args.slice(at);
function send(value,code=0){process.stdout.write(value,()=>process.exit(code));}
if(scenario==='timeout'){setTimeout(()=>{fs.appendFileSync(log,JSON.stringify({deadman:true})+'\\n');process.exit(99)},8000);}
else if(scenario==='nonzero'){process.stderr.write(${JSON.stringify(SENTINEL)});send('commit\\n',9);}
else if(op[0]==='cat-file'&&op[1]==='-t')send('commit\\n');
else if(op[0]==='ls-tree'){
 if(scenario==='failed-absence')send('',9);
 else if(scenario==='tree-overflow')send('x'.repeat(4097));
 else send('100644 blob '+ 'b'.repeat(40)+'\\t${TARGET}\\0'+(scenario==='tree-framing'?'\\0':''));
}else if(op[0]==='cat-file'&&op[1]==='-s')send(scenario==='size-framing'?'1\\n\\n':'1\\n');
else if(op[0]==='cat-file'&&op[1]==='blob')send(scenario==='body-length'?'xx':'x');
else process.exit(98);
`, { mode: 0o700 });
  const source = once(scenario === 'failed-absence' ? f.bootstrapSource() : f.source, "'/usr/bin/git'", JSON.stringify(file));
  return { log, source };
}
test('enforcement baseline refuses malformed or failed fixed Git plumbing without fallback', () => {
  for (const scenario of ['nonzero', 'failed-absence', 'tree-framing', 'tree-overflow', 'size-framing', 'body-length', 'body-hash']) withFixture(f => {
    const fake = fakeGit(f, scenario); const before = snapshot(f.outer, [fake.log]);
    refused(f, f.invoke(f.initial, fake.source), before, [fake.log]);
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.argv.includes('--no-replace-objects')));
    assert.ok(calls.every(call => call.env.GIT_CONFIG_NOSYSTEM === '1' && call.env.GIT_CONFIG_GLOBAL === '/dev/null' && call.env.GIT_ALLOW_PROTOCOL === ''));
    assert.ok(calls.every(call => !Object.hasOwn(call.env, 'GITHUB_TOKEN')));
  });
});
test('enforcement baseline terminates timed-out Git before the independent deadman', { timeout: 15000 }, () => withFixture(f => {
  const fake = fakeGit(f, 'timeout'); const before = snapshot(f.outer, [fake.log]);
  refused(f, f.invoke(f.initial, fake.source), before, [fake.log]);
  const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 1); assert.ok(Array.isArray(calls[0].argv));
  assert.equal(calls.some(call => call.deadman), false, 'fixture deadline is not the implementation timeout');
}));
