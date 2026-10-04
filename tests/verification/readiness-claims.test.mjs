// specs/verification/readiness-claims.md — declared-state equality, never semantic readiness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/lint-readiness-claims.mjs');
const HELPER = path.join(ROOT, 'tests/verification/fixtures/stage-committed-claims.sh');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const LAUNCH = 'docs/LAUNCH_READINESS.md', SHIP = 'SHIP_BLOCKERS.md';
const IDS = ['claim-2026-10-04-941', 'claim-2026-10-04-942'];
const PRIVATE = 'MR12B_PRIVATE_SOURCE_SENTINEL';
const CAP = 262144, LINE_CAP = 32768;
const digest = value => createHash('sha256').update(value).digest('hex');
const atom = (state = 'verified', id = IDS[0]) => `${state}; claim:${id}`;
const ROADMAP = '## Masterpiece roadmap to v1.0.0 (Session 14 binding)';
const HEADER = '| Version | Theme | Status | Hours done | Hours remaining | Progress | Ship gate |';
const DELIMITER = '|---|---|---|---:|---:|---:|---|';
const versionRow = (status = atom(), version = 'v1.2.3') => `| ${version} | Owned theme | ${status} | 0 | 0 | 0% | Owned gate |`;
const currentTable = (status = atom()) => `${ROADMAP}\n\n${HEADER}\n${DELIMITER}\n${versionRow(status)}\n`;
const yaml = (value, indent = 0) => Object.entries(value).map(([key, item]) => {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(item)) return `${prefix}${key}:\n${item.map(v => `${prefix}  - ${JSON.stringify(v)}\n`).join('')}`;
  if (item !== null && typeof item === 'object') return `${prefix}${key}:\n${yaml(item, indent + 2)}`;
  return `${prefix}${key}: ${JSON.stringify(item)}\n`;
}).join('');
function feature() { assert.ok(existsSync(SCRIPT), 'FEATURE_ABSENT: scripts/lint-readiness-claims.mjs is not implemented'); }
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
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'readiness-claim-')));
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
    return setupResult(spawnSync(git, ['-C', root, '-c', 'user.name=MR12B owned fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: outer, env: setupEnv, encoding: 'utf8', timeout: 10000 }));
  }
  try {
    file('package.json', '{"type":"module"}\n');
    copyFileSync(SCRIPT, file('scripts/lint-readiness-claims.mjs', ''));
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
    file('.workflow/proofs/committed/_checks/declared.json', '{"declared":true}\n');
    documents[0].claim.state = 'verified'; documents[1].claim.state = 'fixed_not_live';
    saveClaims(); bind(); stage('publish');
    file(LAUNCH, currentTable()); file(SHIP, '# Owned ship blockers\n');
    function commitDocs() { gitSetup(['add', '-A', '--', LAUNCH, SHIP]); gitSetup(['commit', '-q', '--allow-empty', '-m', 'Owned readiness documents']); }
    commitDocs();
    function wrapper(mode = 'normal', replacement = '') {
      const source = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2),mode=${JSON.stringify(mode)};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a})+'\\n');\n` +
        `if(mode==='deny')process.exit(91);if(mode==='document-error'&&a.includes('ls-tree')&&a.at(-1)===${JSON.stringify(LAUNCH)}){process.stderr.write(${JSON.stringify(PRIVATE)},()=>process.exit(39));return;}\n` +
        `const r=cp.spawnSync(${JSON.stringify(git)},a,{encoding:null});if(r.error)process.exit(92);\n` +
        `if(mode==='race'&&a.slice(-4).join(' ')==='rev-parse --verify --end-of-options refs/remotes/origin/main'){for(const ref of ['refs/heads/fixture','refs/remotes/origin/main']){const moved=cp.spawnSync(${JSON.stringify(git)},['--git-dir='+${JSON.stringify(root + '/.git')},'--work-tree='+${JSON.stringify(root)},'-c','user.name=MR12B owned fixture','-c','user.email=fixture@example.invalid','update-ref',ref,${JSON.stringify(replacement)}],{env:process.env});if(moved.status!==0)process.exit(93);}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({moved:true})+'\\n');}\n` +
        `process.stdout.write(r.stdout||'',()=>process.stderr.write(r.stderr||'',()=>process.exit(r.status??94)));\n`;
      writeFileSync(path.join(bin, 'git'), source); chmodSync(path.join(bin, 'git'), 0o755);
    }
    wrapper(); writeFileSync(log, '');
    const f = { root, outer, elsewhere, file, documents, publication, manifestPath, saveClaims, bind, stage, commitDocs, gitSetup, wrapper,
      invoke(args = [], cwd = root, moving = false, entry = 'scripts/lint-readiness-claims.mjs') {
        writeFileSync(log, '');
        const ignored = [log, launcher, ...(moving ? ['refs/heads/fixture', 'refs/remotes/origin/main', 'logs/HEAD', 'logs/refs/heads/fixture', 'logs/refs/remotes/origin/main'].map(name => path.join(root, '.git', name)) : [])];
        const before = tree(outer, ignored);
        const result = spawnSync(process.execPath, [TSX, path.join(root, entry), ...args], { cwd,
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
function passed(result, declarations = 1, processRows = 0, historyTables = 0) {
  assert.equal(result.status, 0, result.output); assert.equal(result.stderr, '');
  assert.equal(result.stdout, declarations ? `readiness: references valid documents=2 declarations=${declarations} process_rows=${processRows} history_tables=${historyTables}\n` : `readiness: none selected documents=2 declarations=0 process_rows=${processRows} history_tables=${historyTables}\n`);
}
function refused(result, category) { assert.equal(result.status, 1, result.output); assert.equal(result.stdout, ''); assert.equal(result.stderr, `readiness: ${category}\n`); }
function group(name, values, run) { test(name, () => { for (const value of values) withFixture(f => run(f, value)); }); }

test('nonempty readiness declaration uses actual publication independent of caller CWD', () => withFixture(f => {
  passed(f.invoke()); passed(f.invoke([], f.elsewhere));
  f.file(LAUNCH, currentTable('`verified`; claim:' + IDS[0])); f.commitDocs(); passed(f.invoke());
}));
group('all six supported states are exact inert declarations rather than evidence upgrades',
  ['implemented', 'verified', 'code_converged', 'release_ready', 'fixed_not_live', 'production_complete'], (f, state) => {
    const beforeHash = f.documents[0].claim.reproducibility_hash;
    f.documents[0].claim.state = state; f.saveClaims(); f.bind(); f.stage('publish');
    assert.equal(f.documents[0].claim.reproducibility_hash, beforeHash, 'state does not alter the command/environment/GREEN hash');
    assert.equal(Object.hasOwn(f.documents[0].claim.proof, 'deploy'), false);
    f.file(LAUNCH, currentTable(atom(state))); f.commitDocs(); passed(f.invoke());
  });
group('a cited member with missing or unequal state cannot support a declaration', [undefined, 'implemented', 'production_complete'], (f, state) => {
  if (state === undefined) delete f.documents[0].claim.state; else f.documents[0].claim.state = state;
  f.saveClaims(); f.bind(); f.stage('publish'); refused(f.invoke(), 'reference');
});
test('a well-formed unknown full claim ID cannot borrow another members state', () => withFixture(f => {
  f.file(LAUNCH, currentTable(atom('verified', 'claim-2026-10-04-999'))); f.commitDocs(); refused(f.invoke(), 'reference');
}));
group('missing malformed shorthand and surplus citations refuse structurally', [
  'verified', 'verified; claim:055', 'verified; claim:claim-2026-10-04-94',
  atom() + '; claim:' + IDS[1], atom() + ' surplus', 'verified;claim:' + IDS[0],
], (f, status) => { f.file(LAUNCH, currentTable(status)); f.commitDocs(); refused(f.invoke(), 'structure'); });
test('an unrelated adjacent field cannot supply the Status citation', () => withFixture(f => {
  f.file(LAUNCH, currentTable('verified').replace('Owned gate', 'claim:' + IDS[0])); f.commitDocs(); refused(f.invoke(), 'structure');
}));

test('fixed_not_live has no ordinal relationship to production_complete', () => withFixture(f => {
  f.file(LAUNCH, currentTable(atom('production_complete', IDS[1]))); f.commitDocs(); refused(f.invoke(), 'reference');
  f.file(LAUNCH, currentTable(atom('fixed_not_live', IDS[1]))); f.commitDocs(); passed(f.invoke());
}));
test('uncommitted and staged readiness edits do not replace captured HEAD documents', () => withFixture(f => {
  f.file(LAUNCH, currentTable('SHIPPED')); passed(f.invoke());
  f.gitSetup(['add', '--', LAUNCH]); passed(f.invoke());
}));
test('a dirty claim state is refused instead of reread as supporting metadata', () => withFixture(f => {
  f.documents[0].claim.state = 'production_complete'; f.saveClaims(); f.bind();
  refused(f.invoke(), 'publication');
  f.gitSetup(['add', '--', '.workflow/proofs/committed']); refused(f.invoke(), 'publication');
}));
group('an invalid uncited member prevents publication authority', ['state', 'schema', 'anchor'], (f, fault) => {
  if (fault === 'state') f.documents[1].claim.state = PRIVATE;
  else if (fault === 'schema') f.documents[1].claim.confidence = PRIVATE;
  else f.documents[1].claim.spec_ref = 'specs/fixture.md#missing';
  f.saveClaims(); f.bind(); f.stage('publish'); refused(f.invoke(), 'publication');
});
test('documents and declared states stay bound to one captured HEAD and main generation', () => withFixture(f => {
  const replacement = f.stage('orphan').ORPHAN; f.wrapper('race', replacement);
  const result = f.invoke([], f.elsewhere, true); passed(result);
  assert.equal(result.calls.filter(call => call.moved).length, 1);
  const captures = result.calls.filter(call => call.args?.includes('rev-parse') && call.args.includes('--verify'));
  assert.equal(captures.filter(call => call.args.at(-1) === 'HEAD').length, 1);
  assert.equal(captures.filter(call => call.args.at(-1) === 'refs/remotes/origin/main').length, 1);
  for (const ref of ['refs/heads/fixture', 'refs/remotes/origin/main']) assert.equal(readFileSync(path.join(f.root, '.git', ref), 'utf8'), replacement + '\n');
}));
test('usage fails before Git and never echoes an unknown argument', () => withFixture(f => {
  f.wrapper('deny'); const result = f.invoke(['--root', PRIVATE]); refused(result, 'usage'); assert.deepEqual(result.calls, []);
}));
test('importing the actual lint does not execute its CLI or access Git', () => withFixture(f => {
  f.file('scripts/import-only.mjs', "import './lint-readiness-claims.mjs';\nprocess.stdout.write('imported\\n');\n");
  f.wrapper('deny'); const result = f.invoke([], f.elsewhere, false, 'scripts/import-only.mjs');
  assert.equal(result.status, 0, result.output); assert.equal(result.stdout, 'imported\n');
  assert.equal(result.stderr, ''); assert.deepEqual(result.calls, []);
}));
test('shared publication exposes only immutable IDs and own optional state declarations', () => withFixture(f => {
  delete f.documents[1].claim.state; f.saveClaims(); f.bind(); f.stage('publish');
  f.file('scripts/project-declarations.mjs',
    "import {openValidatedPublication} from '../verification/committed-claims.ts';\n" +
    "import {compute} from '../verification/reproducibility-check.ts';\n" +
    "const p=openValidatedPublication(process.cwd(),c=>compute(c.proof.git_sha,c.proof.test_command,c.proof.environment??{}));\n" +
    "process.stdout.write(JSON.stringify({frozen:Object.isFrozen(p)&&Object.isFrozen(p.claimDeclarations)&&p.claimDeclarations.every(Object.isFrozen),rows:p.claimDeclarations})+'\\n');\n");
  const result = f.invoke([], f.root, false, 'scripts/project-declarations.mjs');
  assert.equal(result.status, 0, result.output); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { frozen: true, rows: [{ id: IDS[0], state: 'verified' }, { id: IDS[1] }] });
}));
test('document Git errors are input refusal rather than zero declarations', () => withFixture(f => {
  f.wrapper('document-error'); const result = f.invoke(); refused(result, 'input');
  assert.ok(result.calls.some(call => call.args?.includes('ls-tree') && call.args.at(-1) === LAUNCH));
}));
function paddedDocument(bytes) {
  let text = '# Owned bounded notes\n';
  while (Buffer.byteLength(text) < bytes) {
    const remaining = bytes - Buffer.byteLength(text);
    text += 'x'.repeat(Math.min(LINE_CAP, remaining - 1)) + '\n';
  }
  assert.equal(Buffer.byteLength(text), bytes); return text;
}
test('inclusive document and physical-line byte caps admit valid source', () => withFixture(f => {
  f.file(SHIP, paddedDocument(CAP)); f.commitDocs(); passed(f.invoke());
}));
group('over-limit bytes and invalid UTF-8 refuse private document input', [
  Buffer.from(paddedDocument(CAP + 1)), Buffer.from('x'.repeat(LINE_CAP + 1) + '\n'),
  Buffer.from('é'.repeat(LINE_CAP / 2 + 1) + '\n'), Buffer.from([0x23, 0x20, 0xc3, 0x28]),
], (f, bytes) => { f.file(SHIP, bytes); f.commitDocs(); refused(f.invoke(), 'input'); });
group('both fixed documents are required', [LAUNCH, SHIP], (f, name) => {
  rmSync(path.join(f.root, name)); f.commitDocs(); refused(f.invoke(), 'input');
});
group('committed redirected and nonregular readiness leaves refuse', ['symlink', 'tree'], (f, kind) => {
  rmSync(path.join(f.root, SHIP));
  if (kind === 'symlink') symlinkSync(LAUNCH, path.join(f.root, SHIP));
  else f.file(SHIP + '/child.md', '# Owned nested data\n');
  f.commitDocs(); refused(f.invoke(), 'input');
});

group('closed native process prefixes report none selected rather than readiness', [
  'IN PROGRESS', 'IN PROGRESS (owned notes)', 'IN PROGRESS: owned notes',
  'NOT STARTED as redefined. Owned notes', '**DROPPED** (owned decision)',
  'EVIDENCE PENDING owned notes', '**EVIDENCE PENDING**',
], (f, status) => { f.file(LAUNCH, currentTable(status)); f.commitDocs(); passed(f.invoke(), 0, 1); });
group('unknown positive and malformed process Status forms cannot evade state support', [
  'SHIPPED', '**SHIPPED** (recorded event)', 'SHIPPED; claim:' + IDS[0],
  'DONE', 'READY', 'VERIFIED', 'IN PROGRESSIVE', 'DROPPED: notes', '**DROPPED* notes',
], (f, status) => { f.file(LAUNCH, currentTable(status)); f.commitDocs(); refused(f.invoke(), 'structure'); });
test('process notes still select their own explicit state atom', () => withFixture(f => {
  f.file(LAUNCH, currentTable('IN PROGRESS note `verified`; claim:' + IDS[0])); f.commitDocs(); passed(f.invoke(), 1, 1);
  f.file(LAUNCH, currentTable('IN PROGRESS note production_complete')); f.commitDocs(); refused(f.invoke(), 'structure');
}));
test('ordinary verbs negation and live-dashboard prose remain honest zero', () => withFixture(f => {
  f.file(LAUNCH, currentTable('NOT STARTED'));
  f.file(SHIP, '# Owned notes\nThe code is not verified or implemented.\nA live dashboard exists as an ordinary description.\nverified implementation; xproduction_complete production_complete_suffix\n');
  f.commitDocs(); passed(f.invoke(), 0, 1);
}));
test('zero selected declarations still require full nonempty publication', () => withFixture(f => {
  f.file(LAUNCH, currentTable('EVIDENCE PENDING')); f.commitDocs(); passed(f.invoke(), 0, 1);
  const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8')); manifest.claims = [];
  writeFileSync(f.manifestPath, JSON.stringify(manifest)); f.stage('publish'); refused(f.invoke(), 'publication');
}));
group('labelled and inline forms count each supported atom once', [
  'State: ' + atom(), '**State:** ' + atom(), ' \t**State:** `verified`; claim:' + IDS[0] + '\t ',
  'Owned result `verified`; claim:' + IDS[0],
], (f, text) => { f.file(SHIP, text + '\n'); f.commitDocs(); passed(f.invoke(), 2); });
test('bare strong tokens and overlapping code selectors retain exact equal-state support', () => withFixture(f => {
  f.documents[0].claim.state = 'code_converged'; f.saveClaims(); f.bind(); f.stage('publish');
  f.file(LAUNCH, currentTable('IN PROGRESS'));
  f.file(SHIP, 'Owned scope code_converged; claim:' + IDS[0] + '\n`fixed_not_live`; claim:' + IDS[1] + '\n');
  f.commitDocs(); passed(f.invoke(), 2, 1);
}));
group('selected state labels cannot become ignored malformed prose', [
  'State: unknown; claim:' + IDS[0], 'State: verified', 'State:  ' + atom(),
  '**State:**\t' + atom(), 'State: ' + atom() + '; extra',
], (f, text) => { f.file(SHIP, text + '\n'); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('quote blockquote suffix and long-backtick escapes do not waive declarations', [
  '"production_complete"', '> production_complete', '`verified`', '``verified``; claim:' + IDS[0],
  'Owned result `verified`; claim:' + IDS[0] + 'x', 'Owned result `verified`; claim:' + IDS[0] + '.',
  'Owned result `verified`; claim:' + IDS[0] + ' trailing prose',
  'code_converged\nclaim:' + IDS[0],
], (f, text) => { f.file(SHIP, text + '\n'); f.commitDocs(); refused(f.invoke(), 'structure'); });
test('fenced examples and standalone comments exclude declarations without hiding current tables', () => withFixture(f => {
  f.file(SHIP, '````md\n```\nproduction_complete ' + PRIVATE + '\n`````\n~~~\n`verified`\n~~~\n<!--\nState: ' + PRIVATE + '\n-->\n<!-- production_complete -->\n');
  f.commitDocs(); passed(f.invoke());
}));
group('unclosed nested and mixed regions cannot hide or synthesize declarations', [
  '```\n' + PRIVATE, '~~~\n' + PRIVATE, '<!-- ' + PRIVATE, '<!-- <!-- nested -->\n',
  'pro<!-- hidden -->duction_complete', 'State: ver<!-- hidden -->ified; claim:' + IDS[0],
  '<!-- hidden --> production_complete',
], (f, text) => { f.file(SHIP, text); f.commitDocs(); refused(f.invoke(), 'structure'); });

test('SHIP may add a supported table and TOTAL remains an aggregate', () => withFixture(f => {
  f.file(LAUNCH, currentTable('IN PROGRESS') + '| **TOTAL to v1.0.0** | — | — | 0 | 0 | 0% | — |\n');
  f.file(SHIP, HEADER + '\n' + DELIMITER + '\n' + versionRow(atom('fixed_not_live', IDS[1]), '**v01.02.x**') + '\n');
  f.commitDocs(); passed(f.invoke(), 1, 1);
}));
group('missing duplicate or misplaced required heading and Version table refuse', [
  '# No roadmap\n', currentTable().replace(ROADMAP, '## Different heading'),
  currentTable() + '\n' + ROADMAP + '\n', ROADMAP + '\n\n',
  currentTable() + '\n' + HEADER + '\n' + DELIMITER + '\n' + versionRow() + '\n',
  ROADMAP + '\n\n## Later section\n' + HEADER + '\n' + DELIMITER + '\n' + versionRow() + '\n',
], (f, text) => { f.file(LAUNCH, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('closed table header delimiter and row shape cannot silently lose a current Status', [
  currentTable().replace('Hours remaining', 'Other'), currentTable().replace(DELIMITER, '|---|---|---|---|---|---|---|'),
  currentTable().replace('| Owned theme |', '| Owned\\|theme |'),
  currentTable().replace('| 0 | 0 | 0% |', '| 0 | 0 |'),
  currentTable().replace(versionRow(), versionRow().slice(0, -1)),
  currentTable().replace('v1.2.3', 'release-1'),
  currentTable().replace(versionRow(), '| **TOTAL to v1.0.0** | — | — | 0 | 0 | 0% | — |'),
], (f, text) => { f.file(LAUNCH, text); f.commitDocs(); refused(f.invoke(), 'structure'); });
group('aggregate status and duplicate totals have their own closed grammar', [
  '| **TOTAL to v1.0.0** | — | verified | 0 | 0 | 0% | — |\n',
  '| **TOTAL to v1.0.0** | — | — | 0 | 0 | 0% | — |\n'.repeat(2),
], (f, rows) => { f.file(LAUNCH, currentTable() + rows); f.commitDocs(); refused(f.invoke(), 'structure'); });

function actualHistory() {
  const lines = readFileSync(path.join(ROOT, LAUNCH), 'utf8').split('\n');
  const prefix = '**History: the rows as they stood before the 2026-09-26 redefinition.';
  const indices = lines.flatMap((line, index) => line.startsWith(prefix) ? [index] : []);
  assert.equal(indices.length, 1, 'named ordinary document must retain the sole bound history notice');
  const start = indices[0], notice = lines.slice(start, start + 6).join('\n') + '\n';
  const table = lines.slice(start + 6, start + 12).join('\n') + '\n';
  assert.equal(Buffer.byteLength(notice), 351); assert.equal(Buffer.byteLength(table), 28491);
  assert.equal(digest(notice), 'd928bf9e652eafd8e7518b80697f2f01a2a494e1bf0a03769bc93c48c0b1239d');
  assert.equal(digest(table), '0714ab707a6e2c09cbb84483d4d571b467bfa98227b96a9ef6e3ddfa1fc0c8a9');
  return notice + table;
}
test('only the unchanged adjacent historical block is excluded and counted', () => withFixture(f => {
  f.file(LAUNCH, currentTable() + '\n' + actualHistory()); f.commitDocs(); passed(f.invoke(), 1, 0, 1);
  f.file(LAUNCH, currentTable() + '\n' + actualHistory() + '\nState: verified\n'); f.commitDocs(); refused(f.invoke(), 'structure');
}));
group('changed partial moved duplicated or generic historical regions cannot waive checks', [
  'notice', 'table', 'partial', 'moved', 'duplicate', 'generic', 'fenced', 'commented',
], (f, fault) => {
  const block = actualHistory(); let text;
  if (fault === 'notice') text = currentTable() + '\n' + block.replace('378059e', '378059f');
  if (fault === 'table') text = currentTable() + '\n' + block.replace('~84', '~85');
  if (fault === 'partial') text = currentTable() + '\n' + block.slice(0, 351);
  if (fault === 'moved') text = currentTable() + '\n## Elsewhere\n' + block;
  if (fault === 'duplicate') text = currentTable() + '\n' + block + '\n' + block;
  if (fault === 'fenced') text = currentTable() + '\n```md\n' + block + '```\n';
  if (fault === 'commented') text = currentTable() + '\n<!--\n' + block + '-->\n';
  if (fault === 'generic') text = currentTable() + '\n## History\n' + HEADER + '\n' + DELIMITER + '\n' + versionRow('SHIPPED') + '\n';
  f.file(LAUNCH, text); f.commitDocs(); refused(f.invoke(), 'structure');
});

// REQ-3 selects whole code spans; adjacent spans cannot donate delimiters.
test('ordinary words between separate noncanonical code spans are not declarations', () => withFixture(f => {
  f.file(SHIP, '`foo`verified`bar`\n`left`implemented`right`\n');
  f.commitDocs(); passed(f.invoke());
}));
