// specs/release/npm-package.md REQ-15, AC-27 (issue #418): `devops init` wires the Claude Code
// hooks it copies into .claude/settings.json, records each entry it adds in the install
// manifest (`claude_hooks`), and `devops uninstall` removes only the recorded entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  'universal/pre-tool/block-secrets.sh', 'universal/pre-tool/protect-gates.sh', 'universal/pre-tool/protect-gates-bash.sh', 'universal/pre-tool/budget-brake.sh',
  'universal/pre-tool/client-boundary.sh', 'universal/pre-tool/deploy-gate.sh',
  'universal/pre-tool/external-content-boundary.sh', 'universal/pre-tool/loop-detection.sh',
  'universal/post-tool/auto-format.sh', 'universal/post-tool/gitleaks-scan.sh',
  'universal/post-tool/sync-lr-refined-date.sh', 'universal/session-end/rotate-session-key.sh',
  'universal/session-end/write-baton.sh', 'universal/session-start/graph-preflight.sh',
  'universal/session-start/load-baton.sh',
];
const cmd = command => ({ type: 'command', command });
const RUN = (phase, name, input) => cmd(`node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/run-hook.mjs" ${phase} ${name} ${input}${phase === 'pre' ? ' || exit 2' : ''}`);
const PLAIN = name => cmd(`cd "\${CLAUDE_PROJECT_DIR:-.}" && bash .claude/hooks/${name} || true`);
const BASH = 'Bash';
const READ_WRITE = 'Read|Write|Edit|MultiEdit|NotebookEdit';
const WRITES = 'Write|Edit|MultiEdit';
const WRITE_GATES = 'Write|Edit|MultiEdit|NotebookEdit';
// What init writes into an empty project: each group in the order the profile lists its hooks.
const EXPECTED_HOOKS = {
  PreToolUse: [
    { matcher: BASH, hooks: [
      RUN('pre', 'block-new-dependency.sh', 'command'),
      RUN('pre', 'block-prod-write.sh', 'command'),
      RUN('pre', 'block-rm-rf.sh', 'command'),
      RUN('pre', 'block-sealed-refs.sh', 'stdin'),
      RUN('pre', 'protect-gates-bash.sh', 'command'),
      RUN('pre', 'deploy-gate.sh', 'stdin'),
    ] },
    { matcher: READ_WRITE, hooks: [RUN('pre', 'block-secrets.sh', 'file')] },
    { matcher: WRITE_GATES, hooks: [RUN('pre', 'protect-gates.sh', 'file')] },
  ],
  PostToolUse: [{ matcher: WRITES, hooks: [RUN('post', 'gitleaks-scan.sh', 'file')] }],
  SessionStart: [{ hooks: [PLAIN('load-baton.sh')] }],
};
const WIRED_COMMANDS = Object.values(EXPECTED_HOOKS).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
const WIRED_FILES = ['block-new-dependency.sh', 'block-prod-write.sh', 'block-rm-rf.sh', 'block-sealed-refs.sh',
  'block-secrets.sh', 'deploy-gate.sh', 'gitleaks-scan.sh', 'load-baton.sh', 'protect-gates-bash.sh', 'protect-gates.sh', 'run-hook.mjs'];

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
    assert.deepEqual(readSettings(dir), { hooks: EXPECTED_HOOKS });
    const record = readRecord(dir).claude_hooks;
    assert.equal(record.length, WIRED_COMMANDS.length);
    assert.equal(readRecord(dir).claude_hooks_created_file, true, 'init created settings.json');
    // Every copied hook is either wired or named with its reason; none is unmapped.
    assert.doesNotMatch(r.stdout, /no mapping/);
    for (const name of ALL_HOOKS.map(h => path.basename(h))) assert.match(r.stdout, new RegExp(name.replace(/\./g, '\\.')));
    assert.match(r.stdout, /wired 10 hooks/);
    assert.doesNotMatch(r.stdout, /do it by hand|wire them/);
  });
});

test(`init names each hook it does not wire with its reason (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const reasons = {
      'budget-brake.sh': 'needs a per-call cost estimate',
      'loop-detection.sh': 'needs a tool name and arguments',
      'auto-format.sh': 'opt-in: it rewrites files',
      'sync-lr-refined-date.sh': 'edits docs/LAUNCH_READINESS.md',
      'client-boundary.sh': 'not registered by default',
      'external-content-boundary.sh': 'rotate-session-key.sh',
      'rotate-session-key.sh': 'external-content-boundary.sh',
      'write-baton.sh': 'overwrites a hand-written baton',
      'graph-preflight.sh': 'Agile Graph pipeline',
    };
    for (const [name, reason] of Object.entries(reasons)) {
      assert.match(r.stdout, new RegExp(`not wired: ${name.replace(/\./g, '\\.')} \\(.*${reason.replace(/[.]/g, '\\.')}`), name);
    }
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
    // The user's Bash hook stays first in its group; init's Bash hooks follow it.
    assert.deepEqual(after.hooks.PreToolUse[0].hooks[0], USER_SETTINGS.hooks.PreToolUse[0].hooks[0]);
    assert.deepEqual(after.hooks.PreToolUse[0].hooks.slice(1), EXPECTED_HOOKS.PreToolUse[0].hooks);
    assert.deepEqual(after.hooks.PreToolUse[1], EXPECTED_HOOKS.PreToolUse[1]);
    assert.deepEqual(after.hooks.SessionStart, [USER_SETTINGS.hooks.SessionStart[0], EXPECTED_HOOKS.SessionStart[0]]);
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
    assert.deepEqual(commandsIn(readSettings(dir)).sort(), [...WIRED_COMMANDS].sort());
  });
});

// The hook files a settings.json command runs: the hooks under .claude/hooks it names, and the hook
// that a run-hook.mjs command names.
function hookFilesNamedBy(command) {
  const names = [...command.matchAll(/\.claude\/hooks\/([\w.-]+)/g)].map(m => m[1]);
  const hook = / (?:pre|post) ([\w.-]+) (?:stdin|command|file)/.exec(command);
  return hook ? [...names, hook[1]] : names;
}

test(`the load-baton command reads the root's baton from a subdirectory and creates no .workflow there (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    writeFileSync(path.join(dir, '.workflow/state/baton.md'), '# baton\n');
    const sub = path.join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const command = readSettings(dir).hooks.SessionStart[0].hooks[0].command;
    const r = spawnSync('bash', ['-c', command], { cwd: sub, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /BATON FOUND/);
    assert.equal(existsSync(path.join(sub, '.workflow')), false, 'no .workflow in the subdirectory');
  });
});

test(`a block-rm-rf command under PostToolUse does not stop init wiring the PreToolUse gate (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    const user = { hooks: { PostToolUse: [{ matcher: WRITES, hooks: [RUN('pre', 'block-rm-rf.sh', 'command')] }] } };
    writeFileSync(settingsPath(dir), `${JSON.stringify(user, null, 2)}\n`);
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /already wired: block-rm-rf/);
    const settings = readSettings(dir);
    const bash = settings.hooks.PreToolUse.find(group => group.matcher === BASH);
    assert.ok(bash.hooks.some(h => h.command === RUN('pre', 'block-rm-rf.sh', 'command').command), 'the PreToolUse gate is wired');
    assert.deepEqual(settings.hooks.PostToolUse[0].hooks[0], user.hooks.PostToolUse[0].hooks[0], "the user's entry is kept");
  });
});

test(`the same command under the same event but with no matcher does not count as wired (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    const user = { hooks: { PreToolUse: [{ hooks: [RUN('pre', 'block-rm-rf.sh', 'command')] }] } };
    writeFileSync(settingsPath(dir), `${JSON.stringify(user, null, 2)}\n`);
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /already wired: block-rm-rf/);
    const pre = readSettings(dir).hooks.PreToolUse;
    assert.deepEqual(pre[0], user.hooks.PreToolUse[0], "the user's group is unchanged");
    assert.ok(pre.find(group => group.matcher === BASH).hooks.some(h => h.command === RUN('pre', 'block-rm-rf.sh', 'command').command));
  });
});

test(`a hook already wired is printed as "already wired" and is not added again (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const before = readFileSync(settingsPath(dir), 'utf8');
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split('\n').filter(line => line.startsWith('  already wired: '));
    assert.equal(lines.length, WIRED_COMMANDS.length, r.stdout);
    for (const [name, event] of [['block-rm-rf.sh', 'PreToolUse'], ['block-secrets.sh', 'PreToolUse'], ['gitleaks-scan.sh', 'PostToolUse'], ['load-baton.sh', 'SessionStart']]) {
      assert.ok(lines.includes(`  already wired: ${name} (${event})`), `${name} (${event}): ${r.stdout}`);
    }
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), before, 'nothing was added');
  });
});

test(`uninstall keeps an edited run-hook entry, its runner and its hook, and names them (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    const rmRf = settings.hooks.PreToolUse.find(group => group.matcher === BASH).hooks.find(h => h.command.includes('block-rm-rf.sh'));
    rmRf.timeout = 30;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^kept {6}\.claude\/hooks\/run-hook\.mjs and \.claude\/hooks\/block-rm-rf\.sh: an entry in \.claude\/settings\.json still runs them; delete that entry, then run devops uninstall again$/m);
    assert.match(r.stdout, /kept {6}\.claude\/settings\.json \(the PreToolUse hook for block-rm-rf\.sh\): edited since DevOPs wrote it/);
    assert.ok(existsSync(path.join(dir, '.claude/hooks/run-hook.mjs')), 'the runner stays');
    assert.ok(existsSync(path.join(dir, '.claude/hooks/block-rm-rf.sh')), 'the hook stays');
    // The kept entry is the only one left, and every file a command names is still there.
    const commands = commandsIn(readSettings(dir));
    assert.deepEqual(commands, [rmRf.command]);
    for (const command of commands) {
      for (const file of hookFilesNamedBy(command)) assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} exists for ${command}`);
    }
    const record = readRecord(dir);
    assert.ok(record.files['.claude/hooks/run-hook.mjs'] && record.files['.claude/hooks/block-rm-rf.sh'], 'both stay in the manifest');
    // Once the user deletes that entry, the next uninstall removes both.
    writeFileSync(settingsPath(dir), '{}\n');
    const again = uninstall(dir);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(existsSync(path.join(dir, '.claude/hooks/run-hook.mjs')), false, 'the runner is removed');
    assert.equal(existsSync(path.join(dir, '.claude/hooks/block-rm-rf.sh')), false, 'the hook is removed');
    assert.equal(existsSync(path.join(dir, MANIFEST)), false, 'nothing is left to record');
  });
});

test(`uninstall keeps the modules a kept hook calls beside it (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    const all = Object.values(settings.hooks).flat().flatMap(group => group.hooks);
    for (const name of ['protect-gates.sh', 'deploy-gate.sh', 'block-new-dependency.sh']) all.find(h => h.command.includes(` ${name} `)).timeout = 30;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const file of ['protect-gates.sh', 'protect-gates.mjs', 'deploy-gate.sh', 'graph-command-classifier.mjs', 'block-new-dependency.sh', 'new-dependency-classifier.mjs']) {
      assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} stays for the kept entry`);
    }
    assert.equal(existsSync(path.join(dir, '.claude/hooks/block-rm-rf.sh')), false, 'a hook no kept entry runs is removed');
  });
});

test(`uninstall reads no hook file through a linked .claude/hooks (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    Object.values(settings.hooks).flat().flatMap(group => group.hooks).find(h => h.command.includes(' protect-gates.sh ')).timeout = 30;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    // Another tree whose protect-gates.sh names a hook this project recorded.
    const outside = mkdtempSync(path.join(tmpdir(), 'hooks-outside-'));
    try {
      writeFileSync(path.join(outside, 'protect-gates.sh'), 'bash block-rm-rf.sh\n');
      rmSync(path.join(dir, '.claude/hooks'), { recursive: true, force: true });
      symlinkSync(outside, path.join(dir, '.claude/hooks'));
      const r = uninstall(dir, '--dry-run');
      assert.doesNotMatch(r.stdout, /^kept {6}[^\n]*block-rm-rf\.sh[^\n]*still runs/m, r.stdout);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`a later uninstall still keeps a hook file a user's own entry runs (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    settings.hooks.PreToolUse.push({ matcher: BASH, hooks: [cmd('bash .claude/hooks/block-rm-rf.sh || exit 2')] });
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const first = uninstall(dir);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /^kept {6}\.claude\/hooks\/block-rm-rf\.sh: /m);
    // The recorded entries are gone now; the second run must still read settings.json.
    const second = uninstall(dir);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.ok(existsSync(path.join(dir, '.claude/hooks/block-rm-rf.sh')), 'the user entry still runs it');
    assert.match(second.stdout, /^kept {6}\.claude\/hooks\/block-rm-rf\.sh: /m);
  });
});

test(`uninstall that cannot rewrite settings.json keeps every hook file it still runs (${SPEC}#ac-27)`, { skip: process.getuid?.() === 0 && 'root writes into a read-only folder' }, () => {
  withProject(dir => {
    // A user's own key, so uninstall rewrites the file instead of deleting it.
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), '{ "model": "user-choice" }\n');
    assert.equal(init(dir).status, 0);
    // A read-only folder makes the temporary copy impossible to create, so the whole-file replacement fails.
    chmodSync(path.join(dir, '.claude'), 0o555);
    let r;
    try {
      r = uninstall(dir);
    } finally {
      chmodSync(path.join(dir, '.claude'), 0o755);
    }
    assert.match(r.stdout, /^kept {6}\.claude\/settings\.json: /m);
    const commands = commandsIn(readSettings(dir));
    assert.ok(commands.length > 0, 'the entries are still in settings.json');
    for (const command of commands) {
      for (const file of hookFilesNamedBy(command)) assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} exists for ${command}`);
    }
    for (const file of ['protect-gates.mjs', 'graph-command-classifier.mjs', 'new-dependency-classifier.mjs']) {
      assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} stays beside the hook that calls it`);
    }
  });
});

test(`uninstall removes its own entry, not a user's identical command in another group (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const inner = RUN('pre', 'block-rm-rf.sh', 'command');
    const { command } = inner;
    const user = { hooks: { PreToolUse: [{ hooks: [inner] }] } };
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(user, null, 2)}\n`);
    assert.equal(init(dir).status, 0);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readSettings(dir);
    assert.deepEqual(after.hooks.PreToolUse, user.hooks.PreToolUse, "the user's matcher-less group is untouched");
    // The user's command still runs the runner and the hook, so both stay.
    for (const file of hookFilesNamedBy(command)) assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} stays`);
  });
});

test(`uninstall keeps the files a command still runs when its text was edited (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const settings = readSettings(dir);
    const group = settings.hooks.PreToolUse.find(g => g.matcher === BASH);
    const rmRf = group.hooks.find(h => h.command.includes('block-rm-rf.sh'));
    rmRf.command = `${rmRf.command} # mine`;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^kept {6}\.claude\/hooks\/(run-hook\.mjs and \.claude\/hooks\/block-rm-rf\.sh|block-rm-rf\.sh and \.claude\/hooks\/run-hook\.mjs): an entry in/m);
    for (const command of commandsIn(readSettings(dir))) {
      for (const file of hookFilesNamedBy(command)) assert.ok(existsSync(path.join(dir, '.claude/hooks', file)), `${file} exists for ${command}`);
    }
  });
});

test(`a command already in settings.json is left alone and not recorded (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    const user = { hooks: { SessionStart: [{ hooks: [PLAIN('load-baton.sh')] }] } };
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(user, null, 2)}\n`);
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^  already wired: load-baton\.sh \(SessionStart\)$/m);
    assert.match(r.stdout, /wired 9 hooks/, 'the other hooks are still added');
    const record = readRecord(dir).claude_hooks;
    assert.deepEqual(record.map(e => e.command).sort(), WIRED_COMMANDS.filter(c => c !== PLAIN('load-baton.sh').command).sort(),
      'only the entries init added are recorded');
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
    settings.hooks.SessionStart[0].hooks[0].timeout = 30;
    writeFileSync(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /kept {6}\.claude\/settings\.json \(the SessionStart hook for load-baton\.sh\): edited since DevOPs wrote it/);
    // The edited entry is left as the user edited it; the unedited entries are removed.
    assert.deepEqual(readSettings(dir), { hooks: { SessionStart: settings.hooks.SessionStart } });
    const left = readRecord(dir).claude_hooks.map(e => e.command);
    assert.deepEqual(left, [PLAIN('load-baton.sh').command], 'the edited entry keeps its record');
  });
});

test(`a malformed claude_hooks field is refused and uninstall changes nothing (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const good = readRecord(dir);
    const entry = { event: 'SessionStart', command: PLAIN('load-baton.sh').command, sha256: 'a'.repeat(64) };
    const bad = [
      'write-baton.sh',
      [{ ...entry, sha256: 'NOT-HEX' }],
      [{ ...entry, extra: 1 }],
      [{ event: 'SessionStart', command: PLAIN('load-baton.sh').command }],
      [{ ...entry, command: '../../evil.sh' }],
      [{ ...entry, command: 'sh -c evil' }],
      [{ ...entry, command: 'bash "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/x.sh" ; touch pwned' }],
      [{ ...entry, event: '' }],
      [{ ...entry, matcher: 5 }],
      [{ ...entry, command: 'bash "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/load-baton.sh" || true' }],
      [{ ...entry, command: '.claude/hooks/load-baton.sh' }],
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
    assert.match(r.stdout, /would wire 10 hooks/);
    assert.match(r.stdout, /would add .*SessionStart.*load-baton\.sh/);
    assert.deepEqual(snapshot(dir), before, 'nothing was written');
  });
});

test(`the recorded sha256 is the hash of the inner hook object (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    const [record] = readRecord(dir).claude_hooks.filter(e => e.command === PLAIN('load-baton.sh').command);
    const inner = readSettings(dir).hooks.SessionStart[0].hooks[0];
    assert.equal(record.sha256, createHash('sha256').update(JSON.stringify(inner)).digest('hex'));
  });
});

test(`wired hooks and the run-hook.mjs runner are copied executable into .claude/hooks (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    for (const name of WIRED_FILES) {
      assert.ok((statSync(path.join(dir, '.claude/hooks', name)).mode & 0o111) !== 0, `${name} is executable`);
    }
  });
});

test(`the run-hook.mjs runner is recorded in the manifest with the hooks (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    assert.ok(readRecord(dir).files['.claude/hooks/run-hook.mjs'], 'run-hook.mjs is in the manifest files');
    assert.equal(uninstall(dir).status, 0);
    assert.equal(existsSync(path.join(dir, '.claude/hooks/run-hook.mjs')), false, 'uninstall removes the runner');
  });
});

// #426: the side effects of rewriting settings.json.
test(`a pre-existing .claude/settings.json.tmp is never read, overwritten or removed (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    writeFileSync(path.join(dir, '.claude/settings.json.tmp'), "the user's own notes\n");
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(path.join(dir, '.claude/settings.json.tmp'), 'utf8'), "the user's own notes\n");
    assert.deepEqual(readdirSync(path.join(dir, '.claude')).sort(), ['hooks', 'settings.json', 'settings.json.tmp'], 'no temp file of init is left');
    assert.equal(uninstall(dir).status, 0);
    assert.equal(readFileSync(path.join(dir, '.claude/settings.json.tmp'), 'utf8'), "the user's own notes\n");
  });
});

test(`a failed settings.json write removes only the temp file it created (${SPEC}#ac-27)`, async () => {
  const { replaceWholeUnique } = await import('../analyzer/install-manifest.js');
  assert.equal(typeof replaceWholeUnique, 'function');
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-hooks-tmp-')));
  try {
    mkdirSync(path.join(dir, '.claude/settings.json'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/settings.json.tmp'), 'KEEP');
    // A folder where the file goes makes the final rename fail after the temp file exists.
    assert.throws(() => replaceWholeUnique(dir, '.claude/settings.json', '{}\n'));
    assert.deepEqual(readdirSync(path.join(dir, '.claude')).sort(), ['settings.json', 'settings.json.tmp']);
    assert.equal(readFileSync(path.join(dir, '.claude/settings.json.tmp'), 'utf8'), 'KEEP');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`init keeps the indentation and trailing newline of settings.json, and uses 2 spaces for a new file (${SPEC}#ac-27)`, () => {
  for (const [indent, newline] of [['    ', '\n'], ['\t', '\n'], ['  ', ''], ['\t', '']]) {
    withProject(dir => {
      mkdirSync(path.join(dir, '.claude'));
      const text = `${JSON.stringify(USER_SETTINGS, null, indent)}${newline}`;
      writeFileSync(settingsPath(dir), text);
      assert.equal(init(dir).status, 0, JSON.stringify(indent));
      const after = readFileSync(settingsPath(dir), 'utf8');
      assert.equal(after.startsWith(`{\n${indent}"permissions"`), true, `indent ${JSON.stringify(indent)} kept`);
      assert.equal(after.endsWith('\n'), newline === '\n', 'trailing newline as it was');
      assert.equal(uninstall(dir).status, 0);
      assert.equal(readFileSync(settingsPath(dir), 'utf8'), text, 'uninstall writes the same text back');
    });
  }
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), '{"permissions":{"allow":["Bash(npm test)"]}}');
    assert.equal(init(dir).status, 0);
    assert.match(readFileSync(settingsPath(dir), 'utf8'), /^\{\n {2}"permissions": \{\n {4}"allow"/, 'no indented line: 2 spaces');
  });
  withProject(dir => {
    assert.equal(init(dir).status, 0);
    assert.match(readFileSync(settingsPath(dir), 'utf8'), /^\{\n {2}"hooks": \{\n {4}"PreToolUse"/, 'a new file: 2 spaces');
  });
});

test(`init leaves settings.json unchanged and records nothing when a number would not survive JSON exactly (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    const text = '{\n  "maxTokens": 9007199254740993,\n  "label": "9007199254740993 is text"\n}\n';
    writeFileSync(settingsPath(dir), text);
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^⚠ \.claude\/settings\.json has a number JSON would not keep exactly/m);
    assert.equal(readFileSync(settingsPath(dir), 'utf8'), text);
    assert.equal(readRecord(dir).claude_hooks, undefined, 'no entry is recorded');
  });
});

test(`a safe integer and a digit inside a string do not stop init (${SPEC}#ac-27)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsPath(dir), '{\n  "maxTokens": 9007199254740991,\n  "label": "9007199254740993"\n}\n');
    const r = init(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /wired 10 hooks/);
    assert.equal(readSettings(dir).maxTokens, 9007199254740991);
  });
});
