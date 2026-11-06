// REQ-M16: seeded property/differential test. For generated commands mixing
// Unicode White_Space/Cf characters, '#', quotes, operators and deploy-like
// words, whenever real bash EXECUTES a deploy word (recorded by PATH stubs),
// the deploy classifier must not answer "allow".
// Replay a failure with GRAPH_CLASSIFIER_SEED=<n>; widen with GRAPH_CLASSIFIER_CASES=<n>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLASSIFIER = path.join(ROOT, 'hooks/universal/pre-tool/graph-command-classifier.mjs');
const SEED = Number(process.env.GRAPH_CLASSIFIER_SEED ?? 0x5eed1234) >>> 0;
const CASES = Number(process.env.GRAPH_CLASSIFIER_CASES ?? 150);
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

const env = { ...process.env, LC_ALL: 'C.UTF-8' };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete env[key];

// mulberry32: small seeded PRNG, no dependency.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every code point that is Unicode White_Space or general category Cf.
const SPECIAL = [];
for (let cp = 1; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  if (/[\p{White_Space}\p{Cf}]/u.test(c)) SPECIAL.push(c);
}
const label = (value) => [...value].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

const DEPLOYS = [
  'vercel deploy', 'vercel --prod', 'vercel --production', 'wrangler deploy',
  'npm publish', 'gh release create v1', 'supabase db push',
];
const HARMLESS = [':', 'true', 'echo hi', 'vercel ls', 'npm test', 'gh release list'];
const PREFIXES = ['', '', '', 'env ', 'command ', 'FOO=1 ', 'env FOO=1 ', 'nohup '];
// Unrecognised wrappers: bash still runs the deploy word they pass on.
const sq = (x) => `'${x.replaceAll("'", "'\\''")}'`;
const dq = (x) => `"${x.replace(/([\\"$`])/g, '\\$1')}"`;
const SHELL_WRAPS = [
  (x) => `sudo ${x}`, (x) => `doas ${x}`, (x) => `xargs ${x}`, (x) => `sudo -u root ${x}`, (x) => `xargs -n 1 ${x}`,
  (x) => `bash -c ${sq(x)}`, (x) => `sh -c ${dq(x)}`, (x) => `zsh -c ${sq(x)}`, (x) => `dash -c ${dq(x)}`, (x) => `bash -lc ${sq(x)}`,
  (x) => `eval ${sq(x)}`, (x) => `eval ${x}`, (x) => `builtin eval ${dq(x)}`, (x) => `sudo bash -c ${sq(x)}`,
  (x) => `sh -c ${sq(`sh -c ${sq(x)}`)}`,
];
const OPERATORS = [';', '&&', '||', '|', '&', '\n'];
const WRAPS = [
  (x) => `$(${x})`, (x) => `\`${x}\``, (x) => `<(${x})`, (x) => `(${x})`,
  (x) => `{ ${x}; }`, (x) => `"$(${x})"`, (x) => `echo $(${x})`, (x) => `: \`${x}\``,
  (x) => `cat <(${x})`, (x) => `if ${x}; then :; fi`, (x) => `for i in 1; do ${x}; done`,
];
const JUNK = ['#', "'", '"', '\\', '$', '`', '$(', ')', '(', '<(', '"#', "'#'", '\\#', '# ', ' #'];

function generate(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const special = () => pick(SPECIAL);
  const sep = () => pick(rand() < 0.5 ? [' ', ' '] : [' ', special(), ' ' + special(), special() + ' ']);
  const deploy = () => {
    const words = pick(DEPLOYS).split(' ');
    const text = pick(PREFIXES) + words.join(rand() < 0.2 ? sep() : ' ');
    return rand() < 0.25 ? pick(SHELL_WRAPS)(text) : text;
  };
  const simple = () => {
    const r = rand();
    if (r < 0.45) return deploy();
    if (r < 0.55) return pick(JUNK) + sep() + deploy();
    if (r < 0.65) return deploy() + sep() + pick(JUNK);
    if (r < 0.75) return pick(HARMLESS);
    if (r < 0.85) return `${pick(["'", '"'])}${special()}${pick(["'", '"'])} ${deploy()}`;
    return `${special()}${deploy()}`;
  };
  const parts = [];
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
    let piece = simple();
    if (rand() < 0.4) piece = pick(WRAPS)(piece);
    if (rand() < 0.25) piece = pick(JUNK) + sep() + piece;
    parts.push(piece);
    if (n > 1) parts.push(sep() + pick(OPERATORS) + sep());
  }
  return parts.join('');
}

const isDeploy = (name, args) => {
  if (name === 'vercel') return args.some((a) => ['deploy', '--prod', '--production'].includes(a));
  if (name === 'wrangler') return args.includes('deploy');
  if (name === 'npm') return args[0] === 'publish';
  if (name === 'supabase') return args[0] === 'db' && args[1] === 'push';
  if (name === 'gh') return args[0] === 'release' && !['list', 'view', 'download', '--help', '-h', undefined].includes(args[1]);
  return false;
};

function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-properties-test-')));
  const bin = path.join(dir, 'stub-bin');
  const mark = path.join(dir, 'executed.log');
  mkdirSync(bin);
  writeFileSync(mark, '');
  for (const name of ['vercel', 'wrangler', 'npm', 'gh', 'supabase']) {
    const file = path.join(bin, name);
    // Records argv only; never runs anything real.
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\000' ${name} "$@" >> "$STUB_MARK"\nprintf '\\001' >> "$STUB_MARK"\n`);
    chmodSync(file, 0o755);
  }
  // Pass-through wrappers (the real ones need privileges or differ per host).
  for (const name of ['sudo', 'doas', 'xargs']) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\nwhile [ "\${1#-}" != "$1" ]; do case "$1" in -u|-n) shift 2;; *) shift;; esac; done\nexec "$@"\n`);
    chmodSync(file, 0o755);
  }
  const project = path.join(dir, 'project');
  mkdirSync(project);
  return { dir, bin, mark, project };
}

function executedDeploys(mark) {
  return readFileSync(mark, 'utf8').split('\u0001').filter(Boolean).map((record) => record.split('\0').slice(0, -1))
    .filter(([name, ...args]) => isDeploy(name, args));
}

test('generator is seeded and covers every White_Space and Cf character', () => {
  const a = prng(SEED); const b = prng(SEED);
  for (let i = 0; i < 50; i++) assert.equal(generate(a), generate(b));
  assert.ok(SPECIAL.length >= 40, 'enumerated ' + SPECIAL.length);
  for (const c of ['\u00a0', '\u2028', '\u200b', '\u202e', '\ufeff', '\u3000', '\u{e0001}', '\u00ad']) assert.ok(SPECIAL.includes(c), label(c));
});

test('deploy classifier never allows a command bash would run as a deploy (seed ' + SEED + ')', { skip: !hasBash && 'bash not available' }, () => {
  const { dir, bin, mark, project } = setup();
  try {
    const rand = prng(SEED);
    const runEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, STUB_MARK: mark };
    let executed = 0; let valid = 0; const bypasses = [];
    for (let i = 0; i < CASES; i++) {
      const command = generate(rand);
      // bash -n only classifies syntax; bash -c still runs complete commands
      // that precede a later syntax error, so execution is checked either way.
      if (spawnSync('bash', ['-n', '-c', command], { env: runEnv, encoding: 'utf8', timeout: 10_000 }).status === 0) valid++;
      writeFileSync(mark, '');
      const run = spawnSync('bash', ['-c', command], { env: runEnv, cwd: project, encoding: 'utf8', timeout: 10_000, input: '' });
      assert.equal(run.error, undefined);
      const hits = executedDeploys(mark);
      if (!hits.length) continue;
      executed++;
      const out = spawnSync(process.execPath, [CLASSIFIER, 'deploy', command], { cwd: project, env: runEnv, encoding: 'utf8', timeout: 30_000 });
      assert.equal(out.error, undefined);
      // Exit 1 (refusal to parse) is a fail-closed outcome, as the hook treats it as a block.
      if (out.status !== 0) continue;
      const decision = JSON.parse(out.stdout).decision;
      if (decision === 'allow') bypasses.push({ i, command: JSON.stringify(command), codepoints: label([...command].filter((c) => SPECIAL.includes(c)).join('')), hits });
    }
    assert.ok(valid > 0, 'generator produced no valid bash');
    assert.ok(executed >= CASES / 10, `only ${executed}/${CASES} generated commands executed a deploy word`);
    assert.deepEqual(bypasses, [], `seed ${SEED}: classifier allowed executed deploy words`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Regression shapes for the transparent-wrapper and reserved-word prefixes.
// Each is a command bash really runs as a deploy; the classifier must not allow it.
// "@" stands for the deploy command so the shapes stay readable.
const DEPLOY = ['ver', 'cel'].join('') + ' deploy';
const expand = (list) => list.map((shape) => shape.replaceAll('@', DEPLOY));
const REGRESSIONS = expand([
  'nohup @', 'exec @', 'nice @', 'nice -n 5 @', 'nice -5 @', 'nice --adjustment=5 @', 'timeout 5 @', 'timeout -k 1 5 @',
  'timeout --signal=KILL 5 @', 'timeout --foreground 5 @', 'stdbuf -o0 @', 'stdbuf -o L @', 'setsid @', 'setsid -f @',
  'time @', 'time -p @', '! @',
  'for i in 1; do @; done', 'if true; then @; fi', 'if false; then true; else @; fi',
  'if false; then true; elif true; then @; fi', 'while true; do @; break; done', 'until false; do @; break; done',
  'if true; then nohup nice -n 1 timeout 5 env A=1 @; fi', 'nohup env @', 'env nohup @',
]);
// Wrapper options that are not parsed exactly must fail closed (refusal or block).
const UNPARSED = expand(['nohup -x @', 'exec -a x @', 'nice -z @', 'timeout -x 5 @', 'timeout', 'stdbuf -z @', 'setsid -x @', 'time -x @']);
// Unrecognised wrappers must be blocked when they carry a deploy, even quoted.
const WRAPPED = expand([
  'sudo @', 'sudo -u root @', 'doas @', 'xargs @', 'xargs -n 1 @', 'sudo env A=1 @',
  "bash -c '@'", 'bash -c "@"', "sh -c '@'", 'sh -c "@"', "zsh -c '@'", "dash -c '@'", "bash -lc '@'",
  "bash -c 'echo hi; @'", "sudo bash -c '@'", `sh -c "sh -c '@'"`, 'bash -c "echo $(@)"',
  "eval '@'", 'eval @', 'eval "@"', "builtin eval '@'", 'builtin eval @', "echo x | xargs @", '/usr/bin/@', 'sudo "ver""cel" deploy',
]);
// Unparsable -c scripts cannot be shown harmless and must be blocked.
const WRAPPED_UNPARSED = ["bash -c 'echo \"'", "sh -c 'echo (a)'", 'bash -c', "eval 'echo \"'"];
// Benign commands keep their decision.
const BENIGN = [
  'FOO=1', 'FOO=1; echo hi', 'echo vercel', 'echo npm', 'sudo ls', 'xargs echo hi', "bash -c 'echo hi'", 'sh -c "ls -l"',
  'eval echo hi', 'builtin echo hi', 'bash script.sh', 'grep gh file', 'which vercel', 'man vercel',
  // Harmless text after an inert head keeps its decision, whatever it names.
  'echo wrangler deploy docs', 'echo vercel ls', 'echo vercel deploy --prod', 'printf "%s" vercel deploy',
];

function decide(command, project) {
  const out = spawnSync(process.execPath, [CLASSIFIER, 'deploy', command], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.error, undefined);
  return out.status === 0 ? JSON.parse(out.stdout).decision : 'refused';
}

test('regression: wrapper and reserved-word prefixes are not taken as the program', () => {
  const { dir, project } = setup();
  try {
    for (const command of [...REGRESSIONS, ...UNPARSED]) assert.notEqual(decide(command, project), 'allow', command);
    assert.equal(decide('nohup echo hi', project), 'allow');
    assert.equal(decide('timeout 5 echo hi', project), 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('regression: bash really runs each regression shape as a deploy', { skip: !hasBash && 'bash not available' }, () => {
  const { dir, bin, mark, project } = setup();
  try {
    const runEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, STUB_MARK: mark };
    for (const command of REGRESSIONS) {
      writeFileSync(mark, '');
      spawnSync('bash', ['-c', command], { env: runEnv, cwd: project, encoding: 'utf8', timeout: 10_000, input: '' });
      // Wrappers or GNU long options missing on this host (e.g. timeout, setsid on macOS) cannot execute; skip those.
      if (/(setsid|timeout|stdbuf|nice --adjustment)/.test(command) && !executedDeploys(mark).length) continue;
      assert.ok(executedDeploys(mark).length > 0, 'not executed: ' + command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('regression: unrecognised wrappers and shell -c scripts fail closed', () => {
  const { dir, project } = setup();
  try {
    for (const command of WRAPPED) assert.equal(decide(command, project), 'block', command);
    for (const command of WRAPPED_UNPARSED) assert.notEqual(decide(command, project), 'allow', command);
    assert.equal(JSON.parse(spawnSync(process.execPath, [CLASSIFIER, 'deploy', `sudo ${DEPLOY}`], { cwd: project, env, encoding: 'utf8' }).stdout).reason, 'unrecognised command wrapper');
    for (const command of BENIGN) assert.equal(decide(command, project), 'allow', command);
    // Sealed mode only reacts to sealed-ref mutations.
    const sealed = (command) => JSON.parse(spawnSync(process.execPath, [CLASSIFIER, 'sealed', command], { cwd: project, env, encoding: 'utf8' }).stdout).decision;
    assert.equal(sealed(`sudo ${DEPLOY}`), 'allow');
    assert.equal(sealed('sudo git tag -d v0.2.0'), 'block');
    assert.equal(sealed("bash -c 'git tag -d v0.2.0'"), 'block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('regression: bash really runs each wrapped shape as a deploy', { skip: !hasBash && 'bash not available' }, () => {
  const { dir, bin, mark, project } = setup();
  try {
    const runEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, STUB_MARK: mark };
    const missing = ['zsh', 'dash'].filter((shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status !== 0);
    for (const command of WRAPPED.filter((c) => !c.startsWith('/usr/bin/') && !missing.some((shell) => c.includes(shell + ' ')))) {
      writeFileSync(mark, '');
      spawnSync('bash', ['-c', command], { env: runEnv, cwd: project, encoding: 'utf8', timeout: 10_000, input: '' });
      assert.ok(executedDeploys(mark).length > 0, 'not executed: ' + command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
