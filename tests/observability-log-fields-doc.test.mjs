// docs/OBSERVABILITY.md lists the proxy's structured log fields. Every field the
// "Proxy log fields" table names must appear as a quoted/object-key string in the
// runtime source file the row cites, so the table cannot drift from the code.
// Run with: node --test tests/observability-log-fields-doc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = path.join(ROOT, 'docs', 'OBSERVABILITY.md');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function section(text, heading) {
  const m = new RegExp(`^#{2,3} ${heading}\\s*$`, 'm').exec(text);
  assert.ok(m, `docs/OBSERVABILITY.md has no "${heading}" heading`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function fieldRows(doc) {
  const rows = [];
  for (const line of section(doc, 'Proxy log fields').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const field = cells[1]?.match(/^`([^`]+)`$/);
    const src = cells[cells.length - 2]?.match(/^`(runtime\/src\/[^`]+)`$/);
    if (field && src) rows.push({ field: field[1], src: src[1] });
  }
  return rows;
}

test('the doc exists and lists field rows', () => {
  assert.ok(existsSync(DOC));
  assert.ok(fieldRows(readFileSync(DOC, 'utf8')).length >= 10);
});

test('every listed field appears in the runtime source file it cites', () => {
  for (const { field, src } of fieldRows(readFileSync(DOC, 'utf8'))) {
    assert.ok(existsSync(path.join(ROOT, src)), `${src} does not exist`);
    const text = read(src);
    const re = new RegExp(`(["'\`]${field.replace(/\./g, '\\.')}["'\`])|([{,\\s]${field.replace(/\./g, '\\.')}\\??\\s*[:,}])`);
    assert.match(text, re, `${field} not found in ${src}`);
  }
});

test('the doc names the levels, LOG_LEVEL, and the redaction module and functions', () => {
  const doc = readFileSync(DOC, 'utf8');
  for (const level of ['info', 'warn', 'error']) assert.match(section(doc, 'Log levels'), new RegExp(`\`${level}\``));
  assert.match(read('runtime/src/lib/logger.ts'), /LOG_LEVEL/);
  assert.match(doc, /`LOG_LEVEL`/);
  const mod = doc.match(/`(observability\/pii-redaction\.ts)`/);
  assert.ok(mod, 'doc must name observability/pii-redaction.ts');
  assert.ok(existsSync(path.join(ROOT, mod[1])));
  const redactSrc = read(mod[1]);
  for (const fn of ['redactValue', 'redactString']) {
    assert.match(doc, new RegExp(`\`${fn}\``));
    assert.match(redactSrc, new RegExp(`export function ${fn}\\b`));
  }
});

test('README links the doc with a log-fields description', () => {
  assert.match(read('README.md'), /`docs\/OBSERVABILITY\.md`[^\n]*log/i);
});
