// specs/phase-2/E-sigstore-signing.md AC-E5.1: the committed Sigstore trust root is the trustedroot
// document that `cosign initialize` writes, and the docs refresh it only through TUF verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BUNDLE = path.join(ROOT, '.workflow', 'sigstore', 'trust-bundle.json');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

test('AC-E5.1: the trust bundle is a Sigstore trustedroot document', () => {
  const root = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  assert.equal(root.mediaType, 'application/vnd.dev.sigstore.trustedroot+json;version=0.1');
  assert.ok(root.certificateAuthorities.length >= 1, 'at least one Fulcio certificate authority');
  assert.ok(root.tlogs.length >= 1, 'at least one Rekor transparency log');
  for (const ca of root.certificateAuthorities) {
    assert.ok(ca.certChain.certificates.length >= 1, 'a certificate chain per authority');
    assert.ok(ca.validFor.start, 'a validity start per authority');
  }
});

// A minimal reading of .gitignore rules (no git subprocess: tests/hermeticity.test.mjs). Last match
// wins, `!` re-includes, and a file under an ignored directory stays ignored, as git does.
function gitignoreRule(line) {
  const negate = line.startsWith('!');
  let pat = negate ? line.slice(1) : line;
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  const body = pat.split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/).map((part) => ({
    '**/': '(?:.*/)?', '/**': '(?:/.*)?', '**': '.*', '*': '[^/]*', '?': '[^/]',
  }[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return { negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) };
}
function ignoredBy(rules, file) {
  const parts = file.split('/');
  const verdict = (target, isDir) => rules.reduce((ignored, rule) =>
    (!rule.dirOnly || isDir) && rule.re.test(target) ? !rule.negate : ignored, false);
  for (let i = 1; i < parts.length; i++) if (verdict(parts.slice(0, i).join('/'), true)) return true;
  return verdict(file, false);
}
const rulesOf = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(gitignoreRule);
const TRUST_BUNDLE = '.workflow/sigstore/trust-bundle.json';

test('AC-E5.1: the matcher sees the ignore rules that would hide the trust bundle', () => {
  for (const line of ['.workflow/', '.workflow/sigstore/', '.workflow/*', '*.json', 'trust-bundle.json', '/.workflow/**'])
    assert.equal(ignoredBy(rulesOf(line), TRUST_BUNDLE), true, line);
  assert.equal(ignoredBy(rulesOf('.workflow/sigstore/*\n!.workflow/sigstore/trust-bundle.json'), TRUST_BUNDLE), false);
  assert.equal(ignoredBy(rulesOf('.workflow/\n!.workflow/sigstore/trust-bundle.json'), TRUST_BUNDLE), true, 'a file under an ignored directory cannot be re-included');
});

test('AC-E5.1: no .gitignore rule hides the committed trust bundle', () => {
  const rules = rulesOf(read('.gitignore'));
  assert.equal(ignoredBy(rules, '.workflow/state/run.json'), true, 'control: the matcher reads the real file');
  assert.equal(ignoredBy(rules, TRUST_BUNDLE), false);
});

test('AC-E5.1: the signing docs refresh the root only through cosign initialize', () => {
  const docs = read('docs/SKILL_SIGNING.md');
  const joined = docs.replace(/\\\n/g, ' ');
  assert.doesNotMatch(joined, /\b(curl|wget|Invoke-WebRequest)\b[^`]{0,300}trusted_root\.json/, 'no download recipe for the trust root');
  assert.doesNotMatch(docs, /--bundle-path/, 'cosign has no --bundle-path flag');
  assert.match(docs, /cosign initialize/);
  assert.match(docs, /--trusted-root/);
});
