// CLAUDE.md's "### Hooks" section names exactly the hook scripts that
// .claude/settings.json wires, and its list of scripts that "are not wired"
// names none of them (#357).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = /hooks\/universal\/[a-z-]+\/[a-z0-9-]+\.sh/g;
const NOT_WIRED = 'scripts are not wired here and do not run:';

export function hookLists(claudeMd) {
  const start = claudeMd.indexOf('### Hooks\n');
  const split = claudeMd.indexOf(NOT_WIRED, start);
  assert.ok(start !== -1 && split !== -1, 'CLAUDE.md has a Hooks section with a not-wired list');
  // The list runs to the first semicolon; the prose after it names wired hooks.
  const end = claudeMd.indexOf(';', split);
  return {
    wired: new Set(claudeMd.slice(start, split).match(SCRIPT)),
    notWired: new Set(claudeMd.slice(split, end).match(/[a-z0-9-]+\.sh/g)),
  };
}

export function settingsScripts(settingsJson) {
  const commands = [];
  for (const groups of Object.values(JSON.parse(settingsJson).hooks ?? {}))
    for (const group of groups) for (const hook of group.hooks ?? []) commands.push(hook.command ?? '');
  return new Set(commands.join('\n').match(SCRIPT));
}

test('a script missing from the wired list, or listed as not wired, is caught', () => {
  const md = '### Hooks\n\n- PreToolUse on `Bash` → `hooks/universal/pre-tool/a.sh`\n\nThese `hooks/universal/` scripts are not wired here and do not run:\n`b.sh`; `deploy-gate.sh` is prose.\n\nnext';
  const { wired, notWired } = hookLists(md);
  assert.deepEqual([...wired], ['hooks/universal/pre-tool/a.sh']);
  assert.deepEqual([...notWired], ['b.sh']);
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'bash hooks/universal/pre-tool/b.sh' }] }] } });
  assert.deepEqual([...settingsScripts(settings)], ['hooks/universal/pre-tool/b.sh']);
});

test('CLAUDE.md names exactly the hooks .claude/settings.json wires', () => {
  const { wired, notWired } = hookLists(readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'));
  const settings = settingsScripts(readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  assert.deepEqual([...wired].sort(), [...settings].sort());
  const contradicted = [...settings].map(s => path.basename(s)).filter(name => notWired.has(name));
  assert.deepEqual(contradicted, [], 'a wired hook is listed as not wired');
});
