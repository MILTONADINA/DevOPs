#!/usr/bin/env node
// specs/security/detector-source-lint.md: static literals and fingerprint grammar only.
import * as fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROLES = ['reviewer', 'security', 'validator'];
const SHARED = ['ENVIRONMENT_RULES', 'ownerDecisionsBlock'];
const PHRASES = ['already fixed', 'do not re-report', 'known issue'];
class Refusal extends Error {
  constructor(category, detail = '') { super(category); this.category = category; this.detail = detail; }
}
const refuse = (category, detail) => { throw new Refusal(category, detail); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function readInput(relative, cap) {
  let fd;
  try {
    const file = path.join(ROOT, relative);
    const parents = []; let cursor = ROOT;
    for (const part of ['', ...relative.split('/').slice(0, -1)]) {
      if (part) cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      parents.push([cursor, stat]);
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(cap)) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw new Error();
    const bytes = Buffer.alloc(cap + 1); let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used > cap || BigInt(used) !== before.size ||
        !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(file, { bigint: true })) || fs.realpathSync(file) !== file ||
        parents.some(([parent, stat]) => !same(stat, fs.lstatSync(parent, { bigint: true })))) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
  } catch { refuse('input'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function* nodes(start) {
  const stack = [start];
  while (stack.length) {
    const node = stack.pop(); yield node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value.filter(child => child && typeof child.type === 'string'));
      else if (value && typeof value.type === 'string') stack.push(value);
    }
  }
}

function selectPrompts(program) {
  const prompts = new Map(); const declarations = new Map(SHARED.map(name => [name, []]));
  for (const node of nodes(program)) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && declarations.has(node.id.name)) {
      declarations.get(node.id.name).push(node.init);
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'workflowAgent') continue;
    const [prompt, options] = node.arguments;
    if (options?.type !== 'ObjectExpression') continue;
    const labels = options.properties.filter(property => property.type === 'Property' &&
      (property.key.name ?? property.key.value) === 'label');
    const selected = labels.filter(property => ROLES.includes(property.value?.value));
    if (!selected.length) continue;
    if (labels.length !== 1 || options.properties.some(property => property.type !== 'Property' ||
        property.computed || property.method || property.kind !== 'init') || prompt?.type !== 'TemplateLiteral') refuse('structure');
    const role = selected[0].value.value;
    if (prompts.has(role) || SHARED.some(name => !prompt.expressions.some(expression =>
      expression.type === 'Identifier' && expression.name === name))) refuse('structure');
    prompts.set(role, prompt);
  }
  if (ROLES.some(role => !prompts.has(role))) refuse('structure');
  for (const [name, initializers] of declarations) {
    if (initializers.length !== 1 || !initializers[0]) refuse('structure');
    prompts.set(name, initializers[0]);
  }
  return prompts;
}

function checkLiterals(prompts) {
  for (const [label, source] of prompts) for (const node of nodes(source)) {
    let text;
    if (node.type === 'TemplateElement') {
      if (typeof node.value.cooked !== 'string') refuse('structure');
      text = node.value.cooked;
    } else if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    if (text === undefined) continue;
    const normalized = text.replace(/[A-Z]/g, letter => letter.toLowerCase()).replace(/[ \t\r\n\f\v]+/g, ' ');
    const phrase = PHRASES.findIndex(value => normalized.includes(value));
    if (phrase !== -1) refuse('phrase', `${label} phrase-${phrase + 1}`);
  }
}

function countFingerprints(text) {
  const lines = text.split('\n'); let count = 0;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (index < lines.length - 1 && line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '' || line.trimStart().startsWith('#')) continue;
    const fields = line.split(':'); const [sha, file, rule, position] = fields;
    if (line.trim() !== line || fields.length !== 4 || !/^[0-9a-f]{40}$/.test(sha) || !file ||
        /[\\\x00-\x1f\x7f*?\[\]]/.test(file) || file.split('/').some(part => part === '' || part === '.' || part === '..') ||
        !/^[A-Za-z0-9_-]+$/.test(rule) || !/^[1-9][0-9]*$/.test(position) || !Number.isSafeInteger(Number(position))) {
      refuse('fingerprint', `line-${index + 1}`);
    }
    count++;
  }
  return count;
}

try {
  if (process.argv.length !== 2) refuse('usage');
  const workflow = readInput('.claude/workflows/sprint-cycle.js', 262144);
  const ignore = readInput('.gitleaksignore', 65536);
  const { parse } = await import('acorn');
  let program;
  try { program = parse(workflow, { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true }); }
  catch { refuse('parse'); }
  checkLiterals(selectPrompts(program));
  const count = countFingerprints(ignore);
  console.log(`detector-lint: 3 templates, ${count} fingerprints`);
} catch (error) {
  console.error(error instanceof Refusal ? `detector-lint: ${error.category}${error.detail ? ' ' + error.detail : ''}` : 'detector-lint: internal');
  process.exitCode = 1;
}
