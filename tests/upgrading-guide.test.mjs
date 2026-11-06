// docs/UPGRADING.md keeps step with CHANGELOG.md (#354): every released version
// since 0.4.0 has an "Upgrading from <previous> to <version>" section, and no
// item under "Unreleased (dev)" describes a change a released version already
// shipped. An item counts as released when its code terms (backticked spans)
// appear under a released CHANGELOG version and none appear under [Unreleased].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = file => readFileSync(path.join(ROOT, file), 'utf8');

/** CHANGELOG sections by version ("Unreleased" or "x.y.z"), newest first. */
export function changelogSections(text) {
  const sections = [];
  for (const part of text.split(/^## \[/m).slice(1)) {
    const version = part.slice(0, part.indexOf(']'));
    sections.push({ version, body: part });
  }
  return sections;
}

const spans = text => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
const older = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** Released versions after `since` that the guide has no upgrade section for. */
export function missingSections(changelog, guide, since = '0.4.0') {
  const released = changelogSections(changelog).map(s => s.version).filter(v => /^\d+\.\d+\.\d+$/.test(v)).reverse();
  const missing = [];
  for (let i = 1; i < released.length; i++) {
    if (!older(since, released[i])) continue;
    if (!guide.includes(`## Upgrading from ${released[i - 1]} to ${released[i]}\n`)) missing.push(released[i]);
  }
  return missing;
}

/** Headings of "Unreleased (dev)" items that a released version already shipped, or that name no code term. */
export function releasedUnreleasedItems(changelog, guide) {
  const start = guide.indexOf('## Unreleased (dev)\n');
  if (start === -1) return [];
  const next = guide.indexOf('\n## ', start + 1);
  const section = guide.slice(start, next === -1 ? undefined : next);
  const sections = changelogSections(changelog);
  const unreleased = sections.filter(s => s.version === 'Unreleased').map(s => s.body).join('\n');
  const released = sections.filter(s => s.version !== 'Unreleased').map(s => s.body).join('\n');
  const bad = [];
  for (const item of section.split(/^### /m).slice(1)) {
    const heading = item.slice(0, item.indexOf('\n'));
    const terms = spans(item);
    if (terms.length === 0) { bad.push(`${heading} (names no code term)`); continue; }
    if (!terms.some(t => unreleased.includes(t)) && terms.some(t => released.includes(t))) bad.push(heading);
  }
  return bad;
}

const CHANGELOG = '## [Unreleased]\n\n- `new-flag` added.\n\n## [0.5.1] — x\n\n- `old-flag` added.\n\n## [0.5.0] — x\n\n## [0.4.0] — x\n';

test('an Unreleased guide item that only a released version mentions is reported', () => {
  const guide = '## Unreleased (dev)\n\n### Old\n\nUses `old-flag`.\n\n### New\n\nUses `new-flag`.\n';
  assert.deepEqual(releasedUnreleasedItems(CHANGELOG, guide), ['Old']);
});

test('an Unreleased guide item with no code term is reported', () => {
  assert.deepEqual(releasedUnreleasedItems(CHANGELOG, '## Unreleased (dev)\n\n### Vague\n\nThings changed.\n'), ['Vague (names no code term)']);
});

test('a released version with no upgrade section is reported', () => {
  const guide = '## Upgrading from 0.4.0 to 0.5.0\n';
  assert.deepEqual(missingSections(CHANGELOG, guide), ['0.5.1']);
  assert.deepEqual(missingSections(CHANGELOG, guide + '## Upgrading from 0.5.0 to 0.5.1\n'), []);
});

test('docs/UPGRADING.md has a section for every release since 0.4.0', () => {
  assert.deepEqual(missingSections(read('CHANGELOG.md'), read('docs/UPGRADING.md')), []);
});

test('no docs/UPGRADING.md Unreleased item describes a released change', () => {
  assert.deepEqual(releasedUnreleasedItems(read('CHANGELOG.md'), read('docs/UPGRADING.md')), []);
});
