// scripts/check-agent-config.mjs
//
// specs/security/ci-agent-config-scan.md REQ-1..3: scan the agent settings the repository
// ships (.claude/settings.json and mcp-configs/) for broad permissions, unpinned MCP
// servers and hooks that do not run a reviewed file under hooks/. A finding not named in
// the reviewed baseline fails the run.
//
// Usage: node scripts/check-agent-config.mjs [--root <dir>] [--baseline <file>]
// Exit 0: no new finding. Exit 1: new finding. Exit 2: unreadable or malformed input.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isMain } from './lib/is-main.mjs';

class InputError extends Error {}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new InputError(`cannot read JSON: ${file}`); }
};
const safe = text => String(text).replace(/[^\w@/.:*()^~=-]/g, '_').slice(0, 160);
const finding = (rule, file, detail, message) => ({ key: `${rule}:${file}:${safe(detail)}`, message });

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);

function permissionFindings(settings, file) {
  const found = [];
  if (settings.permissions === undefined) return found;
  if (!plainObject(settings.permissions)) throw new InputError(`${file}: permissions must be an object`);
  const { allow = [], defaultMode } = settings.permissions;
  if (!Array.isArray(allow) || allow.some(rule => typeof rule !== 'string')) throw new InputError(`${file}: permissions.allow must be a list of strings`);
  for (const rule of allow) {
    const broad = rule.trim() === '*' || (!rule.includes('(') && !/^mcp__[^_]+__/.test(rule.trim())) || /\(\s*\*{1,2}\s*\)$/.test(rule.trim());
    if (broad) found.push(finding('broad-permission', file, rule, `allow rule ${JSON.stringify(rule)} covers every use of the tool`));
  }
  if (defaultMode === 'bypassPermissions') found.push(finding('broad-permission', file, 'defaultMode=bypassPermissions', 'defaultMode bypassPermissions skips every permission prompt'));
  return found;
}

function hookFindings(settings, file, root) {
  const found = [];
  if (settings.hooks === undefined) return found;
  if (!plainObject(settings.hooks)) throw new InputError(`${file}: hooks must be an object`);
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new InputError(`${file}: each hook event must be a list`);
    for (const group of groups) {
      if (!plainObject(group) || !Array.isArray(group.hooks)) throw new InputError(`${file}: malformed hook group`);
      for (const hook of group.hooks) {
        if (!plainObject(hook)) throw new InputError(`${file}: malformed hook`);
        if (hook.type !== 'command') continue;
        if (typeof hook.command !== 'string') throw new InputError(`${file}: hook command must be a string`);
        const command = hook.command;
        const scripts = [...command.matchAll(/(?<![\w.-])(hooks\/[\w./-]+\.(?:sh|mjs|js|ts))/g)].map(match => match[1]);
        const fetches = /\b(?:curl|wget)\b|\|\s*(?:ba)?sh\b/.test(command);
        const missing = scripts.filter(script => !existsSync(path.join(root, script)));
        if (scripts.length === 0 || missing.length > 0 || fetches) {
          const id = createHash('sha256').update(command).digest('hex').slice(0, 12);
          const why = scripts.length === 0 ? 'runs no file under hooks/' : missing.length > 0 ? `names missing ${missing.join(', ')}` : 'fetches or pipes into a shell';
          found.push(finding('unreviewed-hook', file, id, `${event} hook ${JSON.stringify(command.slice(0, 40))} ${why}`));
        }
      }
    }
  }
  return found;
}

function walkJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJson(full);
    return entry.name.endsWith('.json') ? [full] : [];
  }).sort();
}

function mcpFindings(root) {
  const found = [];
  for (const full of walkJson(path.join(root, 'mcp-configs'))) {
    const file = path.relative(root, full).split(path.sep).join('/');
    const doc = readJson(full);
    if (!plainObject(doc)) throw new InputError(`${file}: must be a JSON object`);
    const servers = plainObject(doc.mcpServers) ? Object.values(doc.mcpServers) : [doc];
    for (const server of servers) {
      if (!plainObject(server) || typeof server.command !== 'string') continue;
      if (!RUNNERS.has(path.basename(server.command))) continue;
      const args = Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : [];
      const spec = args.find(arg => !arg.startsWith('-'));
      const at = spec === undefined ? -1 : spec.lastIndexOf('@');
      if (spec === undefined || at < 1 || !VERSION.test(spec.slice(at + 1))) {
        found.push(finding('unpinned-mcp', file, spec ?? '(none)', `MCP package ${JSON.stringify(spec ?? '')} is not pinned to an exact version`));
      }
    }
  }
  return found;
}

export function scan(root) {
  const found = [];
  const settingsFile = path.join(root, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    const settings = readJson(settingsFile);
    if (!plainObject(settings)) throw new InputError('.claude/settings.json must be a JSON object');
    found.push(...permissionFindings(settings, '.claude/settings.json'), ...hookFindings(settings, '.claude/settings.json', root));
  }
  found.push(...mcpFindings(root));
  return found;
}

export function loadBaseline(file) {
  const doc = readJson(file);
  if (!plainObject(doc) || doc.schema_version !== 1 || !Array.isArray(doc.reviewed) || doc.reviewed.some(key => typeof key !== 'string')) {
    throw new InputError(`${file}: expected {"schema_version":1,"reviewed":[...strings]}`);
  }
  return new Set(doc.reviewed);
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const option = name => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
    const root = path.resolve(option('--root') ?? process.cwd());
    const baselineFile = option('--baseline') ?? path.join(root, 'governance', 'agent-config-baseline.json');
    const reviewed = loadBaseline(baselineFile);
    const fresh = scan(root).filter(item => !reviewed.has(item.key));
    for (const item of fresh) process.stdout.write(`FINDING ${item.key} ${item.message}\n`);
    process.stdout.write(`${fresh.length} new finding(s)\n`);
    process.exitCode = fresh.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    process.stderr.write(`agent-config scan: ${error.message}\n`);
    process.exitCode = 2;
  }
}
