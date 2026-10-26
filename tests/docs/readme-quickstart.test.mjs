// README Quick start stays tied to the package (specs/release/npm-package.md AC-15).
// Reads the fenced shell commands under "## Quick start" and checks that each npx, npm
// and node command names something that exists in package.json (name, bin, scripts) or
// the CLI's own `help` text. Nothing here calls npm, npx or git, installs, or uses the
// network (tests/hermeticity.test.mjs); the CLI is only asked for `help`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// npm built-ins the Quick start may use; anything else must be a package.json script.
const NPM_BUILTINS = new Set(['install', 'ci']);

export function quickStartCommands(text) {
  const start = text.search(/^## Quick start\s*$/m);
  assert.ok(start >= 0, 'README has no "## Quick start" heading');
  const rest = text.slice(start).replace(/^## Quick start\s*$/m, '');
  const next = rest.search(/^## /m);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const commands = [];
  for (const block of section.matchAll(/^```(?:bash|sh|shell)\s*\n([\s\S]*?)^```/gm)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      for (const part of line.split('&&')) commands.push(part.trim());
    }
  }
  return commands;
}

function cliHelp() {
  const r = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: { ...process.env, DEVOPS_ROOT: ROOT } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// The CLI half: `devops <sub> [flags]` must be a listed command and every flag a documented one.
function checkCliArgs(args, help, cmd) {
  const problems = [];
  const [sub, ...flags] = args;
  if (!sub) return problems;
  if (!new RegExp(`^\\s+devops ${sub}\\b`, 'm').test(help)) problems.push(`${cmd}: unknown devops subcommand "${sub}"`);
  for (const f of flags.filter((a) => a.startsWith('--'))) {
    const name = f.split('=')[0];
    if (!help.includes(name)) problems.push(`${cmd}: flag ${name} is not in \`devops help\``);
  }
  return problems;
}

export function checkCommand(cmd, help) {
  const words = cmd.split(/\s+/);
  const [tool, ...rest] = words;
  if (tool === 'npx') {
    const args = rest.filter((a) => a !== '--yes' && a !== '-y');
    const [name, ...tail] = args;
    const bin = Object.keys(pkg.bin ?? {});
    if (name !== pkg.name && !bin.includes(name)) return [`${cmd}: ${name} is neither the package name nor a bin`];
    return name === pkg.name || name === 'devops' ? checkCliArgs(tail, help, cmd) : [];
  }
  if (tool === 'npm') {
    const [sub, ...args] = rest;
    if (sub === 'run') return pkg.scripts?.[args[0]] ? [] : [`${cmd}: no package.json script "${args[0]}"`];
    if (pkg.scripts?.[sub] && ['test', 'start'].includes(sub)) return [];
    if (!NPM_BUILTINS.has(sub)) return [`${cmd}: npm ${sub} is not a known npm command or package.json script`];
    // A named package must be this one or one package.json declares (peer and optional included).
    const known = new Set([pkg.name, ...['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}))]);
    const named = args.filter((a) => a.startsWith('@')).map((a) => a.replace(/(?<=.)@[^@/]*$/, ''));
    return named.filter((a) => !known.has(a)).map((a) => `${cmd}: ${a} is not this package or a declared dependency`);
  }
  if (tool === 'node') {
    const [script, ...args] = rest;
    if (!script) return [`${cmd}: no script`];
    // A clone path such as /path/to/DevOPs/scripts/x.js maps onto this repository.
    const rel = script.replace(/^.*\/DevOPs\//, '');
    if (!existsSync(path.join(ROOT, rel))) return [`${cmd}: ${rel} does not exist`];
    return path.join(ROOT, rel) === CLI ? checkCliArgs(args, help, cmd) : [];
  }
  if (tool === 'devops') return checkCliArgs(rest, help, cmd);
  return [];
}

const help = cliHelp();
const JS_TOOLS = new Set(['npx', 'npm', 'node', 'devops']);

test('README Quick start commands exist in package.json and the CLI', () => {
  const commands = quickStartCommands(readme).filter((c) => JS_TOOLS.has(c.split(/\s+/)[0]));
  assert.ok(commands.length >= 5, `expected the Quick start to hold several commands, got ${commands.length}`);
  assert.ok(commands.some((c) => c.startsWith('devops init --dry-run')), 'Quick start lost its init --dry-run line');
  const problems = commands.flatMap((c) => checkCommand(c, help));
  assert.deepEqual(problems, []);
});

test('the CLI answers the documented help and version commands without a network', () => {
  for (const sub of ['help', 'version']) {
    const r = spawnSync(process.execPath, [CLI, sub], { encoding: 'utf8', env: { ...process.env, DEVOPS_ROOT: ROOT } });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('a doctored Quick start with an unknown command or flag is reported', () => {
  const doctored = [
    '## Quick start', '', '```bash',
    'npm install -g @miltonadina/devops',
    'devops analyze',
    'devops frobnicate',
    'devops init --dry-runn',
    'node scripts/no-such-script.js analyze',
    'npm run no-such-script',
    'npx @someone-else/devops init',
    '```', '', '## Next', '', '```bash', 'devops ignored-outside-section', '```', '',
  ].join('\n');
  const commands = quickStartCommands(doctored);
  assert.equal(commands.length, 7);
  const problems = commands.flatMap((c) => checkCommand(c, help));
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join('\n'), /unknown devops subcommand "frobnicate"/);
  assert.match(problems.join('\n'), /flag --dry-runn/);
  assert.match(problems.join('\n'), /no-such-script\.js does not exist/);
  assert.match(problems.join('\n'), /no package\.json script "no-such-script"/);
  assert.match(problems.join('\n'), /@someone-else\/devops/);
});

test('a README without a Quick start heading is refused', () => {
  assert.throws(() => quickStartCommands('# Title\n\n```bash\ndevops init\n```\n'), /no "## Quick start" heading/);
});
