// specs/graph/M-masterpiece-standard.md REQ-M16: the PreToolUse wrappers in
// .claude/settings.json block the call (exit 2) whenever their gate cannot decide.
// Claude Code treats any exit other than 2 as non-blocking, so a wrapper that exits
// 0, 1 or 126 on a missing jq, a malformed payload or an oversized command lets
// the call through. Each case runs the real wrapper text against a copy of the
// hooks in a disposable project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOKS = path.join(ROOT, 'hooks', 'universal', 'pre-tool');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) {
  if (key.startsWith('GIT_') || key === 'BASH_ENV' || key === 'ENV' || key.startsWith('BASH_FUNC_')) delete BASE_ENV[key];
}
delete BASE_ENV.DEVOPS_GRAPH_CYCLE_ID;

const GATES = [
  { hook: 'deploy-gate.sh', gated: 'vercel deploy --prod' },
  { hook: 'block-sealed-refs.sh', gated: 'git push origin :v0.2.0' },
];

function wrapperFor(hook) {
  const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.PreToolUse.flatMap(entry => entry.hooks)
    .find(entry => entry.command.includes(`H=hooks/universal/pre-tool/${hook};`))?.command;
  assert.equal(typeof command, 'string', `${hook} is wired in .claude/settings.json`);
  return command;
}

// A project holding copies of the gate and its classifier (or a stand-in gate),
// and a PATH directory with every tool the wrapper and gate use except jq.
function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-wrapper-')));
  try {
    mkdirSync(path.join(dir, 'hooks', 'universal', 'pre-tool'), { recursive: true });
    const noJq = path.join(dir, 'no-jq-bin');
    mkdirSync(noJq);
    for (const tool of ['bash', 'cat', 'date', 'dirname', 'git', 'mkdir', 'node', 'printf']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: BASE_ENV }).stdout.trim();
      if (found.startsWith('/')) symlinkSync(found, path.join(noJq, tool));
    }
    fn({ dir, noJq });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function install(dir, hook) {
  for (const file of [hook, 'graph-command-classifier.mjs']) {
    copyFileSync(path.join(HOOKS, file), path.join(dir, 'hooks', 'universal', 'pre-tool', file));
  }
}

function run(dir, hook, input, env = {}) {
  const wrapper = path.join(dir, 'wrapper.sh');
  writeFileSync(wrapper, wrapperFor(hook));
  const result = spawnSync('bash', [wrapper], {
    cwd: dir,
    env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: dir, ...env },
    input,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

const payload = command => JSON.stringify({ tool_input: { command } });

for (const { hook, gated } of GATES) {
  test(`${hook} wrapper: blocks a gated command and allows an ordinary one`, () => {
    withProject(({ dir }) => {
      install(dir, hook);
      assert.equal(run(dir, hook, payload(gated)).status, 2);
      const ordinary = run(dir, hook, payload('ls -la'));
      assert.equal(ordinary.status, 0, ordinary.stderr);
      assert.equal(run(dir, hook, JSON.stringify({ tool_input: {} })).status, 0, 'a payload without a command has nothing to gate');
    });
  });

  test(`${hook} wrapper: blocks when jq is missing`, () => {
    withProject(({ dir, noJq }) => {
      install(dir, hook);
      assert.equal(run(dir, hook, payload(gated), { PATH: noJq }).status, 2);
    });
  });

  test(`${hook} wrapper: blocks a payload that is not JSON or has no string command`, () => {
    withProject(({ dir }) => {
      install(dir, hook);
      for (const input of ['not json', '{"tool_input":{"command":["vercel","deploy"]}}', '']) {
        const result = run(dir, hook, input);
        assert.equal(result.status, 2, `input ${JSON.stringify(input)}: ${result.stderr}`);
      }
    });
  });

  test(`${hook} wrapper: blocks a gated command longer than ARG_MAX`, () => {
    withProject(({ dir }) => {
      install(dir, hook);
      // Above macOS's 1 MiB ARG_MAX and Linux's 128 KiB limit for one argument.
      const result = run(dir, hook, payload(`${gated} # ${'x'.repeat(1_200_000)}`));
      assert.equal(result.status, 2, result.stderr.slice(-300));
    });
  });

  test(`${hook} wrapper: turns any other exit of its gate into a block`, () => {
    withProject(({ dir }) => {
      writeFileSync(path.join(dir, 'hooks', 'universal', 'pre-tool', hook), 'exit 1\n');
      const result = run(dir, hook, payload('ls'));
      assert.equal(result.status, 2);
      assert.match(result.stderr, /exited 1 -- failing closed/);
    });
  });

  test(`${hook} wrapper: blocks when its gate file is missing`, () => {
    // The project holds no copy of the gate (install() is not called).
    withProject(({ dir }) => {
      const result = run(dir, hook, payload('ls'));
      assert.equal(result.status, 2);
      assert.match(result.stderr, /HOOK MISSING/);
    });
  });
}

test('graph-command-classifier.mjs reads the command from stdin when given -, the same as from argv', () => {
  const classifier = path.join(HOOKS, 'graph-command-classifier.mjs');
  for (const [mode, command] of [['deploy', 'vercel deploy --prod'], ['sealed', 'git push origin :v0.2.0'], ['deploy', 'echo "a\nb"']]) {
    const viaArgv = spawnSync(process.execPath, [classifier, mode, command], { encoding: 'utf8', env: BASE_ENV });
    const viaStdin = spawnSync(process.execPath, [classifier, mode, '-'], { input: command, encoding: 'utf8', env: BASE_ENV });
    assert.equal(viaStdin.status, 0, viaStdin.stderr);
    assert.deepEqual(JSON.parse(viaStdin.stdout), JSON.parse(viaArgv.stdout));
  }
});
