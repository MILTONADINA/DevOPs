// specs/security/subagent-definitions.md: wording of the shipped definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = name => readFileSync(path.join(ROOT, 'subagents/universal', name), 'utf8');

test('reviewer definition carries the regression, privacy and cost checks (REQ-1, REQ-2, REQ-3)', () => {
  const text = read('reviewer.md');
  for (const needle of [
    /^9\. \*\*Regression across specs\*\*/m,
    /^10\. \*\*Privacy parity\*\*/m,
    /every new branch/,
    /branches, not files/,
    /project's trace primitive/,
    /no paid call whose output nothing consumes/,
    /file:line, the inputs and state/,
    /\*\*Not applicable\*\*/,
  ]) assert.match(text, needle);
  assert.doesNotMatch(text, /have OTel spans \(per/);
});

test('security definition carries offline, model, flag-injection and host-evidence sections (REQ-4, REQ-5, REQ-6)', () => {
  const text = read('security.md');
  for (const needle of [
    /^## Offline mode$/m,
    /--metrics=off/,
    /vendored or pinned local rules/,
    /network or home-directory side effect/,
    /^## Code that calls language models$/m,
    /re-checked at each use/,
    /model output persisted into future prompts/,
    /flag injection/,
    /^## Host project evidence$/m,
    /project owner, not this subagent/,
  ]) assert.match(text, needle);
});

test('both definitions keep their frontmatter and read-only permissions', () => {
  for (const name of ['reviewer.md', 'security.md']) {
    const text = read(name);
    assert.match(text, /^---\nname: (reviewer|security)\n/);
    assert.match(text, /forbidden_paths:\n {4}- src\/\*\*\n {4}- tests\/\*\*/);
  }
});
