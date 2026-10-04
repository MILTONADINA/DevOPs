// specs/verification/readiness-claims.md — declared-state association, not readiness.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openValidatedPublication } from '../verification/committed-claims.ts';
import { decodeInput } from '../verification/claim-input.ts';
import { compute } from '../verification/reproducibility-check.ts';

const CAP = 262144, LINE_CAP = 32768;
const ROADMAP = '## Masterpiece roadmap to v1.0.0 (Session 14 binding)';
const HEADER = ['Version', 'Theme', 'Status', 'Hours done', 'Hours remaining', 'Progress', 'Ship gate'];
const DELIMITER = ['---', '---', '---', '---:', '---:', '---:', '---'];
const STATES = 'implemented|verified|code_converged|release_ready|fixed_not_live|production_complete';
const ATOM = new RegExp('^(?:(' + STATES + ')|`(' + STATES + ')`); claim:(claim-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3})$');
const HISTORY_PREFIX = Buffer.from('**History: the rows as they stood before the 2026-09-26 redefinition.');
const NOTICE_BYTES = 351, TABLE_BYTES = 28491;
const NOTICE_HASH = 'd928bf9e652eafd8e7518b80697f2f01a2a494e1bf0a03769bc93c48c0b1239d';
const TABLE_HASH = '0714ab707a6e2c09cbb84483d4d571b467bfa98227b96a9ef6e3ddfa1fc0c8a9';
const trimH = text => text.replace(/^[ \t]+|[ \t]+$/g, '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

class ReadinessFailure extends Error {}
function refuse(category) { throw new ReadinessFailure(category); }
function within(category, operation) {
  try { return operation(); } catch { refuse(category); }
}

function physicalLines(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > CAP) refuse('input');
  const raw = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== 10) continue;
    const lf = i < bytes.length;
    const end = lf && i > start && bytes[i - 1] === 13 ? i - 1 : i;
    // Check original bytes, including any BOM, before TextDecoder processing.
    if (end - start > LINE_CAP) refuse('input');
    raw.push({ start, lf }); start = i + 1;
  }
  const text = within('input', () => decodeInput(bytes, 'member'));
  const lines = text.split('\n').map((line, i) => raw[i].lf && line.endsWith('\r') ? line.slice(0, -1) : line);
  return { raw, lines };
}

function visibleDocument(bytes, launch) {
  const { raw, lines } = physicalLines(bytes);
  const notices = raw.flatMap((line, i) =>
    bytes.subarray(line.start, line.start + HISTORY_PREFIX.length).equals(HISTORY_PREFIX) ? [i] : []);
  if (notices.length > 1 || (!launch && notices.length)) refuse('structure');
  let history = null;
  if (notices.length) {
    const first = notices[0], offset = raw[first].start;
    const end = offset + NOTICE_BYTES + TABLE_BYTES;
    if (end > bytes.length || hash(bytes.subarray(offset, offset + NOTICE_BYTES)) !== NOTICE_HASH ||
        hash(bytes.subarray(offset + NOTICE_BYTES, end)) !== TABLE_HASH) refuse('structure');
    const last = raw.findIndex(line => line.start === end);
    if (last < 0) refuse('structure');
    history = { first, last };
  }
  let fence = null, comment = false;
  const visible = lines.map((line, i) => {
    if (history && i >= history.first && i < history.last) {
      if (fence || comment) refuse('structure');
      return null;
    }
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return null;
    }
    if (comment) {
      if (line.includes('<!--')) refuse('structure');
      const end = line.indexOf('-->');
      if (end >= 0) {
        if (!/^[ \t]*$/.test(line.slice(end + 3))) refuse('structure');
        comment = false;
      }
      return null;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; return null; }
    const openingComment = line.indexOf('<!--');
    if (openingComment >= 0) {
      if (!/^[ \t]*$/.test(line.slice(0, openingComment)) || line.indexOf('<!--', openingComment + 4) >= 0) refuse('structure');
      const end = line.indexOf('-->', openingComment + 4);
      if (end >= 0 && !/^[ \t]*$/.test(line.slice(end + 3))) refuse('structure');
      comment = end < 0;
      return null;
    }
    return line;
  });
  if (fence || comment) refuse('structure');
  return { lines: visible, history };
}

function cells(line) {
  if (line === null || line === undefined) refuse('structure');
  const value = trimH(line);
  if (!value.startsWith('|') || !value.endsWith('|') || value.includes('\\|')) refuse('structure');
  const result = value.slice(1, -1).split('|').map(trimH);
  if (result.length !== 7) refuse('structure');
  return result;
}
function versionHeader(line) {
  const value = trimH(line);
  return value.startsWith('|') && trimH(value.slice(1).split('|')[0]) === 'Version';
}

function declarationsIn(text, declarations, labelled = true) {
  const value = trimH(text);
  const accept = atom => {
    const match = ATOM.exec(atom);
    if (!match || match[0].length !== atom.length) refuse('structure');
    const state = match[1] ?? match[2];
    if (!declarations.has(match[3]) || declarations.get(match[3]) !== state) refuse('reference');
  };
  const prefix = value.startsWith('State:') ? 'State:' : value.startsWith('**State:**') ? '**State:**' : null;
  if (labelled && prefix) {
    if (value[prefix.length] !== ' ') refuse('structure');
    accept(value.slice(prefix.length + 1)); return 1;
  }
  let count = 0;
  const code = [], ticks = [...value.matchAll(/`+/g)];
  for (let i = 0; i < ticks.length; i++) {
    const open = ticks[i];
    let j = i + 1;
    while (j < ticks.length && ticks[j][0].length !== open[0].length) j++;
    if (j === ticks.length) continue;
    const close = ticks[j], end = close.index + close[0].length;
    const contents = value.slice(open.index + open[0].length, close.index);
    // Consume unrelated spans too: their closing run cannot open a new span.
    if (STATES.split('|').includes(contents)) {
      if (open[0].length !== 1) refuse('structure');
      accept(value.slice(open.index)); count++;
      code.push({ start: open.index, end });
    }
    i = j;
  }
  const strong = /(^|[^A-Za-z0-9_])(code_converged|release_ready|fixed_not_live|production_complete)(?=$|[^A-Za-z0-9_])/g;
  for (const match of value.matchAll(strong)) {
    const start = match.index + match[1].length;
    if (code.some(span => start >= span.start && start < span.end)) continue;
    accept(value.slice(start)); count++;
  }
  return count;
}

function versionStatus(value, declarations) {
  if (ATOM.test(value)) return { declarations: declarationsIn('State: ' + value, declarations), process: 0 };
  for (const prefix of ['IN PROGRESS', 'NOT STARTED', 'DROPPED', 'EVIDENCE PENDING']) {
    for (const label of [prefix, '**' + prefix + '**']) {
      if (value === label || value.startsWith(label + ' ') ||
          (prefix === 'IN PROGRESS' && value.startsWith(label + ': '))) {
        return { declarations: declarationsIn(value, declarations, false), process: 1 };
      }
    }
  }
  refuse('structure');
}

function inspectDocument(bytes, launch, declarations) {
  const { lines, history } = visibleDocument(bytes, launch);
  const headings = lines.flatMap((line, i) => line === ROADMAP ? [i] : []);
  if (launch && headings.length !== 1) refuse('structure');
  const sectionStart = launch ? headings[0] : -1;
  let sectionEnd = lines.length;
  if (launch) {
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i] !== null && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(lines[i])) { sectionEnd = i; break; }
    }
  }
  let selected = 0, count = 0, process = 0, currentEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    if (versionHeader(line)) {
      if (launch && (i <= sectionStart || i >= sectionEnd || selected !== 0)) refuse('structure');
      if (cells(line).join('|') !== HEADER.join('|') || cells(lines[i + 1]).join('|') !== DELIMITER.join('|')) refuse('structure');
      let end = i + 2, versions = 0, totals = 0;
      while (end < lines.length && lines[end] !== null && /^[ \t]*\|/.test(lines[end])) {
        const row = cells(lines[end]);
        if (row[0] === '**TOTAL to v1.0.0**') {
          if (++totals > 1 || row[2] !== '—') refuse('structure');
        } else {
          const version = row[0].startsWith('**') && row[0].endsWith('**') ? row[0].slice(2, -2) : row[0];
          if (!/^v[0-9]+\.[0-9]+\.(?:[0-9]+|x)$/.test(version)) refuse('structure');
          versions++;
          const status = versionStatus(row[2], declarations); count += status.declarations; process += status.process;
        }
        for (let column = 0; column < row.length; column++) {
          if (column !== 2) count += declarationsIn(row[column], declarations, false);
        }
        end++;
      }
      if (versions === 0) refuse('structure');
      selected++; currentEnd = end; i = end - 1;
    } else if (/^[ \t]*\|/.test(line)) {
      // Other pipe tables retain their own shape; declarations still end at a cell.
      for (const cell of line.split('|')) count += declarationsIn(cell, declarations, false);
    } else count += declarationsIn(line, declarations);
  }
  if (launch && selected !== 1) refuse('structure');
  if (history && (history.first !== currentEnd + 1 || lines[currentEnd] !== '')) refuse('structure');
  return { declarations: count, process, history: history ? 1 : 0 };
}

function main() {
  if (process.argv.length !== 2) refuse('usage');
  const root = within('publication', () => fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const publication = within('publication', () => openValidatedPublication(root,
    claim => compute(claim.proof.git_sha, claim.proof.test_command, claim.proof.environment ?? {})));
  const declarations = new Map(publication.claimDeclarations.map(claim => [claim.id, claim.state]));
  const documents = ['docs/LAUNCH_READINESS.md', 'SHIP_BLOCKERS.md'].map(file =>
    within('input', () => publication.readHeadBlob(file, CAP)));
  const results = documents.map((bytes, i) => inspectDocument(bytes, i === 0, declarations));
  const count = results.reduce((sum, result) => sum + result.declarations, 0);
  const processRows = results.reduce((sum, result) => sum + result.process, 0);
  const history = results.reduce((sum, result) => sum + result.history, 0);
  process.stdout.write(`readiness: ${count ? 'references valid' : 'none selected'} documents=2 declarations=${count} process_rows=${processRows} history_tables=${history}\n`);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMain()) {
  try { main(); }
  catch (error) {
    process.stderr.write(`readiness: ${error instanceof ReadinessFailure ? error.message : 'structure'}\n`);
    process.exitCode = 1;
  }
}
