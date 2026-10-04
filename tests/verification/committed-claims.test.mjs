// specs/verification/committed-claims.md REQ-1..7 / AC-1..3, AC-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, linkSync, renameSync, rmSync, existsSync, realpathSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HELPER = path.join(import.meta.dirname, 'fixtures/stage-committed-claims.sh');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const IDS = ['claim-2026-10-03-911', 'claim-2026-10-03-912'];
const SENTINEL = 'PRIVATE_MR10B_SENTINEL';
const COMPANIONS = ['claim-input.ts', 'committed-claims.ts', 'committed-git.ts'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const yaml = (value, indent = 0) => Object.entries(value).map(([key, item]) => {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(item)) return `${prefix}${key}:\n${item.map(v => `${prefix}  - ${JSON.stringify(v)}\n`).join('')}`;
  if (item !== null && typeof item === 'object') return `${prefix}${key}:\n${yaml(item, indent + 2)}`;
  return `${prefix}${key}: ${JSON.stringify(item)}\n`;
}).join('');
function tree(directory, ignored = []) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (ignored.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...tree(file, ignored)];
    return [[file, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : stat.isFile() ? hash(readFileSync(file)) : 'special']];
  });
}
function fixture(options = {}) {
  for (const file of [TSX, HELPER, 'verification/claim-validator.ts', 'verification/claim-schema.yml'].map(f => path.resolve(ROOT, f))) assert.ok(existsSync(file), 'owned fixture source prerequisite');
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'committed-claim-')));
  const cwd = path.join(outer, 'repo'); const pkg = path.join(outer, 'package'); const bin = path.join(outer, 'bin');
  const launcher = path.join(outer, 'launcher'); const log = path.join(outer, 'git.jsonl');
  const publication = path.join(cwd, '.workflow/proofs/committed'); const manifestPath = path.join(publication, 'manifest.json');
  for (const dir of [path.join(cwd, 'src'), path.join(cwd, 'specs'), path.join(pkg, 'verification'), bin, launcher]) mkdirSync(dir, { recursive: true });
  for (const name of ['claim-validator.ts', 'claim-schema.yml', ...COMPANIONS]) {
    const source = path.join(ROOT, 'verification', name);
    if (existsSync(source)) copyFileSync(source, path.join(pkg, 'verification', name));
  }
  writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  writeFileSync(path.join(cwd, 'src/changed.txt'), 'Owned initial content\n');
  writeFileSync(path.join(cwd, 'specs/fixture.md'), options.spec ?? '# Fixture\n\n## AC-1\n');
  options.beforeInit?.(cwd);
  function stage(action) {
    const result = spawnSync('/bin/bash', [HELPER, action, cwd], { cwd: outer, env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stdout + result.stderr);
    const fields = Object.fromEntries(result.stdout.trim().split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => { const p = line.indexOf('='); return [line.slice(0, p), line.slice(p + 1)]; }));
    assert.equal(fields.TOPLEVEL, cwd); assert.ok(path.isAbsolute(fields.GIT_BIN)); return fields;
  }
  const initial = stage('init'); const git = initial.GIT_BIN;
  for (const dir of ['claims', 'scripts', '_checks']) mkdirSync(path.join(publication, dir), { recursive: true });
  const documents = IDS.map(id => ({ claim: { id, type: 'doc', spec_ref: 'specs/fixture.md#ac-1', description: 'Owned committed metadata declaration.',
    proof: { git_sha: initial.TARGET, files_changed: ['src/changed.txt'], test_command: 'touch command-executed', test_exit_code: 7,
      test_output_path: '.workflow/proofs/never-created.log', environment: { INERT: SENTINEL } }, confidence: 'high', reproducibility_hash: '', extra: 'schema permits additional fields' } }));
  let manifest;
  function saveClaims() {
    for (const doc of documents) {
      const c = doc.claim; const env = c.proof.environment ?? {};
      c.reproducibility_hash = 'sha256:' + hash(`${c.proof.test_command}\n---\n${Object.keys(env).sort().map(k => `${k}=${env[k]}`).join('\n')}\n---\n${c.proof.git_sha}`);
      writeFileSync(path.join(publication, 'claims', IDS[documents.indexOf(doc)] + '.yml'), yaml(doc));
    }
  }
  function bind() {
    manifest = { schema_version: 1, claims: IDS.map(id => ({ id, path: `claims/${id}.yml`, sha256: hash(readFileSync(path.join(publication, 'claims', id + '.yml'))) })),
      artifacts: ['scripts/inert.mjs', '_checks/observations.json'].map(relative => ({ path: relative, sha256: hash(readFileSync(path.join(publication, relative))) })) };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  writeFileSync(path.join(publication, 'scripts/inert.mjs'), 'throw new Error("This declaration must never execute");\n');
  writeFileSync(path.join(publication, '_checks/observations.json'), '{"declared":true}\n');
  saveClaims(); bind(); const published = stage('publish');
  function wrapper(mode = 'normal', replacement = '') {
    const source = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const a=process.argv.slice(2);const log=${JSON.stringify(log)};const mode=${JSON.stringify(mode)};fs.appendFileSync(log,JSON.stringify({args:a,env:process.env})+'\\n');\n` +
      `if(mode==='deny')process.exit(91);if(mode==='exit'){process.stderr.write(${JSON.stringify(SENTINEL)});process.exit(37);}if(mode==='signal')process.kill(process.pid,'SIGTERM');if(mode==='overflow'){process.stdout.write('x'.repeat(2*1048576),()=>process.exit(0));return;}if(mode==='malformed'){process.stdout.write(${JSON.stringify(SENTINEL + '\n')});process.exit(0);}if(mode==='timeout'){setTimeout(()=>{fs.appendFileSync(log,JSON.stringify({deadman:true})+'\\n');process.exit(99);},9000);}else{const r=cp.spawnSync(${JSON.stringify(git)},a,{encoding:null});if(r.error)process.exit(92);\n` +
      `if(mode==='race'&&a.slice(-4).join(' ')==='rev-parse --verify --end-of-options refs/remotes/origin/main'){for(const ref of ['refs/heads/fixture','refs/remotes/origin/main']){const m=cp.spawnSync(${JSON.stringify(git)},['--git-dir='+${JSON.stringify(cwd + '/.git')},'--work-tree='+${JSON.stringify(cwd)},'-c','core.hooksPath=/dev/null','-c','user.name=MR10B owned fixture','-c','user.email=fixture@example.invalid','update-ref',ref,${JSON.stringify(replacement)}],{env:process.env});if(m.status!==0)process.exit(93);}fs.appendFileSync(log,JSON.stringify({moved:true})+'\\n');}\n` +
      `process.stdout.write(r.stdout||'',()=>process.stderr.write(r.stderr||'',()=>process.exit(r.status??94)));}\n`;
    writeFileSync(path.join(bin, 'git'), source); chmodSync(path.join(bin, 'git'), 0o755);
  }
  wrapper(); writeFileSync(log, '');
  return { outer, cwd, pkg, publication, manifestPath, documents, target: initial.TARGET, head: published.PUBLICATION, git, log, stage, saveClaims, bind, wrapper,
    manifest: () => manifest,
    setManifest(value) { manifest = value; writeFileSync(manifestPath, JSON.stringify(value, null, 2) + '\n'); },
    commit() { return stage('publish'); },
    invoke(args = ['--all', '--no-rerun'], extraEnv = {}, movingRefs = false) {
      writeFileSync(log, ''); const ignored = [log, launcher, ...(movingRefs ? ['refs/heads/fixture', 'refs/remotes/origin/main', 'logs/HEAD', 'logs/refs/heads/fixture', 'logs/refs/remotes/origin/main'].map(name => path.join(cwd, '.git', name)) : [])]; const before = tree(outer, ignored);
      const result = spawnSync(process.execPath, [TSX, path.join(pkg, 'verification/claim-validator.ts'), ...args], { cwd,
        env: { PATH: bin + path.delimiter + process.env.PATH, HOME: cwd, TMPDIR: launcher, LANG: 'C', LC_ALL: 'C', TSX_DISABLE_CACHE: '1', ...extraEnv }, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1048576 });
      assert.equal(result.error, undefined, 'fixture launcher must complete'); assert.equal(result.signal, null);
      assert.deepEqual(tree(outer, ignored), before, 'validator must not mutate fixture inputs or create replay artifacts');
      assert.equal(existsSync(path.join(cwd, 'command-executed')), false);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /, 'dependency/syntax failures cannot witness feature RED');
      assert.equal(output.includes(SENTINEL), false, 'raw declarations/Git output must remain private');
      return { ...result, output, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
    }, cleanup() { rmSync(outer, { recursive: true, force: true }); } };
}
function withFixture(run, options) { const f = fixture(options); try { run(f); } finally { f.cleanup(); } }
function accepted(r) { assert.equal(r.status, 0, r.output); assert.match(r.output, /committed claim metadata/i); assert.doesNotMatch(r.output, /verified (?:GREEN|RED)|commands? (?:passed|executed)/i); }
function refused(r, reason = /committed/i) { assert.notEqual(r.status, 0, r.output); assert.match(r.output, /committed/i); assert.match(r.output, reason); }
function changedClaim(f, fn) { fn(f.documents[0].claim); f.saveClaims(); f.bind(); f.commit(); }

for (const args of [['--all', '--no-rerun'], ['--no-rerun', '--all'], ['--claim', IDS[0], '--no-rerun'], ['--no-rerun', '--claim', IDS[1]]]) test(`committed selector accepts exact shape ${args.join(' ')}`, () => withFixture(f => accepted(f.invoke(args))));
for (const [name, args] of [
  ['missing safety flag', ['--all']], ['attached all', ['--all=x', '--no-rerun']], ['attached claim', ['--claim=x', '--no-rerun']],
  ['repeated all', ['--all', '--all', '--no-rerun']], ['conflicting selectors', ['--all', '--claim', IDS[0], '--no-rerun']],
  ['missing claim ID', ['--claim', '--no-rerun']], ['interrupted claim pair', ['--claim', '--no-rerun', IDS[0]]],
  ['repeated safety flag', ['--all', '--no-rerun', '--no-rerun']], ['extra positional', ['--all', '--no-rerun', 'other']], ['unsupported flag', ['--all', '--no-rerun', '--wat']],
]) test(`committed usage refuses ${name} before Git`, () => withFixture(f => { const r = f.invoke(args); refused(r, /usage|selector|argument/i); assert.deepEqual(r.calls, []); }));
test('unknown selected ID fails a nonempty bound set', () => withFixture(f => refused(f.invoke(['--claim', 'claim-2026-10-03-999', '--no-rerun']))));
test('committed missing manifest fails rather than implicit empty success', () => withFixture(f => { rmSync(f.publication, { recursive: true }); refused(f.invoke()); }));
for (const [name, alter] of [
  ['empty claims', m => { m.claims = []; }], ['empty artifacts', m => { m.artifacts = []; }], ['wrong version', m => { m.schema_version = 2; }],
  ['unknown key', m => { m[SENTINEL] = true; }], ['duplicate claim ID', m => { m.claims.push(m.claims[0]); }],
  ['duplicate artifact path', m => { m.artifacts.push(m.artifacts[0]); }], ['bad digest', m => { m.claims[0].sha256 = 'A'.repeat(64); }],
  ['wrong ID/path binding', m => { m.claims[0].path = m.claims[1].path; }], ['escaping artifact', m => { m.artifacts[0].path = '../private'; }],
  ['dot component', m => { m.artifacts[0].path = 'scripts/./inert.mjs'; }], ['backslash', m => { m.artifacts[0].path = 'scripts\\inert.mjs'; }],
  ['log artifact', m => { m.artifacts[0].path = 'scripts/private.log'; }],
]) test(`manifest refuses ${name}`, () => withFixture(f => { const m = f.manifest(); alter(m); f.setManifest(m); f.commit(); refused(f.invoke(), /manifest|member|input/i); }));
for (const over of [false, true]) test(`manifest byte cap inclusive, over=${over}`, () => withFixture(f => {
  const bytes = readFileSync(f.manifestPath); writeFileSync(f.manifestPath, Buffer.concat([bytes, Buffer.alloc(65536 + Number(over) - bytes.length, 32)])); f.commit();
  const r = f.invoke(); if (over) refused(r); else accepted(r);
}));
for (const over of [false, true]) test(`artifact byte cap inclusive, over=${over}`, () => withFixture(f => {
  writeFileSync(path.join(f.publication, 'scripts/inert.mjs'), ' '.repeat(262144 + Number(over))); f.bind(); f.commit();
  const r = f.invoke(); if (over) refused(r); else accepted(r);
}));
test('invalid UTF-8 artifact is refused despite correct committed digest', () => withFixture(f => { writeFileSync(path.join(f.publication, 'scripts/inert.mjs'), Buffer.from([0xff])); f.bind(); f.commit(); refused(f.invoke()); }));

for (const state of ['working', 'staged', 'untracked']) test(`publication rejects ${state} replacement evidence`, () => withFixture(f => {
  const artifact = path.join(f.publication, 'scripts/inert.mjs');
  if (state === 'untracked') {
    const names = ['manifest.json', ...f.manifest().claims.map(m => m.path), ...f.manifest().artifacts.map(m => m.path)];
    const saved = names.map(name => [name, readFileSync(path.join(f.publication, name))]);
    rmSync(f.publication, { recursive: true }); f.stage('publish');
    for (const [name, bytes] of saved) { const file = path.join(f.publication, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); }
  }
  else { writeFileSync(artifact, '// changed working declaration\n'); f.bind(); if (state === 'staged') f.stage('stage'); }
  refused(f.invoke());
}));
test('unlisted tracked publication member is refused', () => withFixture(f => { writeFileSync(path.join(f.publication, 'scripts/unlisted.mjs'), '// extra\n'); f.commit(); refused(f.invoke(), /publication|member|manifest/i); }));
test('claim selection still binds the unselected claim bytes', () => withFixture(f => { writeFileSync(path.join(f.publication, 'claims', IDS[1] + '.yml'), '# changed unselected member\n'); refused(f.invoke(['--claim', IDS[0], '--no-rerun'])); }));
test('claim selection narrows schema validation after every member is bound', () => withFixture(f => {
  f.documents[1].claim.description = 'x'; f.saveClaims(); f.bind(); f.commit(); accepted(f.invoke(['--claim', IDS[0], '--no-rerun']));
}));
test('unlisted local historical data stays outside committed selection', () => withFixture(f => {
  // The owned poison stands for unselected local history; no real local proof is read.
  writeFileSync(path.join(f.cwd, '.workflow/proofs', 'not-selected.yml'), SENTINEL + '\n');
  writeFileSync(path.join(f.publication, 'untracked-extra.yml'), SENTINEL + '\n');
  accepted(f.invoke());
}));
for (const kind of ['symlink', 'directory']) test(`working member ${kind} is refused`, () => withFixture(f => {
  const member = path.join(f.publication, 'scripts/inert.mjs'); rmSync(member);
  if (kind === 'directory') mkdirSync(member); else { const target = path.join(f.outer, 'owned-target'); writeFileSync(target, '// owned\n'); symlinkSync(target, member); }
  refused(f.invoke());
}));
for (const [name, alter, reason] of [
  ['schema violation', c => { c.description = 'short'; }, /claim|schema/i],
  ['manifest ID mismatch', c => { c.id = 'claim-2026-10-03-999'; }, /claim|member/i],
  ['short existing-looking SHA', c => { c.proof.git_sha = c.proof.git_sha.slice(0, 12); }, /claim|git/i],
]) test(`committed claim refuses ${name}`, () => withFixture(f => { changedClaim(f, alter); refused(f.invoke(), reason); }));
test('committed claim retains exact reproducibility hash checking', () => withFixture(f => {
  const file = path.join(f.publication, 'claims', IDS[0] + '.yml'); writeFileSync(file, readFileSync(file, 'utf8').replace(/sha256:[a-f0-9]{64}/, 'sha256:' + '0'.repeat(64))); f.bind(); f.commit(); refused(f.invoke(), /claim|hash/i);
}));
test('copied sibling schema remains authoritative in committed mode', () => withFixture(f => {
  const schema = path.join(f.pkg, 'verification/claim-schema.yml'); writeFileSync(schema, readFileSync(schema, 'utf8').replace('maxLength: 280', 'maxLength: 12')); refused(f.invoke(), /claim|schema/i);
}));
test('ordinary packed refs and objects remain accepted', () => withFixture(f => { f.stage('pack'); accepted(f.invoke()); }));
test('present orphan commit fails captured-main ancestry', () => withFixture(f => {
  const orphan = f.stage('orphan'); assert.equal(orphan.ORPHAN_KIND, 'commit'); changedClaim(f, c => { c.proof.git_sha = orphan.ORPHAN; }); refused(f.invoke(), /git|claim/i);
}));
test('real replacement ref cannot substitute the declared target tree', () => withFixture(f => {
  const orphan = f.stage('orphan'); assert.equal(orphan.ORPHAN_KIND, 'commit');
  mkdirSync(path.join(f.cwd, '.git/refs/replace'), { recursive: true });
  writeFileSync(path.join(f.cwd, '.git/refs/replace', f.target), orphan.ORPHAN + '\n');
  accepted(f.invoke());
}));
test('missing object is not repaired or fetched', () => withFixture(f => { changedClaim(f, c => { c.proof.git_sha = '0'.repeat(40); }); refused(f.invoke(), /git|claim/i); }));
test('missing captured main refuses even with existing target object', () => withFixture(f => { rmSync(path.join(f.cwd, '.git/refs/remotes/origin/main')); refused(f.invoke(), /git/i); }));
test('merge provenance uses its first parent', () => withFixture(f => {
  const target = f.stage('merge').TARGET;
  for (const d of f.documents) { d.claim.proof.git_sha = target; d.claim.proof.files_changed = ['src/side.txt']; }
  f.saveClaims(); f.bind(); f.commit(); accepted(f.invoke());
  changedClaim(f, c => { c.proof.files_changed = ['src/changed.txt']; }); refused(f.invoke(), /claim|git/i);
}));
for (const kind of ['deleted', 'symlink', 'gitlink', 'unchanged']) test(`target changed-file check refuses ${kind}`, () => withFixture(f => {
  let target;
  if (kind === 'deleted') { rmSync(path.join(f.cwd, 'src/changed.txt')); target = f.stage('target').TARGET; }
  else if (kind === 'symlink') { rmSync(path.join(f.cwd, 'src/changed.txt')); symlinkSync('../specs/fixture.md', path.join(f.cwd, 'src/changed.txt')); target = f.stage('target').TARGET; }
  else if (kind === 'gitlink') target = f.stage('gitlink').TARGET;
  else { writeFileSync(path.join(f.cwd, 'src/other.txt'), 'Other content\n'); target = f.stage('target').TARGET; }
  for (const d of f.documents) { d.claim.proof.git_sha = target; d.claim.proof.files_changed = [kind === 'gitlink' ? 'src/module' : 'src/changed.txt']; }
  f.saveClaims(); f.bind(); f.commit(); refused(f.invoke(), /claim|git/i);
}));
test('literal Git path names are not pathspec expressions', () => withFixture(f => {
  for (const d of f.documents) d.claim.proof.files_changed = ['src/[literal].txt']; f.saveClaims(); f.bind(); f.commit(); accepted(f.invoke());
}, { beforeInit(cwd) { writeFileSync(path.join(cwd, 'src/[literal].txt'), 'Literal owned path\n'); } }));
for (const [name, spec, fragment, good] of [
  ['em dash and closing hashes', '   ## REQ-4 — Boundaries ###\n', 'req-4--boundaries', true],
  ['literal case-sensitive ID', '<a id="Exact_ID"></a>\n', 'Exact_ID', true],
  ['case differs for literal ID', '<a id="Exact_ID"></a>\n', 'exact_id', false],
  ['duplicate slug is ambiguous', '# Same\n## Same\n', 'same', false],
  ['duplicate suffix is not inferred', '# Same\n## Same\n', 'same-1', false],
  ['heading inside fence', '```markdown\n## Hidden\n```\n', 'hidden', false],
  ['literal ID in unclosed tilde fence', '~~~~\n<a id="Hidden"></a>\n', 'Hidden', false],
  ['fragment is not URL decoded', '## Two Words\n', 'two%20words', false],
]) test(`target spec anchor: ${name}`, () => withFixture(f => {
  for (const d of f.documents) d.claim.spec_ref = 'specs/fixture.md#' + fragment; f.saveClaims(); f.bind(); f.commit();
  const r = f.invoke(); if (good) accepted(r); else refused(r, /spec|claim/i);
}, { spec }));
test('a newer working spec cannot supply a missing target anchor', () => withFixture(f => {
  writeFileSync(path.join(f.cwd, 'specs/fixture.md'), '## Working Only\n'); changedClaim(f, c => { c.spec_ref = 'specs/fixture.md#working-only'; }); refused(f.invoke(), /spec/i);
}));
test('target spec size cap is enforced on valid UTF-8 content', () => withFixture(f => refused(f.invoke(), /spec|git/i), { spec: '## AC-1\n' + 'x'.repeat(262144) }));

function put(f, relative, value) { const file = path.join(f.cwd, '.git', relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
for (const [name, alter] of [
  ['gitfile', f => { renameSync(path.join(f.cwd, '.git'), path.join(f.outer, 'owned-git')); writeFileSync(path.join(f.cwd, '.git'), 'gitdir: ' + path.join(f.outer, 'owned-git') + '\n'); }],
  ['git directory symlink', f => { renameSync(path.join(f.cwd, '.git'), path.join(f.outer, 'owned-git')); symlinkSync(path.join(f.outer, 'owned-git'), path.join(f.cwd, '.git')); }],
  ['commondir', f => put(f, 'commondir', '../../owned-other\n')], ['shallow', f => put(f, 'shallow', f.target + '\n')],
  ['alternates', f => put(f, 'objects/info/alternates', path.join(f.outer, 'owned-objects') + '\n')],
  ['grafts', f => put(f, 'info/grafts', f.target + '\n')], ['promisor marker', f => put(f, 'objects/pack/owned.promisor', '')],
  ['config worktree', f => put(f, 'config.worktree', '[core]\n bare = false\n')],
  ['symbolic ref escape', f => put(f, 'HEAD', 'ref: ../owned-ref\n')],
  ['metadata symlink', f => { const target = path.join(f.outer, 'owned-ref'); writeFileSync(target, f.target + '\n'); symlinkSync(target, path.join(f.cwd, '.git/refs/heads/redirect')); }],
  ['shared metadata hardlink', f => linkSync(path.join(f.cwd, '.git/HEAD'), path.join(f.outer, 'owned-hardlink'))],
  ['metadata depth17', f => put(f, 'refs/' + Array(17).fill('nested').join('/') + '/tip', f.target + '\n')],
  ['oversized loose ref', f => put(f, 'refs/heads/oversized', 'a'.repeat(65537))],
]) test(`Git admission refuses ${name} before invoking Git`, () => withFixture(f => {
  // Publish first; never call the setup helper after deliberately unsafe metadata injection.
  alter(f); f.wrapper('deny'); const r = f.invoke(); refused(r, /git/i); assert.deepEqual(r.calls, [], 'unsafe metadata must be refused before any Git subprocess');
}));
for (const [name, config] of [
  ['include section', '[include]\n path = ' + SENTINEL + '\n'],
  ['case-insensitive dotted includeIf', '[InClUdEiF.gitdir:owned]\n path = ' + SENTINEL + '\n'],
  ['extensions', '[extensions]\n objectFormat = sha256\n'], ['worktree', '[core]\n worktree = ' + SENTINEL + '\n'],
  ['alternate refs command', '[core]\n alternateRefsCommand = ' + SENTINEL + '\n'],
  ['promisor remote', '[remote "origin"]\n promisor = true\n'], ['partial clone remote', '[remote.origin]\n partialCloneFilter = blob:none\n'],
  ['nonzero format', '[core]\n repositoryFormatVersion = 1\n'], ['bare store', '[core]\n bare = true\n'],
  ['continuation', '[core]\n editor = a\\\n b\n'], ['key outside section', 'editor = ' + SENTINEL + '\n'],
  ['oversized config', '#'.repeat(65537)],
]) test(`Git config admission refuses ${name} before invoking Git`, () => withFixture(f => {
  put(f, 'config', config); f.wrapper('deny'); const r = f.invoke(); refused(r, /git/i); assert.deepEqual(r.calls, []);
}));
test('ordinary config defaults and literal subsection remain supported', () => withFixture(f => {
  put(f, 'config', '# version0 and nonbare default\n[core]\n filemode = true\n[remote "fixture"]\n url = https://example.invalid/inert\n'); accepted(f.invoke());
}));
test('inherited routing/startup/preload controls do not reach Git', () => withFixture(f => {
  const startup = path.join(f.outer, 'owned-startup'); writeFileSync(startup, ':\n');
  const inherited = { GIT_DIR: path.join(f.outer, 'different'), GIT_WORK_TREE: path.join(f.outer, 'different'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
    GIT_TRACE: '1', GIT_EXTERNAL_DIFF: SENTINEL, GIT_ASKPASS: SENTINEL, GIT_PAGER: SENTINEL, PAGER: SENTINEL, SSH_ASKPASS: SENTINEL, BASH_ENV: startup, ENV: startup,
    NODE_OPTIONS: '--no-warnings', LD_PRELOAD: '' };
  const r = f.invoke(undefined, inherited); accepted(r); assert.ok(r.calls.length > 0);
  for (const call of r.calls) for (const key of Object.keys(inherited)) assert.equal(Object.hasOwn(call.env, key), false, `Git inherited ${key}`);
}));
for (const mode of ['exit', 'signal', 'overflow', 'malformed', 'timeout']) test(`Git ${mode === 'overflow' ? 'oversized-output refusal' : mode + ' failure'} is private`, () => withFixture(f => {
  f.wrapper(mode); const r = f.invoke(); refused(r, /git/i); assert.ok(r.calls.length > 0); assert.equal(r.calls.some(call => call.deadman), false, 'Git must be killed before owned timeout deadman');
}));
test('moving HEAD and main after capture cannot substitute the snapshot', () => withFixture(f => {
  const replacement = f.stage('orphan').ORPHAN; f.wrapper('race', replacement); const r = f.invoke(undefined, {}, true); accepted(r);
  assert.equal(r.calls.filter(call => call.moved).length, 1);
  for (const ref of ['refs/heads/fixture', 'refs/remotes/origin/main']) assert.equal(readFileSync(path.join(f.cwd, '.git', ref), 'utf8'), replacement + '\n');
  const captures = r.calls.filter(call => call.args?.includes('rev-parse') && call.args.includes('--verify'));
  assert.equal(captures.filter(call => call.args.at(-1) === 'HEAD').length, 1);
  assert.equal(captures.filter(call => call.args.at(-1) === 'refs/remotes/origin/main').length, 1);
}));

// specs/verification/red-declarations.md REQ-1..4 / AC-1, AC-3..4; RED is inert.
for (const kind of ['implementation', 'test']) test(`C1 committed ${kind} without RED refuses`, () => withFixture(f => {
  changedClaim(f, c => { c.type = kind; }); const result = f.invoke(); refused(result, /claim schema/i);
}));

test('C1 committed valid implementation/test RED declarations pass both selectors without RED Git lookup', () => withFixture(f => {
  for (const [index, kind] of ['implementation', 'test'].entries()) {
    const claim = f.documents[index].claim; claim.type = kind;
    claim.proof.red = { sha: (index === 0 ? 'b' : 'c').repeat(40), exit_code: index === 0 ? -1 : 256 };
  }
  f.saveClaims(); f.bind(); f.commit();
  for (const args of [['--all', '--no-rerun'], ['--claim', IDS[1], '--no-rerun']]) {
    const result = f.invoke(args); accepted(result);
    for (const call of result.calls) assert.equal(call.args.some(arg => arg.includes('b'.repeat(40)) || arg.includes('c'.repeat(40))), false, 'RED SHA is schema data, not new Git authority');
  }
}));

test('C1 committed optional doc RED with zero exit refuses named selection', () => withFixture(f => {
  changedClaim(f, c => { c.proof.red = { sha: 'b'.repeat(40), exit_code: 0 }; });
  refused(f.invoke(['--claim', IDS[0], '--no-rerun']), /claim schema/i);
}));

// specs/verification/completion-state-declarations.md REQ-1..3 / AC-2..4.
test('MR12-A committed valid state is optional metadata under both selectors', () => withFixture(f => {
  const selectors = [['--all', '--no-rerun'], ['--claim', IDS[0], '--no-rerun']];
  const before = selectors.map(args => { const result = f.invoke(args); accepted(result); return result.calls.map(call => call.args); });
  const hashes = f.documents.map(document => document.claim.reproducibility_hash);
  for (const document of f.documents) {
    assert.equal(Object.hasOwn(document.claim, 'state'), false);
    document.claim.state = 'production_complete';
    assert.equal(Object.hasOwn(document.claim.proof, 'deploy'), false);
  }
  f.saveClaims(); f.bind(); f.commit();
  assert.deepEqual(f.documents.map(document => document.claim.reproducibility_hash), hashes);
  for (const [index, args] of selectors.entries()) {
    const result = f.invoke(args); accepted(result);
    // Publication object IDs change when state bytes change; operation count and
    // absence of state arguments remain observable without inventing stable OIDs.
    assert.equal(result.calls.length, before[index].length);
    assert.equal(result.calls.some(call => call.args.some(arg => arg.includes('production_complete'))), false);
  }
}));
test('MR12-A committed malformed selected state refuses both selectors', () => withFixture(f => {
  changedClaim(f, claim => { claim.state = SENTINEL; });
  for (const args of [['--all', '--no-rerun'], ['--claim', IDS[0], '--no-rerun']]) {
    const result = f.invoke(args); refused(result, /claim schema/i); assert.match(result.output, /\benum\b/);
  }
}));
test('MR12-A committed named selection binds but does not schema-validate the unselected state', () => withFixture(f => {
  f.documents[0].claim.state = 'verified'; f.documents[1].claim.state = SENTINEL;
  f.saveClaims(); f.bind(); f.commit();
  accepted(f.invoke(['--claim', IDS[0], '--no-rerun']));
  refused(f.invoke(), /claim schema/i);
}));
