#!/usr/bin/env node
// Masterpiece REQ-M8 (quality plan MR-11(A)): every spec under specs/ declares one Status from
// a single vocabulary. governance/traceability-baseline.json lists the specs that failed when
// this check was introduced; that list may only shrink.
//
//   node scripts/lint-spec-status.mjs [--root <dir>]                         check every spec against the baseline
//   node scripts/lint-spec-status.mjs [--root <dir>] --ratchet <base.json>   refuse a baseline that grew against main's
//
// A spec's header is its text before the first `## ` heading, ignoring HTML comments and fenced
// code (CommonMark fences). It holds exactly one `**Status**: <word>` or `**Status:** <word>` line. <word> is one of
// VOCABULARY, optionally followed by one note in parentheses (no nested parentheses) and nothing else:
//   **Status**: approved (owner, 2026-09-26, spec batch 1)
// Every file under specs/ must be a regular `.md` file: another extension or a symbolic link fails.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const VOCABULARY = ['draft', 'approved', 'implemented', 'superseded'];
const STATUS_LINE = /^\*\*Status(?:\*\*:|:\*\*)[ \t]*(.*)$/;
const VALUE = new RegExp(`^(${VOCABULARY.join('|')})(?:\\s+\\([^()]*\\))?$`);
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const SECTION = /^ {0,3}##(?:[ \t]|$)/;

// A fence opener, as CommonMark reads it: a backtick fence's info string may not hold a backtick.
function openFence(line) {
  const m = line.match(OPEN_FENCE);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return m[1];
}

// Remove HTML comments from one line, carrying an open comment to the next line. `<!-->` and
// `<!--->` are complete comments. Code spans are not parsed, so a literal `<!--` inside
// backticks is read as a comment; that errs toward failing the lint, never toward passing it.
function stripComments(line, inComment) {
  let out = '';
  let rest = line;
  let open = inComment;
  while (rest) {
    if (open) {
      const end = rest.indexOf('-->');
      if (end === -1) return { line: out, open: true };
      rest = rest.slice(end + 3);
      open = false;
      continue;
    }
    const start = rest.indexOf('<!--');
    if (start === -1) return { line: out + rest, open: false };
    out += rest.slice(0, start);
    rest = rest.slice(start + 4);
    if (rest.startsWith('>')) rest = rest.slice(1);
    else if (rest.startsWith('->')) rest = rest.slice(2);
    else open = true;
  }
  return { line: out, open };
}

// The header lines that count: before the first `## ` heading, outside HTML comments and fenced code.
function headerLines(text) {
  const lines = [];
  let fence = null;
  let comment = false;
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = raw.match(CLOSE_FENCE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (!comment) {
      const opener = openFence(raw);
      if (opener) { fence = opener; continue; }
    }
    const stripped = stripComments(raw, comment);
    comment = stripped.open;
    if (SECTION.test(stripped.line)) break;
    lines.push(stripped.line);
  }
  return lines;
}

export function specStatus(text) {
  const found = headerLines(text).map((line) => line.match(STATUS_LINE)).filter(Boolean);
  if (!found.length) return { error: 'no **Status** line before the first ## heading' };
  if (found.length > 1) return { error: `${found.length} **Status** lines before the first ## heading; keep exactly one` };
  const value = found[0][1].trim();
  const word = value.match(VALUE);
  if (!word) return { error: `Status "${value}" is not in the vocabulary (${VOCABULARY.join(', ')}), optionally followed by one note in parentheses` };
  return { status: word[1] };
}

export function lintSpecs(root) {
  const results = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) results.set(key, { error: 'a symbolic link; specs/ holds only regular .md files' });
      else if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.set(key, specStatus(readFileSync(file, 'utf8')));
      else results.set(key, { error: 'not a .md file; specs/ holds only regular .md files' });
    }
  };
  walk(path.join(root, 'specs'));
  return results;
}

export function checkBaseline(results, baseline) {
  const allowed = new Set(baseline);
  const problems = [];
  for (const [file, result] of results) {
    if (result.error && !allowed.has(file)) problems.push(`${file}: ${result.error}`);
    if (!result.error && allowed.has(file)) problems.push(`${file} now passes; remove it from the baseline`);
  }
  for (const file of allowed) {
    if (!results.has(file)) problems.push(`${file} is not a spec any more; remove it from the baseline`);
  }
  return problems;
}

export function checkRatchet(base, current) {
  if (!Array.isArray(base.spec_status)) return null;
  if (!Array.isArray(current.spec_status)) return 'governance/traceability-baseline.json has no spec_status list';
  const before = new Set(base.spec_status);
  const added = current.spec_status.filter((file) => !before.has(file));
  return added.length ? `the spec-status baseline may only shrink; baseline grew: ${added.join(', ')}` : null;
}

export function main(argv) {
  const args = [...argv];
  let root = path.join(import.meta.dirname, '..');
  const rootAt = args.indexOf('--root');
  if (rootAt !== -1) root = path.resolve(args.splice(rootAt, 2)[1]);
  const baseline = JSON.parse(readFileSync(path.join(root, 'governance', 'traceability-baseline.json'), 'utf8'));
  if (args[0] === '--ratchet') {
    const problem = checkRatchet(JSON.parse(readFileSync(args[1], 'utf8')), baseline);
    if (problem) return { problems: [problem] };
    return { problems: [], summary: 'spec status: the baseline did not grow' };
  }
  const results = lintSpecs(root);
  const problems = checkBaseline(results, baseline.spec_status ?? []);
  const passing = [...results.values()].filter((r) => !r.error).length;
  return { problems, summary: `spec status: ${results.size} specs, ${passing} pass, ${results.size - passing} baselined` };
}

// The entry-point check the claim tooling uses (verification/reproducibility-check.ts): compare real
// paths, so a symlinked invocation runs, and treat an unresolvable argv[1] as "imported".
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const { problems, summary } = main(process.argv.slice(2));
  if (problems.length) {
    for (const problem of problems) console.error(`spec status: ${problem}`);
    process.exit(1);
  }
  console.log(summary);
}
