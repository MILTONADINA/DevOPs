// specs/security/client-boundary.md: the client-boundary hook fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = process.env.CLIENT_BOUNDARY_HOOK ? path.resolve(process.env.CLIENT_BOUNDARY_HOOK) : path.join(ROOT, 'hooks/universal/pre-tool/client-boundary.sh');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'CLAUDE_PROJECT_DIR'].includes(key)) delete BASE_ENV[key];
assert.ok(existsSync(HOOK), `hook missing: ${HOOK}`);

// The fixture must sit under none of the hook's global read entries (/tmp,
// /var/tmp), or every "outside" read would be allowed. On Linux CI os.tmpdir()
// is /tmp, so prefer RUNNER_TEMP, then a gitignored directory in the repo.
const GLOBAL_READ_ROOTS = ['/tmp', '/var/tmp'].flatMap((d) => { try { return [d, realpathSync(d)]; } catch { return [d]; } });
const underGlobalRead = (p) => GLOBAL_READ_ROOTS.some((g) => p === g || p.startsWith(`${g}/`));
function fixtureBase() {
  const repoTmp = path.join(ROOT, '.workflow/state/client-boundary-tests');
  for (const candidate of [process.env.RUNNER_TEMP, tmpdir(), repoTmp]) {
    if (!candidate) continue;
    try {
      mkdirSync(candidate, { recursive: true });
      const real = realpathSync(candidate);
      if (!underGlobalRead(real)) return real;
    } catch { /* e.g. TMPDIR names a file: try the next candidate */ }
  }
  throw new Error('no fixture base outside /tmp and /var/tmp');
}
const BASE = fixtureBase();

// D/proj is the project root, D/home is HOME, D/other is a different client.
function withProject(fn, { env = {} } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(BASE, 'client-boundary-test-')));
  assert.equal(underGlobalRead(dir), false, `fixture ${dir} is under a global read entry`);
  const root = path.join(dir, 'proj');
  const home = path.join(dir, 'home');
  const other = path.join(dir, 'other');
  for (const d of [root, home, other, path.join(root, 'src')]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(other, 'secret'), 'other client data\n');
  try { fn({ dir, root, home, other, env: { ...BASE_ENV, HOME: home, ...env } }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(ctx, args, input) {
  const result = spawnSync('bash', [HOOK, ...args], { cwd: ctx.root, env: ctx.env, input: input ?? '', encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
const runArgv = (ctx, args) => run(ctx, args, '');
const runStdin = (ctx, payload) => run(ctx, [], typeof payload === 'string' ? payload : JSON.stringify(payload));
function assertBlocked(result) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CLIENT BOUNDARY BLOCK/);
}
function allowlist(ctx, text) {
  mkdirSync(path.join(ctx.root, '.workflow/client'), { recursive: true });
  writeFileSync(path.join(ctx.root, '.workflow/client/path-allowlist.txt'), text);
}

test('allowlist lines are never evaluated', () => withProject((ctx) => {
  const s1 = path.join(ctx.dir, 'pwned');
  const s2 = path.join(ctx.dir, 'pwned2');
  allowlist(ctx, `$(touch ${s1})\n\`touch ${s2}\`\n`);
  const result = runArgv(ctx, [path.join(ctx.other, 'secret'), 'read']);
  assertBlocked(result);
  assert.match(result.stderr, /ignored/);
  assert.equal(existsSync(s1), false);
  assert.equal(existsSync(s2), false);
}));

test('sibling directory sharing the root prefix is blocked', () => withProject((ctx) => {
  mkdirSync(path.join(ctx.dir, 'proj-sibling'));
  assertBlocked(runArgv(ctx, [path.join(ctx.dir, 'proj-sibling', 'x'), 'read']));
}));

test('dot-dot escape is blocked', () => withProject((ctx) => {
  assertBlocked(runArgv(ctx, [`${ctx.root}/../other/x`, 'read']));
  assertBlocked(runArgv(ctx, ['../other/x', 'read']));
}));

test('stdin JSON: outside path blocked', () => withProject((ctx) => {
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.other, 'secret') } }));
  assertBlocked(runStdin(ctx, { tool_name: 'Grep', tool_input: { path: ctx.other } }));
  assertBlocked(runStdin(ctx, { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(ctx.other, 'n.ipynb') } }));
}));

test('stdin JSON: inside path allowed, no event written', () => withProject((ctx) => {
  const result = runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: path.join(ctx.root, 'src/a.ts') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(ctx.root, '.workflow/state/events.jsonl')), false);
}));

test('stdin JSON: no path field is allowed', () => withProject((ctx) => {
  const result = runStdin(ctx, { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(result.status, 0, result.stderr);
}));

test('stdin JSON: read-only global list applies to reads, not writes', () => withProject((ctx) => {
  const p = path.join(ctx.home, '.cache/x');
  assert.equal(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: p } }).status, 0);
  assertBlocked(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: p } }));
}));

test('malformed stdin is blocked', () => withProject((ctx) => {
  assertBlocked(runStdin(ctx, '{'));
  assertBlocked(runStdin(ctx, 'not json'));
}));

test('argv form still works', () => withProject((ctx) => {
  assert.equal(runArgv(ctx, [path.join(ctx.root, 'x')]).status, 0);
  assert.equal(runArgv(ctx, ['src/x', 'write']).status, 0);
  assertBlocked(runArgv(ctx, [path.join(ctx.other, 'x'), 'write']));
}));

test('event line is valid JSON for hostile paths', () => withProject((ctx) => {
  const hostile = path.join(ctx.other, 'a"b\\c\nd');
  assertBlocked(runArgv(ctx, [hostile, 'read']));
  const lines = readFileSync(path.join(ctx.root, '.workflow/state/events.jsonl'), 'utf8').trimEnd().split('\n');
  // The newline inside the path must be escaped, so there is exactly one line.
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.event, 'boundary_blocked');
  assert.equal(ev.path, hostile);
  assert.equal(ev.operation, 'read');
}));

test('symlink to an outside file is blocked', () => withProject((ctx) => {
  symlinkSync(path.join(ctx.other, 'secret'), path.join(ctx.root, 'link'));
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: path.join(ctx.root, 'link') } }));
}));

test('symlinked directory followed by dot-dot is blocked', () => withProject((ctx) => {
  symlinkSync(ctx.other, path.join(ctx.root, 'dirlink'));
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: `${ctx.root}/dirlink/../x` } }));
}));

test('trailing newline in the path does not collapse onto the root', () => withProject((ctx) => {
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: `${ctx.root}\n` } }));
}));

test('allowlist expands only a leading ~, $HOME and ${HOME}', () => withProject((ctx) => {
  allowlist(ctx, '# comment\n~/shared/\n$HOME/data\n${HOME}/more');
  for (const d of ['shared', 'data', 'more']) {
    assert.equal(runArgv(ctx, [path.join(ctx.home, d, 'x'), 'write']).status, 0, d);
  }
  assertBlocked(runArgv(ctx, [path.join(ctx.home, 'sharedx'), 'write']));
}));

test('allowlist lines with other variables, empty or relative lines are ignored', () => withProject((ctx) => {
  allowlist(ctx, '$OTHER/x\n$HOMEDIR/x\nrelative/dir\n   \n');
  const result = runArgv(ctx, [path.join(ctx.other, 'secret'), 'read']);
  assertBlocked(result);
  assert.match(result.stderr, /ignored/);
  assertBlocked(runArgv(ctx, [path.join(ctx.root, '..', 'x'), 'write']));
}, { env: { OTHER: '' } }));

test('allowlist with CRLF endings works', () => withProject((ctx) => {
  allowlist(ctx, `${ctx.other}/ok\r\n`);
  assert.equal(runArgv(ctx, [path.join(ctx.other, 'ok', 'f'), 'write']).status, 0);
}));

test('file entries match exactly, not by prefix', () => withProject((ctx) => {
  assert.equal(runArgv(ctx, ['/dev/null', 'read']).status, 0);
  assertBlocked(runArgv(ctx, ['/dev/nullx', 'read']));
  assertBlocked(runArgv(ctx, ['/dev/null/x', 'read']));
  assertBlocked(runArgv(ctx, [path.join(ctx.home, '.gitconfig', 'x'), 'read']));
  assertBlocked(runArgv(ctx, [path.join(ctx.home, '.gitconfig-other'), 'read']));
}));

test('/tmp stays readable', () => withProject((ctx) => {
  assert.equal(runArgv(ctx, ['/tmp/anything', 'read']).status, 0);
  assertBlocked(runArgv(ctx, ['/tmp/anything', 'write']));
}));

test('unset HOME with an allowlist of ~/ or $HOME/ does not allow everything', () => withProject((ctx) => {
  const env = { ...ctx.env };
  delete env.HOME;
  for (const line of ['~/', '$HOME/', '${HOME}/', '~/shared/', '~', '$HOME']) {
    allowlist(ctx, `${line}\n`);
    const result = run({ ...ctx, env }, [path.join(ctx.other, 'secret'), 'write'], '');
    assertBlocked(result);
    assert.match(result.stderr, /ignored/, line);
  }
}));

test('a relative HOME is treated like an unset HOME', () => withProject((ctx) => {
  allowlist(ctx, '~/\n');
  assertBlocked(run({ ...ctx, env: { ...ctx.env, HOME: 'rel' } }, [path.join(ctx.other, 'secret'), 'write'], ''));
}));

test('block still exits 2 when the event log cannot be written', () => withProject((ctx) => {
  const target = path.join(ctx.other, 'secret');
  mkdirSync(path.join(ctx.root, '.workflow'), { recursive: true });
  writeFileSync(path.join(ctx.root, '.workflow/state'), 'not a directory\n');
  assertBlocked(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: target } }));
  rmSync(path.join(ctx.root, '.workflow'), { recursive: true });
  writeFileSync(path.join(ctx.root, '.workflow'), 'not a directory\n');
  assertBlocked(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: target } }));
  rmSync(path.join(ctx.root, '.workflow'));
  mkdirSync(path.join(ctx.root, '.workflow/state/events.jsonl'), { recursive: true });
  assertBlocked(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: target } }));
}));

test('a failing readlink on a leaf symlink fails closed', () => withProject((ctx) => {
  const bin = path.join(ctx.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'readlink'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  symlinkSync(path.join(ctx.other, 'secret'), path.join(ctx.root, 'link'));
  const env = { ...ctx.env, PATH: `${bin}:${ctx.env.PATH}` };
  const result = run({ ...ctx, env }, [path.join(ctx.root, 'link'), 'read'], '');
  assert.equal(result.status, 2, result.stderr);
}));

test('allowlist line with trailing whitespace still matches', () => withProject((ctx) => {
  allowlist(ctx, `${ctx.other}/ok \t\n`);
  assert.equal(runArgv(ctx, [path.join(ctx.other, 'ok', 'f'), 'write']).status, 0);
}));

test('stdin JSON: every present path field is checked, not just the first', () => withProject((ctx) => {
  const inside = path.join(ctx.root, 'src/a.ts');
  const outside = path.join(ctx.other, 'secret');
  assertBlocked(runStdin(ctx, { tool_name: 'Grep', tool_input: { file_path: inside, path: outside } }));
  assertBlocked(runStdin(ctx, { tool_name: 'Grep', tool_input: { path: outside, file_path: inside } }));
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: inside, notebook_path: outside } }));
  assert.equal(runStdin(ctx, { tool_name: 'Grep', tool_input: { file_path: inside, path: ctx.root } }).status, 0);
}));

test('a top-level JSON array is not a PreToolUse object and is blocked', () => withProject((ctx) => {
  assertBlocked(runStdin(ctx, '[]'));
  assertBlocked(runStdin(ctx, JSON.stringify([{ tool_name: 'Read', tool_input: { file_path: path.join(ctx.other, 'secret') } }])));
}));

test('a leading ~ is expanded with HOME, as the Read tool does', () => withProject((ctx) => {
  for (const p of ['~/x', '~']) {
    assertBlocked(runArgv(ctx, [p, 'write']));
    assertBlocked(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: p } }));
  }
  // Expanded to HOME, the global read list then applies to reads only.
  assert.equal(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: '~/.cache/x' } }).status, 0);
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: '~/other/x' } }));
  // Not the literal directory ./~ below the project root.
  assert.equal(runStdin(ctx, { tool_name: 'Write', tool_input: { file_path: './~/x' } }).status, 0);
}));

test('~user paths are blocked outright, argv and stdin', () => withProject((ctx) => {
  assertBlocked(runArgv(ctx, ['~user/x', 'read']));
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: '~user/x' } }));
  assertBlocked(runStdin(ctx, { tool_name: 'Read', tool_input: { file_path: '~root' } }));
}));

test('a ~ path with HOME unset or relative exits 2', () => withProject((ctx) => {
  const env = { ...ctx.env };
  delete env.HOME;
  for (const e of [env, { ...ctx.env, HOME: 'rel' }]) {
    const c = { ...ctx, env: e };
    for (const r of [run(c, ['~/x', 'read'], ''), run(c, [], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '~' } }))]) {
      assert.equal(r.status, 2, r.stderr);
    }
  }
}));
