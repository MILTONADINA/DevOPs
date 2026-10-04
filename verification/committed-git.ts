// Finite, read-only Git boundary for committed claim metadata (MR10-B).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InputFailure, readInputBytes, decodeInput } from './claim-input.ts';

const SMALL = 65536;
const LISTING = 1048576;
const PUBLICATION = '.workflow/proofs/committed';
const OID = /^[a-f0-9]{40}$/;
const isOid = (value: string): boolean => typeof value === 'string' && value.length === 40 && OID.test(value);

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

function refuse(category: string): never { throw new InputFailure('git', category); }

function literalPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..');
}

function refName(value: string): boolean {
  return value.startsWith('refs/') && literalPath(value) &&
    !/[ ~^:?*\[]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    !value.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));
}

// This admits only a small ordinary config grammar; it is not a Git config parser.
function inspectConfig(text: string): void {
  if (text.includes('\0') || /\\\r?\n/.test(text)) refuse('unsupported config');
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[')) {
      const header = /^\[([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9_.:/-]+)?)(?:[ \t]+"([^"\\\x00-\x1f]*)")?\][ \t]*(?:[#;].*)?$/.exec(line);
      if (!header) refuse('unsupported config');
      section = header[1].split('.')[0].toLowerCase();
      if (['include', 'includeif', 'extensions'].includes(section)) refuse('unsupported config');
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)(?:[ \t]*=[ \t]*(.*))?$/.exec(line);
    if (!section || !entry) refuse('unsupported config');
    const key = entry[1].toLowerCase();
    if (section === 'core' && ['worktree', 'alternaterefscommand'].includes(key)) refuse('unsupported config');
    if (section === 'remote' && ['promisor', 'partialclonefilter'].includes(key)) refuse('unsupported config');
    const value = (entry[2] ?? '').replace(/[;#].*$/, '').trim().toLowerCase();
    if (section === 'core' && key === 'repositoryformatversion' && !/^(?:0|"0")$/.test(value)) refuse('unsupported config');
    if (section === 'core' && key === 'bare' && !/^(?:false|"false")$/.test(value)) refuse('unsupported config');
  }
}

function admitStore(root: string): void {
  try {
    if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) refuse('unsupported root');
    const directory = path.join(root, '.git');
    // Inspect every component before treating an optional entry as absent.
    const inspect = (relative: string): fs.Stats | undefined => {
      const parts = ['.git', ...relative.split('/').filter(Boolean)];
      let cursor = root;
      let stat: fs.Stats | undefined;
      for (let i = 0; i < parts.length; i++) {
        cursor = path.join(cursor, parts[i]);
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
            (stat.isFile() && stat.nlink !== 1) || (i < parts.length - 1 && !stat.isDirectory())) refuse('unsupported metadata');
      }
      return stat;
    };
    if (!inspect('')?.isDirectory()) refuse('unsupported store');
    for (const name of ['objects', 'refs']) if (!inspect(name)?.isDirectory()) refuse('unsupported store');
    for (const name of ['commondir', 'gitdir', 'worktrees', 'config.worktree', 'reftable', 'shallow',
      'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
      if (inspect(name)) refuse('unsupported store');
    }
    const readMetadata = (name: string, cap: number): string => {
      const before = inspect(name);
      if (!before?.isFile() || before.size > cap) refuse('unsupported metadata');
      const bytes = readInputBytes(path.join(directory, name), root, 'git', cap);
      const after = inspect(name);
      if (!after?.isFile() || before.dev !== after.dev || before.ino !== after.ino) refuse('changed metadata');
      return decodeInput(bytes, 'git');
    };
    const inspectRef = (name: string): void => {
      const bytes = readMetadata(name, SMALL);
      const text = bytes.endsWith('\n') ? bytes.slice(0, -1) : bytes;
      if (text.includes('\n') || text.includes('\r')) refuse('unsupported reference');
      if (isOid(text)) return;
      const symbolic = /^ref: (refs\/.+)$/.exec(text);
      if (!symbolic || !refName(symbolic[1])) refuse('unsupported reference');
    };
    inspectRef('HEAD');
    inspectConfig(readMetadata('config', SMALL));
    const packed = inspect('packed-refs');
    if (packed && (!packed.isFile() || packed.size > 8 * 1048576)) refuse('unsupported packed references');
    // Only directory metadata is enumerated for objects: no historical object scan.
    let entries = 0;
    const walk = (relative: string, depth: number, refs: boolean): void => {
      if (depth > 16) refuse('metadata depth exceeded');
      const cursor = path.join(directory, relative);
      const handle = fs.opendirSync(cursor);
      try {
        let entry: fs.Dirent | null;
        while ((entry = handle.readSync()) !== null) {
          if (++entries > 100000) refuse('metadata count exceeded');
          const child = `${relative}/${entry.name}`;
          const stat = inspect(child);
          if (!stat) refuse('changed metadata');
          if (child.startsWith('objects/pack/') && entry.name.endsWith('.promisor')) refuse('unsupported store');
          if (stat.isDirectory()) walk(child, depth + 1, refs);
          else if (refs) inspectRef(child);
        }
      } finally {
        handle.closeSync();
      }
    };
    walk('refs', 0, true);
    walk('objects', 0, false);
  } catch (error) {
    if (error instanceof InputFailure) throw error;
    refuse('metadata unavailable');
  }
}

export function createGitContext(root: string) {
  admitStore(root);
  const prefix = ['--no-pager', '--no-replace-objects', '--literal-pathspecs',
    `--git-dir=${root}/.git`, `--work-tree=${root}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.commitGraph=false',
    '-c', 'core.multiPackIndex=false', '-c', 'protocol.allow=never'];
  const env = {
    PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '',
  };
  const run = (args: string[], cap = SMALL, ancestry = false): Buffer => {
    try {
      const result = spawnSync('git', [...prefix, ...args], {
        cwd: root, env, encoding: null, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: cap, input: '',
      });
      if (result.error || result.signal || result.status !== 0) {
        if (ancestry && !result.error && !result.signal && result.status === 1) refuse('target is not on captured main');
        refuse('operation failed');
      }
      if (!Buffer.isBuffer(result.stdout) || result.stdout.length > cap) refuse('invalid response');
      return result.stdout;
    } catch (error) {
      if (error instanceof InputFailure) throw error;
      refuse('operation failed');
    }
  };
  const line = (args: string[]): string => {
    const text = decodeInput(run(args), 'git');
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r') || text.includes('\0')) refuse('invalid response');
    return text.slice(0, -1);
  };
  const checkCommit = (oid: string): void => {
    if (!isOid(oid) || line(['cat-file', '-t', oid]) !== 'commit') refuse('invalid commit');
  };
  if (line(['rev-parse', '--show-toplevel']) !== root ||
      line(['rev-parse', '--absolute-git-dir']) !== path.join(root, '.git')) refuse('context mismatch');
  const head = line(['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  const main = line(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main']);
  checkCommit(head);
  checkCommit(main);

  const records = (bytes: Buffer): string[] => {
    const text = decodeInput(bytes, 'git');
    if (text === '') return [];
    if (!text.endsWith('\0')) refuse('invalid listing');
    const values = text.slice(0, -1).split('\0');
    if (values.some(value => !value)) refuse('invalid listing');
    return values;
  };
  const tree = (args: string[]): Map<string, TreeEntry> => {
    const entries = new Map<string, TreeEntry>();
    for (const record of records(run(args, LISTING))) {
      const entry = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!entry || !literalPath(entry[4]) || entries.has(entry[4])) refuse('invalid tree listing');
      const [, mode, type, oid, file] = entry;
      entries.set(file, { mode, type, oid, path: file });
    }
    return entries;
  };
  const exactEntry = (commit: string, file: string): TreeEntry => {
    if (!isOid(commit) || !literalPath(file)) refuse('invalid literal path or commit');
    const entries = tree(['ls-tree', '-z', '--full-tree', commit, '--', file]);
    const entry = entries.get(file);
    if (entries.size !== 1 || !entry) refuse('missing exact tree entry');
    return entry;
  };
  const regularEntry = (commit: string, file: string): TreeEntry => {
    const entry = exactEntry(commit, file);
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') refuse('nonregular tree entry');
    return entry;
  };

  return Object.freeze({
    head, main,
    listPublication(): ReadonlyMap<string, TreeEntry> {
      const entry = exactEntry(head, PUBLICATION);
      if (entry.mode !== '040000' || entry.type !== 'tree') refuse('missing publication tree');
      const entries = tree(['ls-tree', '-r', '-z', '--full-tree', head, '--', PUBLICATION]);
      if ([...entries.keys()].some(file => !file.startsWith(`${PUBLICATION}/`))) refuse('invalid publication listing');
      return entries;
    },
    readRegularBlob(commit: string, file: string, cap: number): Buffer {
      if (!Number.isSafeInteger(cap) || cap < 0 || cap > 262144) refuse('invalid blob cap');
      checkCommit(commit);
      const entry = regularEntry(commit, file);
      if (line(['cat-file', '-t', entry.oid]) !== 'blob') refuse('invalid blob kind');
      const sizeText = line(['cat-file', '-s', entry.oid]);
      if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText)) refuse('invalid blob size');
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size > cap) refuse('blob size exceeded');
      const bytes = run(['cat-file', 'blob', entry.oid], cap + 1);
      if (bytes.length !== size) refuse('changed blob response');
      return bytes;
    },
    assertClaimTarget(commit: string, changedPaths: string[]): void {
      checkCommit(commit);
      if (run(['merge-base', '--is-ancestor', commit, main], SMALL, true).length !== 0) refuse('invalid ancestry response');
      const parents = line(['rev-list', '--parents', '-n', '1', commit, '--']).split(' ');
      if (parents[0] !== commit || parents.some(parent => !isOid(parent))) refuse('invalid parent response');
      const args = ['diff-tree', ...(parents.length === 1 ? ['--root'] : []), '--no-commit-id',
        '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '-r',
        ...(parents.length > 1 ? [parents[1]] : []), commit, '--'];
      const changed = records(run(args, LISTING));
      if (changed.some(file => !literalPath(file)) || new Set(changed).size !== changed.length) refuse('invalid change listing');
      const names = new Set(changed);
      for (const file of changedPaths) {
        if (!literalPath(file) || !names.has(file)) refuse('path not changed in target');
        const entry = regularEntry(commit, file);
        if (line(['cat-file', '-t', entry.oid]) !== 'blob') refuse('invalid changed blob');
      }
    },
  });
}
