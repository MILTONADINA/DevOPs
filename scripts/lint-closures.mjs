// specs/graph/closure-references.md — finite citation integrity, never closure truth.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openValidatedPublication } from '../verification/committed-claims.ts';
import { readInputBytes, decodeInput } from '../verification/claim-input.ts';
import { compute } from '../verification/reproducibility-check.ts';

const CAP = 262144, LINE_CAP = 16384, ITEM_CAP = 1024;
const SHIP = 'SHIP_BLOCKERS.md', BACKLOG = '.workflow/state/polish-backlog.md';
const CLOSED = /(^|[^A-Za-z0-9_])CLOSED(?=$|[^A-Za-z0-9_])/;
const EVIDENCE = /^(?:commit:[0-9a-f]{40}|pr:[1-9][0-9]{0,9}); claim:(claim-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3})$/;

class ClosureFailure extends Error {}
function refuse(category) { throw new ClosureFailure(category); }
function within(category, operation) {
  try { return operation(); } catch { refuse(category); }
}

function localBacklog(root) {
  // This local-only nlink policy does not change legacy claim/schema readers.
  let cursor = root;
  const parents = [];
  for (const part of BACKLOG.split('/')) {
    cursor = path.join(cursor, part);
    const entry = fs.lstatSync(cursor, { bigint: true });
    if (entry.isSymbolicLink() || (cursor !== path.join(root, BACKLOG) && !entry.isDirectory())) refuse('input');
    if (cursor !== path.join(root, BACKLOG)) parents.push({ path: cursor, stat: entry });
  }
  const before = fs.lstatSync(cursor, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) refuse('input');
  const bytes = readInputBytes(BACKLOG, root, 'member', CAP);
  const after = fs.lstatSync(cursor, { bigint: true });
  if (!after.isFile() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse('input');
  for (const parent of parents) {
    const current = fs.lstatSync(parent.path, { bigint: true });
    if (!current.isDirectory() || current.dev !== parent.stat.dev || current.ino !== parent.stat.ino) refuse('input');
  }
  return bytes;
}

function visibleLines(bytes) {
  const text = within('input', () => decodeInput(bytes, 'member'));
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.some(line => [...line].length > LINE_CAP)) refuse('input');
  let fence = null, comment = false;
  const visible = lines.map(line => {
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
    const start = line.indexOf('<!--');
    if (start >= 0) {
      if (!/^[ \t]*$/.test(line.slice(0, start)) || line.indexOf('<!--', start + 4) >= 0) refuse('structure');
      const end = line.indexOf('-->', start + 4);
      if (end >= 0 && !/^[ \t]*$/.test(line.slice(end + 3))) refuse('structure');
      comment = end < 0;
      return null;
    }
    return line;
  });
  if (fence || comment) refuse('structure');
  return visible;
}

function cells(line) {
  if (line === null) return null;
  const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.includes('\\|')) return null;
  return trimmed.slice(1, -1).split('|').map(cell => cell.replace(/^[ \t]+|[ \t]+$/g, ''));
}

function closedItems(bytes, ids, remaining) {
  const lines = visibleLines(bytes), headings = [], stack = [], allowed = new Set(), items = [];
  const add = (evidence, owner, form) => {
    if (items.length >= remaining) refuse('input');
    const parsed = EVIDENCE.exec(evidence);
    if (!parsed) refuse('structure');
    if (!ids.has(parsed[1])) refuse('reference');
    items.push({ owner, form });
  };
  let owner = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(line);
    if (heading) {
      const level = heading[1].length;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      owner = { level, parent: stack.at(-1) ?? null, statuses: [], evidence: [], closed: false };
      headings.push(owner); stack.push(owner);
      continue;
    }
    const header = cells(line);
    if (header?.length === 3 && header.join('|') === 'Item|Status|Evidence') {
      let end = i + 1;
      while (end < lines.length && lines[end] !== null && /^[ \t]*\|/.test(lines[end])) end++;
      // Unrelated open tables are not subjected to a new formatting policy.
      if (lines.slice(i + 1, end).some(row => CLOSED.test(row))) {
        const delimiter = cells(lines[i + 1] ?? null);
        if (!delimiter || delimiter.length !== 3 || !delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) refuse('structure');
        for (let row = i + 2; row < end; row++) {
          const values = cells(lines[row]);
          if (!values || values.length !== 3) refuse('structure');
          const [item, status, evidence] = values;
          if (CLOSED.test(item) || CLOSED.test(evidence) || (status !== 'CLOSED' && CLOSED.test(status))) refuse('structure');
          if (status === 'CLOSED') {
            if (!item) refuse('structure');
            allowed.add(row); add(evidence, owner, 'table');
          }
        }
      }
      i = end - 1;
      continue;
    }
    if (owner && /^[ \t]*\*\*Status:\*\*/.test(line)) owner.statuses.push({ line, index: i });
    if (owner && /^[ \t]*\*\*Closure evidence:\*\*/.test(line)) owner.evidence.push(line);
  }
  for (const heading of headings) {
    if (!heading.statuses.some(status => status.line === '**Status:** CLOSED')) continue;
    if (![2, 3].includes(heading.level) || heading.statuses.length !== 1 || heading.evidence.length !== 1) refuse('structure');
    const evidence = heading.evidence[0];
    if (!evidence.startsWith('**Closure evidence:** ')) refuse('structure');
    heading.closed = true;
    allowed.add(heading.statuses[0].index);
    add(evidence.slice('**Closure evidence:** '.length), heading, 'heading');
  }
  for (const item of items) {
    let ancestor = item.form === 'heading' ? item.owner.parent : item.owner;
    while (ancestor) {
      if (ancestor.closed) refuse('structure');
      ancestor = ancestor.parent;
    }
  }
  for (let i = 0; i < lines.length; i++) if (lines[i] !== null && CLOSED.test(lines[i]) && !allowed.has(i)) refuse('structure');
  return items.length;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 1 && args[0] === '--local-backlog')) refuse('usage');
  const root = within('publication', () => fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const publication = within('publication', () => openValidatedPublication(root,
    claim => compute(claim.proof.git_sha, claim.proof.test_command, claim.proof.environment ?? {})));
  const documents = [within('input', () => publication.readHeadBlob(SHIP, CAP))];
  const backlog = within('input', () => args.length ? localBacklog(root) : publication.readHeadBlob(BACKLOG, CAP, true));
  if (backlog !== null) documents.push(backlog);
  const ids = new Set(publication.claimIds);
  let count = 0;
  for (const bytes of documents) count += closedItems(bytes, ids, ITEM_CAP - count);
  process.stdout.write(`closures: references valid documents=${documents.length} closed=${count}\n`);
}

try { main(); }
catch (error) {
  const category = error instanceof ClosureFailure ? error.message : 'structure';
  process.stderr.write(`closures: ${category}\n`);
  process.exitCode = 1;
}
