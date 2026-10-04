// specs/graph/closure-references.md REQ-1..7 / AC-1..5.
// Owned real Git metadata; all claim commands and document contents stay inert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/lint-closures.mjs');
const HELPER = path.join(ROOT, 'tests/verification/fixtures/stage-committed-claims.sh');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SHIP = 'SHIP_BLOCKERS.md', BACKLOG = '.workflow/state/polish-backlog.md';
const IDS = ['claim-2026-10-04-931', 'claim-2026-10-04-932'];
const PRIVATE = 'MR18_PRIVATE_SOURCE_SENTINEL';
const CAP = 262144;
const digest = value => createHash('sha256').update(value).digest('hex');
const evidence = (id = IDS[0], change = 'commit:' + 'd'.repeat(40)) => `${change}; claim:${id}`;
const heading = (value = evidence(), level = 2, name = 'Owned item') => `${'#'.repeat(level)} ${name}\n**Status:** CLOSED\n**Closure evidence:** ${value}\n`;
const table = (value = evidence()) => `| Item | Status | Evidence |\n|:---|---:|:---:|\n| Owned item | CLOSED | ${value} |\n`;
const yaml = (value, indent = 0) => Object.entries(value).map(([key, item]) => {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(item)) return `${prefix}${key}:\n${item.map(v => `${prefix}  - ${JSON.stringify(v)}\n`).join('')}`;
  if (item !== null && typeof item === 'object') return `${prefix}${key}:\n${yaml(item, indent + 2)}`;
  return `${prefix}${key}: ${JSON.stringify(item)}\n`;
}).join('');
function feature() { assert.ok(existsSync(SCRIPT), 'FEATURE_ABSENT: scripts/lint-closures.mjs is not implemented'); }
function tree(directory, ignored = []) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (ignored.includes(file)) return [];
    const stat = lstatSync(file), identity = [stat.mode, stat.ino, stat.nlink];
    if (stat.isDirectory()) return [[file, 'directory', identity], ...tree(file, ignored)];
    return [[file, identity, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : stat.isFile() ? digest(readFileSync(file)) : 'special']];
  });
}
function withFixture(run) {
  feature();
  for (const source of [HELPER, TSX, ...['claim-input.ts', 'committed-claims.ts', 'committed-git.ts', 'claim-schema.yml', 'reproducibility-check.ts'].map(name => path.join(ROOT, 'verification', name))]) {
    assert.ok(existsSync(source), 'fixture prerequisite: named locked helper/source must exist');
  }
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'closure-reference-')));
  const root = path.join(outer, 'repo'), elsewhere = path.join(outer, 'elsewhere');
  const bin = path.join(outer, 'bin'), launcher = path.join(outer, 'launcher'), log = path.join(outer, 'git.jsonl');
  for (const dir of [root, elsewhere, bin, launcher]) mkdirSync(dir);
  const file = (relative, bytes) => { const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); return target; };
  const publication = path.join(root, '.workflow/proofs/committed'), manifestPath = path.join(publication, 'manifest.json');
  let git;
  const setupEnv = { PATH: process.env.PATH, HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' };
  function setupResult(result) {
    assert.equal(result.error, undefined, 'owned Git setup must complete'); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  }
  function stage(action) {
    const output = setupResult(spawnSync('/bin/bash', [HELPER, action, root], { cwd: outer, env: setupEnv, encoding: 'utf8', timeout: 10000 }));
    const fields = Object.fromEntries(output.trim().split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    assert.equal(fields.TOPLEVEL, root); assert.ok(path.isAbsolute(fields.GIT_BIN)); return fields;
  }
  function gitSetup(args) {
    assert.ok(git && existsSync(path.join(root, '.git/mr10b-owned')), 'only previously admitted own Git fixture');
    return setupResult(spawnSync(git, ['-C', root, '-c', 'user.name=MR18 owned fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: outer, env: setupEnv, encoding: 'utf8', timeout: 10000 }));
  }
  try {
    file('package.json', '{"type":"module"}\n');
    copyFileSync(SCRIPT, file('scripts/lint-closures.mjs', ''));
    for (const name of ['claim-input.ts', 'committed-claims.ts', 'committed-git.ts', 'claim-schema.yml', 'reproducibility-check.ts']) copyFileSync(path.join(ROOT, 'verification', name), file('verification/' + name, ''));
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
    file('src/changed.txt', 'Owned target content\n'); file('specs/fixture.md', '# Owned specification\n\n## AC-1\n');
    const initial = stage('init'); git = initial.GIT_BIN;
    const documents = IDS.map(id => ({ claim: { id, type: 'doc', spec_ref: 'specs/fixture.md#ac-1', description: 'Owned inert metadata declaration.',
      proof: { git_sha: initial.TARGET, files_changed: ['src/changed.txt'], test_command: 'touch command-executed', test_exit_code: 7,
        test_output_path: '.workflow/proofs/not-created.log', environment: { INERT: PRIVATE } }, confidence: 'high', reproducibility_hash: '' } }));
    function saveClaims() {
      for (let i = 0; i < documents.length; i++) {
        const c = documents[i].claim, env = c.proof.environment ?? {};
        c.reproducibility_hash = 'sha256:' + digest(`${c.proof.test_command}\n---\n${Object.keys(env).sort().map(key => `${key}=${env[key]}`).join('\n')}\n---\n${c.proof.git_sha}`);
        file(`.workflow/proofs/committed/claims/${IDS[i]}.yml`, yaml(documents[i]));
      }
    }
    const bind = () => file('.workflow/proofs/committed/manifest.json', JSON.stringify({ schema_version: 1,
      claims: IDS.map(id => ({ id, path: `claims/${id}.yml`, sha256: digest(readFileSync(path.join(publication, 'claims', id + '.yml'))) })),
      artifacts: ['scripts/inert.mjs', '_checks/declared.json'].map(relative => ({ path: relative, sha256: digest(readFileSync(path.join(publication, relative))) })) }) + '\n');
    file('.workflow/proofs/committed/scripts/inert.mjs', `throw new Error(${JSON.stringify(PRIVATE)});\n`);
    file('.workflow/proofs/committed/_checks/declared.json', '{"declared":true}\n'); saveClaims(); bind(); stage('publish');
    file(SHIP, heading());
    function commitDocs() { gitSetup(['add', '-A', '--', SHIP, '.workflow']); gitSetup(['commit', '-q', '--allow-empty', '-m', 'Owned closure documents']); }
    commitDocs();
    function wrapper(mode = 'normal', replacement = '') {
      const source = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2),mode=${JSON.stringify(mode)};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a})+'\\n');\n` +
        `if(mode==='deny')process.exit(91);if(mode==='backlog-error'&&a.includes('ls-tree')&&a.at(-1)===${JSON.stringify(BACKLOG)}){process.stderr.write(${JSON.stringify(PRIVATE)},()=>process.exit(39));return;}\n` +
        `const r=cp.spawnSync(${JSON.stringify(git)},a,{encoding:null});if(r.error)process.exit(92);\n` +
        `if(mode==='race'&&a.slice(-4).join(' ')==='rev-parse --verify --end-of-options refs/remotes/origin/main'){for(const ref of ['refs/heads/fixture','refs/remotes/origin/main']){const moved=cp.spawnSync(${JSON.stringify(git)},['--git-dir='+${JSON.stringify(root + '/.git')},'--work-tree='+${JSON.stringify(root)},'-c','user.name=MR18 owned fixture','-c','user.email=fixture@example.invalid','update-ref',ref,${JSON.stringify(replacement)}],{env:process.env});if(moved.status!==0)process.exit(93);}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({moved:true})+'\\n');}\n` +
        `process.stdout.write(r.stdout||'',()=>process.stderr.write(r.stderr||'',()=>process.exit(r.status??94)));\n`;
      writeFileSync(path.join(bin, 'git'), source); chmodSync(path.join(bin, 'git'), 0o755);
    }
    wrapper(); writeFileSync(log, '');
    const f = { root, outer, elsewhere, file, documents, publication, manifestPath, saveClaims, bind, stage, commitDocs, gitSetup, wrapper,
      invoke(args = [], cwd = root, moving = false) {
        writeFileSync(log, '');
        const ignored = [log, launcher, ...(moving ? ['refs/heads/fixture', 'refs/remotes/origin/main', 'logs/HEAD', 'logs/refs/heads/fixture', 'logs/refs/remotes/origin/main'].map(name => path.join(root, '.git', name)) : [])];
        const before = tree(outer, ignored);
        const result = spawnSync(process.execPath, [TSX, path.join(root, 'scripts/lint-closures.mjs'), ...args], { cwd,
          env: { PATH: bin, HOME: root, TMPDIR: launcher, LANG: 'C', LC_ALL: 'C', TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 20000, maxBuffer: 262144 });
        assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
        assert.deepEqual(tree(outer, ignored), before, 'lint is read-only outside exact owned Git log/loader scratch and declared ref-race writes');
        assert.equal(existsSync(path.join(root, 'command-executed')), false, 'claim command remains inert');
        const output = result.stdout + result.stderr;
        assert.equal(output.includes(PRIVATE), false, 'inputs and subprocess errors remain private');
        assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /, 'loader/setup crashes cannot witness feature refusal');
        return { ...result, output, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
      },
    };
    run(f);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function passed(result, documents = 1, closed = 1) {
  assert.equal(result.status, 0, result.output); assert.equal(result.stderr, '');
  assert.equal(result.stdout, `closures: references valid documents=${documents} closed=${closed}\n`);
}
function refused(result, category) { assert.equal(result.status, 1, result.output); assert.equal(result.stdout, ''); assert.equal(result.stderr, `closures: ${category}\n`); }
function group(name, values, run) { test(name, () => { for (const value of values) withFixture(f => run(f, value)); }); }

test('nonempty committed heading validates actual publication independently of CWD', () => withFixture(f => { passed(f.invoke()); passed(f.invoke([], f.elsewhere)); }));
group('supported heading and table forms accept exact commit or PR evidence', [
  heading(evidence(IDS[0], 'pr:1'), 3), table(), table(evidence(IDS[1], 'pr:9999999999')),
  '   ## Owned heading ###\n**Status:** CLOSED\n**Closure evidence:** ' + evidence() + '\n',
], (f, text) => { f.file(SHIP, text); f.commitDocs(); passed(f.invoke()); });
test('nearest heading owns a closed child without closing its open parent', () => withFixture(f => {
  f.file(SHIP, '## Open parent\n**Status:** OPEN\n' + heading(evidence(), 3)); f.commitDocs(); passed(f.invoke());
  f.file(SHIP, heading() + '\n### Open child\n**Status:** OPEN\n'); f.commitDocs(); passed(f.invoke());
}));
test('separate item forms count twice and may reuse one published claim', () => withFixture(f => {
  f.file(SHIP, heading() + '\n## Table section\n' + table(evidence(IDS[0], 'pr:12'))); f.commitDocs(); passed(f.invoke(), 1, 2);
}));
test('historical resolved prose, lowercase status and token substrings stay honest zero', () => withFixture(f => {
  f.file(SHIP, '# Historical notes\nPreviously resolved. done closed UNCLOSED CLOSED_SUFFIX\n## Open\n**Status:** OPEN\n| Unrelated | Table |\n|---|---|\n| escaped\\|pipe | ordinary prose |\n'); f.commitDocs(); passed(f.invoke(), 1, 0);
}));
test('complete fenced examples and standalone comments exclude CLOSED content', () => withFixture(f => {
  f.file(SHIP, '<!--\n' + heading(PRIVATE) + '-->\n<!-- CLOSED ' + PRIVATE + ' -->\n````md\n```\n' + heading(PRIVATE) + '`````\n~~~md\nCLOSED\n~~~\n' + heading()); f.commitDocs(); passed(f.invoke());
}));
test('committed optional absence differs from a present second document', () => withFixture(f => {
  passed(f.invoke()); f.file('.workflow/state/other.txt', 'owned sibling\n'); f.commitDocs(); passed(f.invoke());
  f.file(BACKLOG, heading(evidence(IDS[1], 'pr:7'))); f.commitDocs(); passed(f.invoke(), 2, 2);
}));
test('local opt-in substitutes its fixed named backlog while default ignores its dirty bytes', () => withFixture(f => {
  f.file(BACKLOG, heading()); f.commitDocs(); f.file(BACKLOG, '# Local open backlog\n');
  passed(f.invoke(), 2, 2); passed(f.invoke(['--local-backlog']), 2, 1);
}));
test('uncommitted and staged ship edits cannot replace captured committed authority', () => withFixture(f => {
  f.file(SHIP, 'CLOSED ' + PRIVATE + '\n'); passed(f.invoke());
  f.gitSetup(['add', '--', SHIP]); passed(f.invoke());
}));
group('usage refuses extra, repeated and alternate selectors before Git', [
  [PRIVATE], ['--root', PRIVATE], ['--local-backlog', BACKLOG], ['--local-backlog', '--local-backlog'], ['--local-backlog=' + PRIVATE], ['--help'],
], (f, args) => { f.wrapper('deny'); const result = f.invoke(args); refused(result, 'usage'); assert.deepEqual(result.calls, []); });
group('mandatory committed ship and explicit local backlog absence refuse input', [SHIP, BACKLOG], (f, selected) => {
  if (selected === SHIP) { rmSync(path.join(f.root, SHIP)); f.commitDocs(); refused(f.invoke(), 'input'); }
  else refused(f.invoke(['--local-backlog']), 'input');
});
group('unsupported standalone CLOSED occurrences refuse structure', [
  'CLOSED\n', '- CLOSED\n', '# CLOSED\n', '#### Item\n**Status:** CLOSED\n', '`CLOSED`\n',
  '## Item\n**Status:** **CLOSED**\n', '## Item\nStatus: CLOSED\n', '> CLOSED\n',
  '| Other | Status | Evidence |\n|---|---|---|\n| item | CLOSED | ' + evidence() + ' |\n',
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('closed block ownership refuses nesting, duplicate status and mixed forms', [
  heading() + '**Status:** CLOSED\n', heading() + heading(evidence(), 3),
  '## Outer\n#### Child\n**Status:** CLOSED\n**Closure evidence:** ' + evidence() + '\n',
  heading() + table(),
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('selected tables refuse malformed delimiters, extra or escaped cells and ambiguous tokens', [
  table().replace('|:---|', '|:--|'), table().replace('| Owned item |', '| |'),
  table().replace('| Owned item |', '| Owned\\|item |'), table().replace('| CLOSED |', '| CLOSED | extra |'),
  table().replace('| Owned item |', '| CLOSED item |'), table().replace('claim:' + IDS[0], 'claim:' + IDS[0] + ' CLOSED'),
  table().replace('|:---|---:|:---:|\n', '\n|:---|---:|:---:|\n'),
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('comments and fences cannot manufacture a physical status or hide unclosed structure', [
  heading().replace('CLOSED', 'CLO<!-- ' + PRIVATE + ' -->SED'),
  heading().replace('**Status:**', '**Sta<!-- ' + PRIVATE + ' -->tus:**'),
  heading().replace('**Closure evidence:**', '**Closure <!-- hidden -->evidence:**'),
  '<!-- ' + PRIVATE, '<!-- <!-- nested -->\n', '```md\n' + PRIVATE, '~~~\n' + PRIVATE,
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('missing, malformed and duplicate evidence refuse structure', [
  heading().split('\n').filter(line => !line.startsWith('**Closure evidence:**')).join('\n'),
  heading() + '**Closure evidence:** ' + evidence() + '\n', heading(''),
  heading('claim:' + IDS[0]), heading('commit:' + 'd'.repeat(40)),
  heading(evidence().replace('; ', ';')), heading(evidence() + '; pr:1'),
  heading(evidence().replace('commit:', 'Commit:')), heading(evidence().replace('d'.repeat(40), 'd'.repeat(39))),
  heading(evidence().replace('d'.repeat(40), 'D'.repeat(40))), heading(evidence().replace(IDS[0], 'claim-2026-10-04-93')),
  ...['0', '01', '-1', '10000000000'].map(number => heading(evidence(IDS[0], 'pr:' + number))),
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
test('evidence cannot be borrowed from another heading or table row', () => withFixture(f => {
  f.file(SHIP, '## Missing\n**Status:** CLOSED\n## Other\n**Closure evidence:** ' + evidence() + '\n'); f.commitDocs(); refused(f.invoke(), 'structure');
  f.file(SHIP, table().replace('| Owned item | CLOSED | ' + evidence() + ' |', '| Open | OPEN | ' + evidence() + ' |\n| Missing | CLOSED | |')); f.commitDocs(); refused(f.invoke(), 'structure');
}));
test('one valid selected item cannot hide a later missing citation', () => withFixture(f => {
  f.file(SHIP, heading() + '\n## Missing\n**Status:** CLOSED\n'); f.commitDocs(); refused(f.invoke(), 'structure');
}));
group('unknown and local-only claim IDs cannot satisfy membership', [false, true], (f, local) => {
  const id = 'claim-2026-10-04-999'; if (local) { f.file('.gitignore', '.workflow/proofs/claim-*.yml\n'); f.file('.workflow/proofs/' + id + '.yml', yaml({ claim: { ...f.documents[0].claim, id } })); }
  f.file(SHIP, heading(evidence(id))); f.commitDocs();
  if (local) { assert.equal(existsSync(path.join(f.root, '.workflow/proofs/' + id + '.yml')), true); assert.equal(f.gitSetup(['ls-files', '--', '.workflow/proofs/' + id + '.yml']), '', 'local-only claim remains untracked'); }
  refused(f.invoke(), 'reference');
});
group('missing and empty publication refuse even honest zero closure documents', ['missing', 'empty'], (f, mode) => {
  f.file(SHIP, '# No selected closures\n'); f.commitDocs();
  if (mode === 'missing') rmSync(f.publication, { recursive: true });
  else { const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8')); manifest.claims = []; writeFileSync(f.manifestPath, JSON.stringify(manifest)); f.stage('publish'); }
  refused(f.invoke(), 'publication');
});
test('working publication byte changes refuse rather than admitting manifest IDs alone', () => withFixture(f => {
  const artifact = path.join(f.publication, 'scripts/inert.mjs'); writeFileSync(artifact, readFileSync(artifact, 'utf8') + '// changed\n'); refused(f.invoke(), 'publication');
}));
group('invalid uncited member schema and target anchor still reject full-set authority', ['schema', 'anchor'], (f, fault) => {
  if (fault === 'schema') f.documents[1].claim.confidence = 'invalid'; else f.documents[1].claim.spec_ref = 'specs/fixture.md#missing';
  f.saveClaims(); f.bind(); f.stage('publish'); refused(f.invoke(), 'publication');
});
test('HEAD and main captured once continue to bind documents and claims after ref movement', () => withFixture(f => {
  const replacement = f.stage('orphan').ORPHAN; f.wrapper('race', replacement); const result = f.invoke([], f.elsewhere, true); passed(result);
  assert.equal(result.calls.filter(call => call.moved).length, 1);
  const captures = result.calls.filter(call => call.args?.includes('rev-parse') && call.args.includes('--verify'));
  assert.equal(captures.filter(call => call.args.at(-1) === 'HEAD').length, 1); assert.equal(captures.filter(call => call.args.at(-1) === 'refs/remotes/origin/main').length, 1);
  for (const ref of ['refs/heads/fixture', 'refs/remotes/origin/main']) assert.equal(readFileSync(path.join(f.root, '.git', ref), 'utf8'), replacement + '\n');
}));
test('regular executable committed document mode remains accepted', () => withFixture(f => { chmodSync(path.join(f.root, SHIP), 0o755); f.commitDocs(); passed(f.invoke()); }));
group('nonregular committed leaf and parent are not optional absence', ['leaf-symlink', 'leaf-tree', 'parent-symlink', 'parent-blob'], (f, kind) => {
  if (kind === 'leaf-symlink') { f.file('.workflow/state/owned.txt', heading()); symlinkSync('owned.txt', path.join(f.root, BACKLOG)); }
  if (kind === 'leaf-tree') f.file(BACKLOG + '/child.txt', heading());
  if (kind === 'parent-symlink') { const dir = path.join(f.outer, 'owned-target'); mkdirSync(dir); writeFileSync(path.join(dir, 'polish-backlog.md'), heading()); symlinkSync(dir, path.join(f.root, '.workflow/state')); }
  if (kind === 'parent-blob') f.file('.workflow/state', PRIVATE + '\n');
  f.commitDocs(); refused(f.invoke(), 'input');
});
test('Git errors reading optional backlog cannot be converted into absence', () => withFixture(f => {
  f.file(BACKLOG, heading()); f.commitDocs(); f.wrapper('backlog-error'); const result = f.invoke(); refused(result, 'input');
  assert.ok(result.calls.some(call => call.args?.includes('ls-tree') && call.args.at(-1) === BACKLOG));
}));
group('local backlog redirects, hard links and nonregular inputs refuse', ['leaf-symlink', 'parent-symlink', 'hardlink', 'directory'], (f, kind) => {
  const target = path.join(f.outer, 'owned-local'); writeFileSync(target, heading());
  if (kind === 'parent-symlink') { const directory = path.join(f.outer, 'owned-parent'); mkdirSync(directory); writeFileSync(path.join(directory, 'polish-backlog.md'), heading()); symlinkSync(directory, path.join(f.root, '.workflow/state')); }
  else { mkdirSync(path.join(f.root, '.workflow/state'), { recursive: true });
    if (kind === 'leaf-symlink') symlinkSync(target, path.join(f.root, BACKLOG));
    if (kind === 'hardlink') linkSync(target, path.join(f.root, BACKLOG));
    if (kind === 'directory') mkdirSync(path.join(f.root, BACKLOG));
  }
  refused(f.invoke(['--local-backlog']), 'input');
});
group('invalid UTF8 is rejected for committed and explicitly local documents', [false, true], (f, local) => {
  f.file(local ? BACKLOG : SHIP, Buffer.from([0xff, 0x0a])); if (!local) f.commitDocs(); refused(f.invoke(local ? ['--local-backlog'] : []), 'input');
});
group('document byte limit is inclusive in committed and local modes', [false, true], (f, local) => {
  const content = Buffer.from(('x'.repeat(1023) + '\n').repeat(CAP / 1024)); assert.equal(content.length, CAP);
  f.file(local ? BACKLOG : SHIP, content); if (!local) f.commitDocs(); passed(f.invoke(local ? ['--local-backlog'] : []), local ? 2 : 1, local ? 1 : 0);
  f.file(local ? BACKLOG : SHIP, Buffer.concat([content, Buffer.from('x')])); if (!local) f.commitDocs(); refused(f.invoke(local ? ['--local-backlog'] : []), 'input');
});
test('physical line character limit is inclusive and excludes CRLF', () => withFixture(f => {
  f.file(SHIP, 'x'.repeat(16384) + '\r\n'); f.commitDocs(); passed(f.invoke(), 1, 0);
  f.file(SHIP, 'x'.repeat(16385) + '\n'); f.commitDocs(); refused(f.invoke(), 'input');
}));
test('total closed-item limit is inclusive across both selected documents', () => withFixture(f => {
  f.file(SHIP, heading().repeat(512)); f.file(BACKLOG, heading().repeat(512)); f.commitDocs(); passed(f.invoke(), 2, 1024);
  f.file(BACKLOG, heading().repeat(513)); f.commitDocs(); refused(f.invoke(), 'input');
}));

// This is source wiring only; no workflow command is run by this test.
test('required validate job runs the fixed default lint after committed metadata preparation', () => {
  feature();
  const require = createRequire(path.join(ROOT, 'package.json'));
  const workflow = require('yaml').parse(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs.validate.steps;
  const metadata = steps.findIndex(step => step.run === 'npx --no-install tsx verification/claim-validator.ts --all --no-rerun');
  const matches = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.run === 'npx --no-install tsx scripts/lint-closures.mjs');
  assert.equal(matches.length, 1, 'one literal default-mode closure lint step');
  assert.ok(metadata >= 0 && matches[0].index > metadata, 'reuse existing metadata/ref preparation ordering');
  assert.equal(matches[0].step['continue-on-error'], undefined);
  assert.equal(matches[0].step.if, undefined, 'required default lint must not be conditional');
});
