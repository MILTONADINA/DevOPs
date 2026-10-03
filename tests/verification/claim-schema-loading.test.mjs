// specs/verification/claim-schema-loading.md REQ-1..4 / AC-1..5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, renameSync, rmSync, existsSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'verification/claim-validator.ts');
const SCHEMA = path.join(ROOT, 'verification/claim-schema.yml');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SHA = 'a'.repeat(40);
const ID = 'claim-2026-10-03-901';
const SENTINEL = 'SENSITIVE_CLAIM_FIXTURE_SENTINEL';
const CAP = 262144;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function yaml(value, indent = 0) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) return value.map((item) => `${prefix}- ${JSON.stringify(item)}\n`).join('');
  return Object.entries(value).map(([key, item]) => {
    if (item !== null && typeof item === 'object') return `${prefix}${key}:\n${yaml(item, indent + 2)}`;
    return `${prefix}${key}: ${JSON.stringify(item)}\n`;
  }).join('');
}
function tree(directory, ignored) {
  return readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    if (ignored.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...tree(file, ignored)];
    return [[file, stat.isSymbolicLink() ? 'symlink' : hash(readFileSync(file))]];
  });
}
function fixture() {
  for (const file of [SOURCE, SCHEMA, TSX]) assert.ok(existsSync(file), `fixture prerequisite missing: ${file}`);
  const state = path.join(ROOT, '.workflow/state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'claim-schema-')));
  const pkg = path.join(outer, 'package'); const cwd = path.join(outer, 'consumer');
  const validator = path.join(pkg, 'verification/claim-validator.ts');
  const schema = path.join(pkg, 'verification/claim-schema.yml');
  const claim = path.join(cwd, '.workflow/proofs', `${ID}.yml`);
  const gitLog = path.join(outer, 'git-calls.jsonl'); const bin = path.join(outer, 'bin');
  const launcherTemp = path.join(outer, 'launcher-temp');
  mkdirSync(path.dirname(validator), { recursive: true }); mkdirSync(path.dirname(claim), { recursive: true }); mkdirSync(bin);
  mkdirSync(launcherTemp);
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  copyFileSync(SOURCE, validator); copyFileSync(SCHEMA, schema);
  writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}\n');
  // The owned copy resolves only the checkout's locked modules, before and after installation.
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  writeFileSync(path.join(cwd, 'claimed.txt'), 'owned fixture content\n');
  writeFileSync(gitLog, '');
  const git = path.join(bin, 'git');
  writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.FIXTURE_GIT_LOG,JSON.stringify(args)+'\\n');\nif(args.length===3&&args[0]==='rev-parse'&&args[1]==='--verify'&&args[2]===${JSON.stringify(`${SHA}^{commit}`)})process.stdout.write(${JSON.stringify(SHA + '\n')});\nelse if(JSON.stringify(args)===JSON.stringify(['show','--name-only','--pretty=format:',${JSON.stringify(SHA)}]))process.stdout.write('claimed.txt\\n');\nelse process.exit(89);\n`);
  chmodSync(git, 0o755);
  const data = { claim: { id: ID, type: 'implementation', spec_ref: 'specs/fixture.md#ac-1', description: 'Valid owned fixture declaration.',
    proof: { git_sha: SHA, files_changed: ['claimed.txt'], test_command: 'printf harmless', test_exit_code: 0,
      test_output_path: '.workflow/proofs/fixture-output.log', environment: { MODE: 'fixture' } }, confidence: 'high',
    timestamp: '2026-10-03T12:34:56Z', reproducibility_hash: '' } };
  function save() {
    const c = data.claim;
    const env = c.proof.environment ?? {};
    c.reproducibility_hash = 'sha256:' + hash(`${c.proof.test_command}\n---\n${Object.keys(env).sort().map((key) => `${key}=${env[key]}`).join('\n')}\n---\n${c.proof.git_sha}`);
    writeFileSync(claim, yaml(data));
  }
  save();
  return { outer, pkg, cwd, validator, schema, claim, gitLog, data, save,
    invoke(args = [claim, '--no-rerun']) {
      assert.ok(args.includes('--no-rerun'), 'fixture must never enable raw shell replay');
      writeFileSync(gitLog, '');
      // The locked tsx CLI creates an owned IPC directory even with its code cache disabled.
      const ignored = [gitLog, launcherTemp]; const before = tree(outer, ignored);
      const result = spawnSync(process.execPath, [TSX, validator, ...args], { cwd,
        env: { PATH: bin, HOME: cwd, TMPDIR: launcherTemp, LANG: 'C', TSX_DISABLE_CACHE: '1', FIXTURE_GIT_LOG: gitLog },
        encoding: 'utf8', timeout: 15000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null);
      assert.deepEqual(tree(outer, ignored), before, 'read-only invocation must preserve owned inputs/outputs outside the Git log and launcher IPC scratch');
      assert.equal(existsSync(path.join(cwd, 'command-executed')), false);
      return { ...result, output: result.stdout + result.stderr, calls: readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
    }, cleanup() { rmSync(outer, { recursive: true, force: true }); } };
}
function withFixture(run) { const f = fixture(); try { run(f); } finally { f.cleanup(); } }
function accepted(result) {
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /1\/1 claims valid/);
  assert.deepEqual(result.calls, [['rev-parse', '--verify', `${SHA}^{commit}`], ['show', '--name-only', '--pretty=format:', SHA]]);
}
function refused(result, keyword) {
  assert.notEqual(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|YAMLParseError:|SyntaxError:|TypeError:|\n\s+at /);
  assert.doesNotMatch(result.output, new RegExp(SENTINEL));
  assert.doesNotMatch(result.output, new RegExp(`${ID}\\.yml`), 'new failure diagnostics must not echo input filenames');
  assert.deepEqual(result.calls, [], 'new input/schema failures must precede Git metadata checks');
  if (keyword) {
    assert.match(result.output, new RegExp(`\\b${keyword}\\b`));
    assert.match(result.output, /#\//, 'diagnostic must identify a schema path');
  } else assert.match(result.output, /claim|schema|input|yaml/i, 'diagnostic must identify the failed input/schema category');
}

test('explicit claim uses packaged schema and separate caller Git context', () => withFixture((f) => {
  mkdirSync(path.join(f.cwd, 'verification'));
  writeFileSync(path.join(f.cwd, 'verification/claim-schema.yml'), 'this: is not a schema\n');
  accepted(f.invoke([path.relative(f.cwd, f.claim), '--no-rerun']));
}));

test('copied sibling maxLength is authoritative rather than a hardcoded limit', () => withFixture((f) => {
  const original = readFileSync(f.schema, 'utf8');
  assert.ok(original.includes('maxLength: 280'));
  writeFileSync(f.schema, original.replace('maxLength: 280', 'maxLength: 12'));
  refused(f.invoke(), 'maxLength');
}));

test('inclusive description limit and nonzero exit/additional data/no RED remain allowed', () => withFixture((f) => {
  f.data.claim.description = 'x'.repeat(280); f.data.claim.proof.test_exit_code = 7;
  f.data.claim.extra = 'permitted extra member'; f.save();
  assert.equal(f.data.claim.proof.red, undefined);
  accepted(f.invoke());
}));

for (const [name, change, keyword] of [
  ['description300', (c) => { c.description = 'x'.repeat(300); }, 'maxLength'],
  ['required description', (c) => { delete c.description; }, 'required'],
  ['unknown type', (c) => { c.type = 'not-a-claim-type'; }, 'enum'],
  ['spec pattern', (c) => { c.spec_ref = 'specs/invalid-extension.txt'; }, 'pattern'],
  ['wrong scalar type', (c) => { c.description = 123; }, 'type'],
  ['wrong array item', (c) => { c.proof.files_changed = [123]; }, 'type'],
  ['negative duration', (c) => { c.proof.duration_ms = -1; }, 'minimum'],
  ['noninteger exit', (c) => { c.proof.test_exit_code = 0.5; }, 'type'],
  ['date range', (c) => { c.timestamp = '2026-02-30T12:00:00Z'; }, 'format'],
]) test(`actual schema rejects ${name}`, () => withFixture((f) => { change(f.data.claim); f.save(); refused(f.invoke(), keyword); }));

for (const [name, replacement] of [
  ['invalid YAML', `broken: [${SENTINEL}\n`],
  ['invalid schema keyword', 'type: banana\n'],
  ['external reference', '$ref: "https://example.invalid/schema"\n'],
  ['asynchronous schema', '$async: true\ntype: object\n'],
]) test(`schema refuses ${name} without fallback or excerpts`, () => withFixture((f) => { writeFileSync(f.schema, replacement); refused(f.invoke()); }));

test('missing sibling schema refuses even if the caller has a valid decoy', () => withFixture((f) => {
  mkdirSync(path.join(f.cwd, 'verification')); copyFileSync(f.schema, path.join(f.cwd, 'verification/claim-schema.yml'));
  rmSync(f.schema); refused(f.invoke());
}));

test('claim commands stay inert and diagnostic failures cannot expose unvalidated IDs', () => withFixture((f) => {
  f.data.claim.proof.test_command = 'echo harmless > command-executed';
  f.data.claim.proof.environment = { NOTE: SENTINEL }; f.save(); accepted(f.invoke());
  f.data.claim.id = `${SENTINEL}\nnot-an-id`; f.save(); refused(f.invoke(), 'pattern');
}));

for (const present of [false, true]) test(`empty discovery remains compatible, proof directory present=${present}`, () => withFixture((f) => {
  rmSync(f.claim); rmSync(f.schema);
  if (!present) rmSync(path.dirname(f.claim), { recursive: true });
  const result = f.invoke(['--all', '--no-rerun']);
  assert.equal(result.status, 0, result.output); assert.match(result.stdout, /No claim files to validate\./); assert.deepEqual(result.calls, []);
}));

for (const style of ['quoted escapes', 'literal block', 'folded block', 'JSON flow']) test(`valid YAML ${style} retains semantic strings and hash`, () => withFixture((f) => {
  if (style === 'quoted escapes') f.data.claim.proof.test_command = 'printf "quoted"\\tail\n';
  if (style === 'literal block') f.data.claim.proof.test_command = 'printf first\nprintf second\n';
  if (style === 'folded block') f.data.claim.proof.test_command = 'printf first printf second\n';
  f.save();
  if (style === 'JSON flow') writeFileSync(f.claim, JSON.stringify(f.data));
  if (style.endsWith('block')) {
    const line = `    test_command: ${JSON.stringify(f.data.claim.proof.test_command)}\n`;
    const raw = readFileSync(f.claim, 'utf8'); assert.ok(raw.includes(line));
    writeFileSync(f.claim, raw.replace(line, `    test_command: ${style === 'literal block' ? '|' : '>'}\n      printf first\n      printf second\n`));
  }
  accepted(f.invoke());
}));

for (const [name, transform] of [
  ['duplicate key', (raw) => raw + '  description: "Another valid description."\n'],
  ['unused anchor', (raw) => raw + '  extra: &fixture ordinary\n'],
  ['alias', (raw) => raw + '  extra: *fixture\n'],
  ['unknown tag', (raw) => raw + `  extra: !fixture ${SENTINEL}\n`],
  ['multiple documents', (raw) => raw + '---\n' + raw],
  ['non-string mapping key', (raw) => raw + '123: ordinary\n'],
  ['nonfinite number', (raw) => raw + '  extra: .nan\n'],
  ['YAML1.1 directive', (raw) => '%YAML 1.1\n---\n' + raw],
  ['malformed YAML', () => `claim: [${SENTINEL}\n`],
  ['empty input', () => ''],
]) test(`claim refuses YAML ${name}`, () => withFixture((f) => { writeFileSync(f.claim, transform(readFileSync(f.claim, 'utf8'))); refused(f.invoke()); }));

for (const file of ['claim', 'schema']) {
  test(`${file} malformed UTF-8 is refused without replacement`, () => withFixture((f) => {
    writeFileSync(f[file], Buffer.concat([readFileSync(f[file]), Buffer.from([0xff, 0x0a])])); refused(f.invoke());
  }));
  test(`${file} inclusive byte limit accepts valid comment padding`, () => withFixture((f) => {
    const raw = readFileSync(f[file]); const padded = Buffer.concat([raw, Buffer.from('#'), Buffer.alloc(CAP - raw.length - 2, 0x78), Buffer.from('\n')]);
    assert.equal(padded.length, CAP); writeFileSync(f[file], padded); accepted(f.invoke());
  }));
  test(`${file} one byte above cap refuses otherwise valid content`, () => withFixture((f) => {
    const raw = readFileSync(f[file]); writeFileSync(f[file], Buffer.concat([raw, Buffer.from('#'), Buffer.alloc(CAP - raw.length, 0x78)]));
    assert.equal(readFileSync(f[file]).length, CAP + 1); refused(f.invoke());
  }));
  test(`${file} directory input refuses`, () => withFixture((f) => { rmSync(f[file]); mkdirSync(f[file]); refused(f.invoke()); }));
}

test('lexical claim escape refers only to an owned sibling and refuses', () => withFixture((f) => {
  const outside = path.join(f.outer, 'owned-outside.yml'); copyFileSync(f.claim, outside);
  refused(f.invoke([outside, '--no-rerun']));
}));

for (const [file, internal] of [['claim', true], ['claim', false], ['schema', false]]) test(`${file} leaf symlink internal=${internal} refuses`, () => withFixture((f) => {
  const target = path.join(internal ? f.cwd : f.outer, 'owned-target.yml');
  copyFileSync(f[file], target); rmSync(f[file]); symlinkSync(target, f[file]); refused(f.invoke());
}));

test('claim parent-directory redirect refuses without operator data', () => withFixture((f) => {
  const directory = path.dirname(f.claim); const target = path.join(f.outer, 'owned-proofs');
  renameSync(directory, target); symlinkSync(target, directory); refused(f.invoke());
}));

test('missing claim input refuses safely', () => withFixture((f) => { rmSync(f.claim); refused(f.invoke()); }));

for (const depth of [64, 65]) test(`collection depth ${depth} has the declared boundary`, () => withFixture((f) => {
  let value = 'leaf'; for (let i = 0; i < depth - 2; i++) value = { next: value };
  f.data.claim.extra = value; f.save(); writeFileSync(f.claim, JSON.stringify(f.data));
  if (depth === 64) accepted(f.invoke()); else refused(f.invoke());
}));

test('schema fragments resolve locally while annotation data stays inert', () => withFixture((f) => {
  const extra = '\n$ref: "#/$defs/local"\n$defs:\n  local:\n    type: object\nexamples:\n  - {"$ref": "https://example.invalid/annotation-only"}\n';
  writeFileSync(f.schema, readFileSync(f.schema, 'utf8') + extra); accepted(f.invoke());
}));

test('external dynamic reference refuses without a loader', () => withFixture((f) => {
  writeFileSync(f.schema, '$dynamicRef: "https://example.invalid/dynamic"\n'); refused(f.invoke());
}));

test('schema default cannot fill a missing required description', () => withFixture((f) => {
  const original = readFileSync(f.schema, 'utf8'); const needle = '        minLength: 10\n'; assert.ok(original.includes(needle));
  writeFileSync(f.schema, original.replace(needle, needle + '        default: "A default cannot repair this claim."\n'));
  delete f.data.claim.description; f.save(); refused(f.invoke(), 'required');
}));

test('validation does not coerce a string exit code', () => withFixture((f) => {
  f.data.claim.proof.test_exit_code = '0'; f.save(); refused(f.invoke(), 'type');
}));

test('validation does not remove a schema-forbidden additional property', () => withFixture((f) => {
  writeFileSync(f.schema, readFileSync(f.schema, 'utf8') + '\nadditionalProperties: false\n');
  f.data.extra = 'must not be removed'; f.save(); refused(f.invoke(), 'additionalProperties');
}));

test('schema diagnostics do not expose arbitrary environment-property names', () => withFixture((f) => {
  f.data.claim.proof.environment = { [SENTINEL]: 1 }; f.save(); refused(f.invoke(), 'type');
}));
