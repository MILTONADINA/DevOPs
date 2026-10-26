#!/usr/bin/env node
// REQ-M30: block agent-run installs of packages the project has not declared.
// A finite literal-command classifier, never a shell interpreter, and no network
// access: it reads only the manifests in the current project directory.
// usage: new-dependency-classifier.mjs "<command>"  -> exit 2 + message on block
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 1024 * 1024;
const MAX_DEPTH = 3;

// Split a command line into segments of words. Separators and quotes are honoured;
// nothing is expanded or executed.
export function segments(text) {
  const out = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endSegment = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (c === '\\' && i + 1 < text.length) { word = (word ?? '') + text[++i]; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '`') { endSegment(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    word = (word ?? '') + c;
  }
  endSegment();
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'doas']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// Flags that take a separate value, per tool family. `--flag=value` is self-contained.
const VALUE_FLAGS = {
  node: ['--prefix', '-C', '--workspace', '-w', '--registry', '--tag', '--cache', '--userconfig', '--loglevel',
    '--omit', '--include', '--install-strategy', '--otp', '--scope', '--filter', '-F', '--dir', '--cwd', '--config',
    '-c', '--cache-dir', '--modules-folder', '--store-dir'],
  pip: ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url',
    '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--python', '--python-version', '--platform',
    '--implementation', '--abi', '--only-binary', '--no-binary', '--src', '--cache-dir', '--log', '--proxy',
    '--retries', '--timeout', '--trusted-host', '--report', '--upgrade-strategy', '-C', '--config-settings',
    '--global-option', '--install-option', '--progress-bar', '--use-feature', '--root-user-action',
    '--exists-action', '-b', '--build', '--index', '--default-index', '--group', '--optional', '--extra', '-p',
    '--project', '--directory', '--rev', '--tag', '--branch', '--source', '--platform', '--extras', '-E', '-G',
    '--index-strategy', '--resolution', '--prerelease', '--config-file'],
  cargo: ['--features', '-F', '--git', '--path', '--rename', '-p', '--package', '--manifest-path', '--registry',
    '--branch', '--tag', '--rev', '--target', '--config', '-Z'],
};

function operands(args, family, skipEditable) {
  const valued = new Set(VALUE_FLAGS[family]);
  if (skipEditable) valued.delete('-e');
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) { if (!a.includes('=') && valued.has(a)) i++; continue; }
    if (a.startsWith('>') || /^\d>/.test(a)) continue;
    out.push(a);
  }
  return out;
}

const isLocalPath = (s) => /^(\.{1,2}(\/|$)|\/|~\/)/.test(s) || /^file:/.test(s);
const isRemote = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^npm:/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s) && !s.startsWith('@');

function readText(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_TEXT) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

// ---- npm family ----
function npmName(operand) {
  let spec = operand;
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash < 0) return spec;
    const at = spec.indexOf('@', slash);
    const name = at < 0 ? spec : spec.slice(0, at);
    const rest = at < 0 ? '' : spec.slice(at + 1);
    return rest.startsWith('npm:') ? npmName(rest.slice(4)) : name;
  }
  const at = spec.indexOf('@');
  if (at <= 0) return spec;
  const rest = spec.slice(at + 1);
  return rest.startsWith('npm:') ? npmName(rest.slice(4)) : spec.slice(0, at);
}
function declaredNpm(dir) {
  const names = new Set();
  const text = readText(path.join(dir, 'package.json'));
  if (text === null) return names;
  let json;
  try { json = JSON.parse(text); } catch { return names; }
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const table = json && typeof json === 'object' ? json[key] : null;
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [name, spec] of Object.entries(table)) {
      names.add(name);
      if (typeof spec === 'string' && spec.startsWith('npm:')) names.add(npmName(spec.slice(4)));
    }
  }
  return names;
}

// ---- python family ----
const pyNorm = (s) => s.toLowerCase().replace(/[-_.]+/g, '-');
function pyName(operand) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(operand);
  return m ? m[1] : operand;
}
function declaredPython(dir) {
  const names = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* none */ }
  for (const f of entries) {
    if (!/^requirements.*\.(txt|in)$/.test(f)) continue;
    const text = readText(path.join(dir, f));
    if (text === null) continue;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s#.*$/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      names.add(pyNorm(pyName(line)));
    }
  }
  const toml = readText(path.join(dir, 'pyproject.toml'));
  if (toml !== null) {
    let section = '';
    let inArray = false;
    for (const raw of toml.split('\n')) {
      const line = raw.trim();
      const head = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line);
      if (head && !inArray) { section = head[1]; continue; }
      const poetry = /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(section);
      if (poetry) {
        const key = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
        if (key && key[1].toLowerCase() !== 'python') names.add(pyNorm(key[1]));
        continue;
      }
      if (section === 'project' || section === 'project.optional-dependencies' || section === 'dependency-groups') {
        if (!inArray && /^[\w.-]+\s*=\s*\[/.test(line)) inArray = true;
        if (inArray) {
          for (const m of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
            const v = m[1] ?? m[2];
            if (/^[A-Za-z0-9][A-Za-z0-9._-]*(\s*[[<>=!~;@(]|\s*$)/.test(v)) names.add(pyNorm(pyName(v)));
          }
          if (line.replace(/"[^"]*"|'[^']*'/g, '').replace(/^[^=]*=\s*\[/, '').includes(']')) inArray = false;
        }
      }
    }
  }
  return names;
}

// ---- cargo ----
function declaredCargo(dir) {
  const names = new Set();
  const toml = readText(path.join(dir, 'Cargo.toml'));
  if (toml === null) return names;
  let inDeps = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) {
      const h = head[1];
      const sub = /(^|\.)(dev-|build-)?dependencies\.(.+)$/.exec(h);
      if (sub) { names.add(sub[3].replace(/^["']|["']$/g, '')); inDeps = false; continue; }
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(h);
      continue;
    }
    if (!inDeps) continue;
    const key = /^["']?([A-Za-z0-9_-]+)["']?\s*[=.]/.exec(line);
    if (key) names.add(key[1]);
    const pkg = /package\s*=\s*"([^"]+)"/.exec(line);
    if (pkg) names.add(pkg[1]);
  }
  return names;
}
const cargoName = (operand) => operand.replace(/@.*$/, '');

// Return the list of undeclared operands for one command segment (may be empty).
function checkSegment(words, dir, depth) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(path.basename(words[i])))) i++;
  words = words.slice(i);
  if (!words.length) return [];
  const head = path.basename(words[0]);
  const rest = words.slice(1);
  if (SHELLS.has(head)) {
    const c = rest.indexOf('-c');
    if (c >= 0 && rest[c + 1] !== undefined && depth < MAX_DEPTH) return classify(rest[c + 1], dir, depth + 1);
    return [];
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(head)) {
    const sub = rest.find((a) => !a.startsWith('-'));
    const adds = head === 'npm' ? ['install', 'i', 'add', 'install-test', 'it', 'isntall']
      : head === 'yarn' ? ['add'] : ['add', 'install', 'i'];
    if (!adds.includes(sub)) return [];
    const ops = operands(rest.slice(rest.indexOf(sub) + 1), 'node');
    const declared = ops.length ? declaredNpm(dir) : null;
    return ops.filter((o) => !isLocalPath(o) && (isRemote(o) || !declared.has(npmName(o))))
      .map((o) => ({ name: isRemote(o) ? o : npmName(o), manifest: 'package.json' }));
  }
  let pipArgs = null;
  if (/^pip[\d.]*$/.test(head) && rest.find((a) => !a.startsWith('-')) === 'install') pipArgs = rest;
  else if (/^python[\d.]*$/.test(head) && rest[0] === '-m' && /^pip[\d.]*$/.test(rest[1] ?? '') && rest[2] === 'install') pipArgs = rest.slice(2);
  else if (head === 'uv' && rest[0] === 'pip' && rest[1] === 'install') pipArgs = rest.slice(1);
  else if ((head === 'uv' || head === 'poetry') && rest[0] === 'add') pipArgs = rest;
  if (pipArgs) {
    const skipEditable = head === 'uv' && rest[0] === 'add' || head === 'poetry';
    const ops = operands(pipArgs.slice(1), 'pip', skipEditable);
    const declared = ops.length ? declaredPython(dir) : null;
    return ops.filter((o) => !isLocalPath(o) && o !== '.' && !/\.(whl|tar\.gz|zip)$/.test(o)
      && (isRemote(o) || !declared.has(pyNorm(pyName(o)))))
      .map((o) => ({ name: isRemote(o) ? o : pyName(o), manifest: 'requirements*.txt or pyproject.toml' }));
  }
  if (head === 'cargo' && rest[0] === 'add') {
    const ops = operands(rest.slice(1), 'cargo');
    const declared = ops.length ? declaredCargo(dir) : null;
    return ops.filter((o) => !declared.has(cargoName(o))).map((o) => ({ name: cargoName(o), manifest: 'Cargo.toml' }));
  }
  return [];
}

export function classify(command, dir = process.cwd(), depth = 0) {
  const found = [];
  for (const words of segments(String(command))) found.push(...checkSegment(words, dir, depth));
  return found;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('new-dependency-classifier.mjs')) {
  const found = classify(process.argv[2] ?? '', fs.realpathSync(process.cwd()));
  if (found.length) {
    const first = found[0];
    process.stderr.write(
      `DevOPs NEW-DEPENDENCY BLOCK: '${first.name}' is not declared in ${first.manifest} for this project.\n` +
      `Installing a package the project does not already declare needs owner approval: ask the owner,\n` +
      `and have them add it to the manifest (or run the install) themselves. Undeclared: ` +
      `${found.map((f) => f.name).join(', ')}\n`);
    process.exit(2);
  }
}
