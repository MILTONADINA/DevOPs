// specs/ops/assertion-syntax.md: syntax evidence only; fixture sources never execute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasAssertion } from '../../scripts/check-assertions.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-assertions.mjs');
const groups = [
  // Mutation: returning false for ordinary call expressions breaks these existing positives.
  { title: 'ordinary identifier and ASCII dot-member calls (regression guard)', samples: [
    ['assert(1);', true], ['expect(1).toBe(1);', true], ['assert.strictEqual(1, 1);', true],
  ] },
  // Mutation: treating comments or an assertion-free file as evidence breaks these refusals.
  { title: 'comments and assertion-free source stay negative (regression guard)', samples: [
    ['// assert(1)\n/* expect(1) */\nrun();', false], ['', false],
  ] },
  { title: 'strings regex and static template text are not calls', samples: [
    ['const note = "expect(1)";', false], ["const note = 'assert.equal(1, 1)';", false],
    ['const note = `assert(1)`;', false], ['const pattern = /expect(1)/;', false],
  ] },
  { title: 'quoted comment delimiters do not erase a real call', samples: [
    ['const start = "/*"; assert.equal(1, 1); const end = "*/";', true],
    ['const note = "//"; expect(1);', true],
  ] },
  { title: 'comments and whitespace between actual callee tokens are accepted', samples: [
    ['assert /* gap */ . equal (1, 1);', true], ['assert\n.\nequal(1, 1);', true],
  ] },
  { title: 'parsed identifier spellings are normalized', samples: [
    ['\\u0061ssert(1);', true], ['ex\\u0070ect(1);', true], ['assert.\\u0065qual(1, 1);', true],
  ] },
  { title: 'parenthesized and optional JS callees and receivers are transparent', samples: [
    ['(assert)(1);', true], ['((expect))(1);', true], ['(assert).equal(1, 1);', true],
    ['assert?.(1);', true], ['assert?.equal(1, 1);', true], ['assert.equal?.(1, 1);', true],
    ['(assert?.equal)(1, 1);', true],
  ] },
  { title: 'TS generic calls are calls in the exact .ts mode', samples: [
    ['assert<number>(1);', true, 'owned.test.ts'], ['expect<number>(1);', true, 'owned.test.ts'],
    ['assert < 1 > (2);', true, 'owned.test.ts'],
  ] },
  { title: 'TS callee and receiver wrappers are transparent', samples: [
    ['(assert as (value: unknown) => void)(1);', true, 'owned.test.ts'],
    ['(expect satisfies (value: unknown) => unknown)(1);', true, 'owned.test.ts'],
    ['assert!(1);', true, 'owned.test.ts'], ['(<Function>assert)(1);', true, 'owned.test.ts'],
    ['(assert as any).equal(1, 1);', true, 'owned.test.ts'],
    ['(assert satisfies any).equal(1, 1);', true, 'owned.test.ts'],
    ['assert!.equal(1, 1);', true, 'owned.test.ts'], ['(<any>assert).equal(1, 1);', true, 'owned.test.ts'],
  ] },
  // Mutation: parsing default/JS input as TS would turn this relational expression into evidence.
  { title: 'JS generic-looking relational expressions are not calls (regression guard)', samples: [
    ['assert < 1 > (2);', false], ['assert<1>(2);', false, 'owned.test.mjs'],
    ['assert<1>(2);', false, 'owned.test.TS'], ['assert<1>(2);', false, 'owned.test.tsx'],
  ] },
  { title: 'only exact .ts suffix enables TS grammar', samples: [
    ['const count: number = 1; assert(count);', false],
    ['const count: number = 1; assert(count);', false, 'owned.test.js'],
    ['const count: number = 1; assert(count);', false, 'owned.test.TS'],
    ['const count: number = 1; assert(count);', false, 'owned.test.tsx'],
    ['const count: number = 1; assert(count);', true, 'owned.test.ts'],
  ] },
  { title: 'malformed JS refuses even when another part contains a call', samples: [
    ['const = ; assert(1);', false], ['assert(1); const value = ;', false],
  ] },
  { title: 'malformed TS refuses even when another part contains a call', samples: [
    ['interface Broken { value: ; } assert(1);', false, 'owned.test.ts'],
    ['assert(1); const value: = 1;', false, 'owned.test.ts'],
  ] },
  { title: 'declarations definitions and signatures are not call expressions', samples: [
    ['function expect(value) {}', false], ['const obj = { assert(value) {} };', false],
    ['class C { expect(value) {} }', false],
    ['declare function expect(value: unknown): void;', false, 'owned.test.ts'],
    ['interface Check { assert(value: unknown): void; }', false, 'owned.test.ts'],
  ] },
  { title: 'other receivers deep members computed members and constructors do not qualify', samples: [
    ['obj.assert(1);', false], ['obj.expect(1);', false], ['obj.assert.equal(1, 1);', false],
    ['assert.deep.equal(1, 1);', false], ['assert["equal"](1, 1);', false],
    ['new assert(1);', false], ['new expect(1);', false], ['expect`inert`;', false],
    ['const check = assert; check(1);', false], ['(0, assert)(1);', false],
    ['(true ? assert : expect)(1);', false], ['$assert(1);', false], ['myexpect(1);', false],
  ] },
  // Mutation: accepting every property name widens the finite ASCII-letter member rule.
  { title: 'nonletter member names remain outside the matcher (regression guard)', samples: [
    ['assert.equal1(1, 1);', false], ['assert.equal_(1, 1);', false],
    ['assert.$equal(1, 1);', false], ['assert.équal(1, 1);', false],
  ] },
  // Mutation: stopping traversal at branches/functions/templates loses genuine nested calls.
  { title: 'unreachable nested and interpolation calls remain syntax evidence (regression guard)', samples: [
    ['if (false) { assert(1); }', true], ['function unused() { expect(1); }', true],
    ['const note = `value ${expect(1)}`;', true], ['const value = wrap(() => assert(1));', true],
  ] },
  // Mutation: requesting semantic binding or evaluating source changes this syntax-only contract.
  { title: 'a syntactic call needs no import binding or execution (regression guard)', samples: [
    ['throw new Error("SOURCE_MUST_NOT_EXECUTE"); assert(1);', true],
    ['const assert = () => false; assert(1);', true],
  ] },
  // Mutation: a fixed ES2022 parser or disabled hashbang support rejects valid selected JS.
  { title: 'latest JS syntax and hashbang stay accepted (regression guard)', samples: [
    ['const pattern = /[a&&b]/v; assert(1);', true], ['#!/usr/bin/env node\nassert(1);', true],
  ] },
];

for (const group of groups) test(group.title, () => {
  for (const [index, [source, expected, filename]] of group.samples.entries()) {
    const actual = filename === undefined ? hasAssertion(source) : hasAssertion(source, filename);
    assert.equal(actual, expected, `sample ${index + 1}`);
  }
});

function withFixture(check) {
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(state, 'assertion-syntax-')));
  const originals = new Map(), scriptBytes = readFileSync(SCRIPT);
  function put(name, source) {
    const file = path.join(dir, name); writeFileSync(file, source); originals.set(file, Buffer.from(source)); return file;
  }
  function run(args, entry = SCRIPT) {
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: dir, env: { PATH: '', HOME: dir, LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 1048576,
    });
    assert.equal(r.error, undefined, 'owned Node child must terminate'); assert.equal(r.signal, null);
    assert.doesNotMatch(r.stdout + r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ReferenceError:|SyntaxError:/, 'a loader error cannot witness a refusal');
    return r;
  }
  try { check({ dir, put, run }); }
  finally {
    try {
      for (const [file, bytes] of originals) assert.deepEqual(readFileSync(file), bytes, 'source stays unchanged');
      assert.deepEqual(readFileSync(SCRIPT), scriptBytes, 'checker stays unchanged');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
function checked(r, files, refused) {
  assert.equal(r.status, refused.length ? 1 : 0);
  assert.equal(r.stdout, `check-assertions: ${files.length} file(s) checked, ${refused.length} without assertions\n`);
  assert.equal(r.stderr, refused.map(file => `check-assertions: ${file} has no assert(...) or expect(...) call\n`).join(''));
}

// Mutation: bypassing direct file admission would lose ordinary success and negative diagnostics.
test('direct CLI keeps ordinary success and assertion-free refusal (regression guard)', () => withFixture(({ put, run }) => {
  const good = put('good.test.mjs', 'assert.equal(1, 1);\n'), bad = put('bad.test.mjs', 'run();\n');
  checked(run([good]), [good], []); checked(run([bad]), [bad], [bad]);
}));
test('CLI supplies each filename to select TS generic calls', () => withFixture(({ put, run }) => {
  const js = put('good.test.mjs', 'assert(1);\n'), ts = put('good.test.ts', 'assert<number>(1);\n');
  checked(run([js, ts]), [js, ts], []);
}));
test('CLI rejects quoted assertion text using the unchanged diagnostic', () => withFixture(({ put, run }) => {
  const file = put('quoted.test.mjs', 'const note = "expect(1)";\n');
  checked(run([file]), [file], [file]);
}));
test('CLI checks every file and refuses malformed input without source excerpts', () => withFixture(({ put, run }) => {
  const good = put('good.test.mjs', 'assert(1);\n');
  const bad = put('malformed.test.mjs', 'const = ; assert(1); // PRIVATE_SYNTAX_SENTINEL\n');
  const empty = put('empty.test.mjs', '// no calls\n');
  const r = run([good, bad, empty]); checked(r, [good, bad, empty], [bad, empty]);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE_SYNTAX_SENTINEL/);
}));
// Mutation: making an empty argv an implicit scan changes the existing no-argument API.
test('CLI with no files keeps its explicit zero-file success (regression guard)', () => withFixture(({ run }) => {
  checked(run([]), [], []);
}));
// Mutation: replacing the realpath entry guard with literal argv comparison silently skips a symlink.
test('symlinked CLI still checks selected files (regression guard)', () => withFixture(({ dir, put, run }) => {
  const link = path.join(dir, 'checker-link.mjs'); symlinkSync(SCRIPT, link);
  const file = put('bad.test.mjs', 'run();\n'); checked(run([file], link), [file], [file]);
}));
// Mutation: executing the CLI merely on import produces an unwanted zero-file summary.
test('importing with missing argv path or existing unrelated argv is quiet (regression guard)', () => withFixture(({ dir, put, run }) => {
  const harness = put('import-only.mjs', `import { hasAssertion } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n` +
    'if (typeof hasAssertion !== "function") process.exitCode = 9;\n');
  const ordinary = run([], harness);
  assert.equal(ordinary.status, 0); assert.equal(ordinary.stdout, ''); assert.equal(ordinary.stderr, '');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`, path.join(dir, 'does-not-exist')], {
    cwd: dir, env: { PATH: '', HOME: dir, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576,
  });
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0);
  assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
}));
// Mutation: importing/evaluating a selected test file would resolve its missing module or create the marker.
test('CLI never executes or resolves selected source imports (regression guard)', () => withFixture(({ dir, put, run }) => {
  const marker = path.join(dir, 'must-not-exist');
  const file = put('inert.test.mjs', 'import "owned-module-that-does-not-exist";\nimport { writeFileSync } from "node:fs";\n' +
    `writeFileSync(${JSON.stringify(marker)}, "unexpected");\nthrow new Error("MUST_NOT_EXECUTE");\nassert(1);\n`);
  checked(run([file]), [file], []); assert.equal(existsSync(marker), false);
}));
