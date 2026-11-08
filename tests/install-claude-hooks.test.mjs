// specs/release/npm-package.md REQ-15, AC-27 (issue #418): `devops init` wires the Claude Code
// hooks it copies into .claude/settings.json, records each entry it adds in the install
// manifest (`claude_hooks`), and `devops uninstall` removes only the recorded entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { MANIFEST } from '../analyzer/install-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
// Tests never run the real git (tests/hermeticity.test.mjs).
const STUB_BIN = mkdtempSync(path.join(tmpdir(), 'claude-hooks-git-'));
writeStubGit(STUB_BIN);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const init = (dir, ...extra) => devops(dir, 'init', '--no-agile-graph', ...extra);
const uninstall = (dir, ...args) => devops(dir, 'uninstall', ...args);

// Every hook under hooks/universal/, as a profile lists it. The wiring table in
// analyzer/install.ts must name each one, so none reaches init without a mapping.
const ALL_HOOKS = [
  'universal/pre-tool/block-new-dependency.sh', 'universal/pre-tool/block-prod-write.sh',
  'universal/pre-tool/block-rm-rf.sh', 'universal/pre-tool/block-sealed-refs.sh',
  'universal/pre-tool/block-secrets.sh', 'universal/pre-tool/budget-brake.sh',
  'universal/pre-tool/client-boundary.sh', 'universal/pre-tool/deploy-gate.sh',
  'universal/pre-tool/external-content-boundary.sh', 'universal/pre-tool/loop-detection.sh',
  'universal/post-tool/auto-format.sh', 'universal/post-tool/gitleaks-scan.sh',
  'universal/post-tool/sync-lr-refined-date.sh', 'universal/session-end/rotate-session-key.sh',
  'universal/session-end/write-baton.sh', 'universal/session-start/graph-preflight.sh',
  'universal/session-start/load-baton.sh',
];
const WIRED_TODAY = { 'load-baton.sh': ['SessionStart', '*'], 'write-baton.sh': ['SessionEnd', '*'] };
const CMD = name => `.claude/hooks/${name}`;

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-hooks-418-')));
  try {
    mkdirSync(path.join(dir, '.git'));
    mkdirSync(path.join(dir, '.workflow'));
    writeFileSync(path.join(dir, '.workflow/profile.yml'), `skills:\nhooks:\n${ALL_HOOKS.map(h => `  - ${h}\n`).join('')}subagents:\n`);
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every path below `dir` with its bytes; folders are listed with a trailing slash. */
function snapshot(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (e.isFile()) out[rel] = readFileSync(path.join(dir, rel));
    else if (e.isDirectory() && !rel.startsWith('.git')) out[`${rel}/`] = '';
  }
  return out;
}
const settingsPath = dir => path.join(dir, '.claude/settings.json');
const readSettings = dir => JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
const readRecord = dir => JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
const commandsIn = settings => Object.values(settings.hooks ?? {}).flat()
  .flatMap(group => group.hooks.map(h => h.command));

const USER_SETTINGS = {
  permissions: { allow: ['Bash(npm test)'] },
  env: { FOO: 'bar' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-lint.sh' }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] }],
  },
};

test(`init wires the hooks it can wire into an empty project's settings.json (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readSettings(dir), {
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: CMD('load-baton.sh') }] }],
        SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: CMD('write-baton.sh') }] }],
      },
    });
    const record = readRecord(dir).claude_hooks;
    assert.equal(record.length, 2);
    assert.equal(readRecord(dir).claude_hooks_created_file, true, 'init created settings.json');
    // Every copied hook is either wired or named with its reason; none is unmapped.
    assert.doesNotMatch(r.stdout, /no mapping/);
    for (const name of ALL_HOOKS.map(h => path.basename(h))) assert.match(r.stdout, new RegExp(name.replace(/\./g, '\\.')));
    assert.match(r.stdout, /wired 2 hook/);
    assert.doesNotMatch(r.stdout, /do it by hand|wire them/);
  });
});

test(`init keeps every other key and hook of an existing settings.json (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readSettings(dir);
    assert.deepEqual(after.permissions, USER_SETTINGS.permissions);
    assert.deepEqual(after.env, USER_SETTINGS.env);
    assert.deepEqual(after.hooks.PreToolUse, USER_SETTINGS.hooks.PreToolUse);
    assert.deepEqual(after.hooks.SessionStart.slice(0, 1), USER_SETTINGS.hooks.SessionStart);
    assert.deepEqual(after.hooks.SessionStart[1], { matcher: '*', hooks: [{ type: 'command', command: CMD('load-baton.sh') }] });
    assert.equal(readRecord(dir).claude_hooks_created_file, false, 'settings.json was there before');
  });
});

test(`running init twice adds no duplicate entry (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const first = readFileSync(settingsPath(dir), 'utf8');
    const firstRecord = readRecord(dir).claude_hooks;
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), first);
    assert.deepEqual(readRecord(dir).claude_hooks, firstRecord);
    assert.deepEqual(commandsIn(readSettings(dir)).sort(), [CMD('load-baton.sh'), CMD('write-baton.sh')]);
  });
});

test(`a command already in settings.json is left alone and not recorded (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const user = { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: CMD('load-baton.sh') }] }] } };
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(user, null, 2)}\n`);
    assert.equal(init(dir).status, 0);
    const record = readRecord(dir).claude_hooks;
    assert.deepEqual(record.map(e => e.command), [CMD('write-baton.sh')], 'only the entry init added is recorded');
    assert.deepEqual(readSettings(dir).hooks.SessionStart, user.hooks.SessionStart);
    assert.equal(uninstall(dir).status, 0);
    assert.deepEqual(readSettings(dir), user, 'the user entry survives uninstall');
  });
});

test(`uninstall removes the entries init added and deletes settings.json init created (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    assert.equal(init(dir).status, 0);
    assert.ok(existsSync(settingsPath(dir)));
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /remove {4}\.claude\/settings\.json/);
    assert.deepEqual(snapshot(dir), before, 'the project is as it was');
  });
});

test(`uninstall keeps the user's own entries in a settings.json init edited (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    assert.equal(init(dir).status, 0);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readSettings(dir), USER_SETTINGS);
    assert.equal(existsSync(path.join(dir, MANIFEST)), false, 'nothing is left to record');
  });
});

test(`uninstall keeps an edited entry, names it, and leaves the manifest record (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    settings.hooks.SessionEnd[0].hooks[0].timeout = 30;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /kept {6}\.claude\/settings\.json \(the SessionEnd hook for write-baton\.sh\): edited since DevOPs wrote it/);
    // The edited entry is left as the user edited it; the unedited SessionStart entry is removed.
    assert.deepEqual(readSettings(dir), { hooks: { SessionEnd: settings.hooks.SessionEnd } });
    const left = readRecord(dir).claude_hooks.map(e => e.command);
    assert.deepEqual(left, [CMD('write-baton.sh')], 'the edited entry keeps its record');
  });
});

test(`a malformed claude_hooks field is refused and uninstall changes nothing (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const good = readRecord(dir);
    const entry = { event: 'SessionEnd', matcher: '*', command: CMD('write-baton.sh'), sha256: 'a'.repeat(64) };
    const bad = [
      'write-baton.sh',
      [{ ...entry, sha256: 'NOT-HEX' }],
      [{ ...entry, extra: 1 }],
      [{ event: 'SessionEnd', matcher: '*', command: CMD('write-baton.sh') }],
      [{ ...entry, command: '../../evil.sh' }],
      [{ ...entry, command: 'sh -c evil' }],
      [{ ...entry, event: '' }],
    ];
    for (const value of bad) {
      writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify({ ...good, claude_hooks: value }, null, 2)}\n`);
      const installed = snapshot(dir);
      const r = uninstall(dir);
      assert.equal(r.status, 1, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /unknown schema/, JSON.stringify(value));
      assert.deepEqual(snapshot(dir), installed, 'nothing changed');
    }
  });
});

test(`a symlinked settings.json is left alone, with a warning and nothing recorded (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-hooks-outside-')));
    try {
      const target = path.join(outside, 'settings.json');
      const bytes = `${JSON.stringify(USER_SETTINGS, null, 2)}\n`;
      writeFileSync(target, bytes);
      mkdirSync(path.join(dir, '.claude'));
      symlinkSync(target, settingsPath(dir));
      const r = init(dir);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /settings\.json.*symlink.*left unchanged/);
      assert.equal(readFileSync(target, 'utf8'), bytes, 'the file the link points at is untouched');
      assert.ok(lstatSync(settingsPath(dir)).isSymbolicLink(), 'the link is still there');
      assert.equal(readRecord(dir).claude_hooks, undefined, 'no entry is recorded');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`a settings.json that is not a JSON object is left unchanged, with a warning (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    for (const text of ['[1, 2]\n', '{ not json\n', '"text"\n']) {
      writeFileSync(settingsPath(dir), text);
      const r = init(dir);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /settings\.json is not a JSON object; left unchanged/);
      assert.equal(readFileSync(settingsPath(dir), 'utf8'), text);
      assert.equal(readRecord(dir).claude_hooks, undefined);
    }
  });
});

test(`a dry run says what it would wire and changes nothing (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    const r = init(dir, '--dry-run');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /would wire 2 hook/);
    assert.match(r.stdout, /would add .*SessionStart.*load-baton\.sh/);
    assert.deepEqual(snapshot(dir), before, 'nothing was written');
  });
});

test(`the recorded sha256 is the hash of the inner hook object (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const [record] = readRecord(dir).claude_hooks.filter(e => e.command === CMD('load-baton.sh'));
    const inner = readSettings(dir).hooks.SessionStart[0].hooks[0];
    assert.equal(record.sha256, createHash('sha256').update(JSON.stringify(inner)).digest('hex'));
  });
});

test(`wired hooks are copied executable into .claude/hooks (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    for (const name of Object.keys(WIRED_TODAY)) {
      assert.ok((statSync(path.join(dir, '.claude/hooks', name)).mode & 0o111) !== 0, `${name} is executable`);
    }
  });
});
