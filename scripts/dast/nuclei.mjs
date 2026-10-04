// specs/security/local-dast.md REQ5 and Annex B: fixed offline scanner and owned children.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const CAP = 2 * 1024 * 1024;
const OUT = '/out';
const IGNORE = '699053f709b11e80d853b63ebdcfe7ea0b15464f7d9709379c71bb12a41c627b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const utc = () => new Date().toISOString();
export class WorkloadFailure extends Error {
  constructor(code) { super('DAST workload refused'); this.code = code; }
}
export function readBounded(file, cap) {
  const before = lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > cap) throw new WorkloadFailure('internal');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new WorkloadFailure('internal');
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count;
    }
    const bytes = buffer.subarray(0, size);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(file);
    if (bytes.length > cap || bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== stat.mtimeMs ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || !pathAfter.isFile()) throw new WorkloadFailure('internal');
    return bytes;
  } finally { closeSync(fd); }
}
export function readRunConfig() {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded('/dast/run.json', 262144)));
  if (!value || Object.keys(value).sort().join(',') !== 'kind,prepared_sha256,run_id,schema_version' ||
      value.schema_version !== 1 || typeof value.run_id !== 'string' || !/^mr21-dast-[0-9a-f]{32}$/.test(value.run_id) ||
      !['application', 'positive_control'].includes(value.kind) || typeof value.prepared_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.prepared_sha256)) throw new WorkloadFailure('internal');
  return value;
}

// Shared only by the fixed proxy and scanner callers; no command API is exposed by a CLI.
export function spawnOwned(executable, args, { cwd, env, timeoutMs, maxBytes = CAP, graceMs = 2000, signal }) {
  const started_at = utc(); const parts = [[], []]; const sizes = [0, 0];
  let child; let result; let resolve; let timer; let escalation; let hardStop;
  let timed_out = false; let output_overflow = false; let stopping = false; let spawn_error = false; let capture_error = false;
  const closed = new Promise(done => { resolve = done; });
  const kill = name => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } }
  };
  const finish = (exit_code, signal, close_error = false) => {
    if (result) return;
    kill('SIGKILL');
    clearTimeout(timer); clearTimeout(escalation); clearTimeout(hardStop);
    signalOption?.removeEventListener('abort', abort);
    result = { exit_code, signal, timed_out, output_overflow, started_at, finished_at: utc(),
      stdout: Buffer.concat(parts[0]), stderr: Buffer.concat(parts[1]), spawn_error, close_error: close_error || capture_error };
    resolve(result);
  };
  const stop = () => {
    if (result) return closed;
    if (!stopping) {
      stopping = true; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), graceMs);
      hardStop = setTimeout(() => { kill('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy(); finish(null, null, true); }, graceMs + 2500);
    }
    return closed;
  };
  const signalOption = signal;
  const abort = () => { void stop(); };
  try {
    child = spawn(executable, args, { cwd, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', () => { spawn_error = true; finish(null, null); });
    child.once('close', (code, signame) => finish(code, signame));
    for (const [index, pipe] of [child.stdout, child.stderr].entries()) {
      pipe.on('error', () => { capture_error = true; void stop(); });
      pipe.on('data', chunk => {
      const available = Math.max(0, maxBytes - sizes[index]);
      if (available) { parts[index].push(chunk.subarray(0, available)); sizes[index] += Math.min(available, chunk.length); }
      if (chunk.length > available) { output_overflow = true; void stop(); }
      });
    }
    timer = setTimeout(() => { timed_out = true; void stop(); }, timeoutMs);
    if (signalOption?.aborted) void stop(); else signalOption?.addEventListener('abort', abort, { once: true });
  } catch { spawn_error = true; finish(null, null); }
  return { get pid() { return child?.pid; }, get live() { return !!child?.pid && child.exitCode === null && child.signalCode === null && !result && !stopping; },
    get result() { return result; }, closed, stop };
}

function socketTables() {
  return Object.fromEntries(['tcp', 'tcp6', 'udp', 'udp6'].map(name => {
    const bytes = readFileSync('/proc/net/' + name); if (bytes.length > 262144) throw new WorkloadFailure('nuclei');
    return [name, new TextDecoder('utf-8', { fatal: true }).decode(bytes)];
  }));
}
async function metrics(child, signal) {
  const until = Date.now() + 5000;
  while (Date.now() < until && child.live && !signal?.aborted) {
    const started_at = utc(); const tables = socketTables();
    const rows = tables.tcp.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
    const selected = rows.filter(fields => fields[3] === '0A' && fields[1] === '0100007F:46AB');
    if (selected.length === 1) {
      const inode = selected[0][9];
      const owned = readdirSync('/proc/' + child.pid + '/fd').some(fd => {
        try { return readlinkSync('/proc/' + child.pid + '/fd/' + fd) === 'socket:[' + inode + ']'; } catch { return false; }
      });
      if (!owned) throw new WorkloadFailure('nuclei');
      const namespace = readlinkSync('/proc/' + child.pid + '/ns/net');
      if (namespace !== readlinkSync('/proc/self/ns/net')) throw new WorkloadFailure('nuclei');
      const status = readFileSync('/proc/' + child.pid + '/status', 'utf8');
      for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) if (!new RegExp('^' + key + ':\\s+0+$', 'm').test(status)) throw new WorkloadFailure('nuclei');
      if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status)) throw new WorkloadFailure('nuclei');
      return { started_at, finished_at: utc(), namespace, socket_tables: tables };
    }
    await delay(10);
  }
  throw new WorkloadFailure('nuclei');
}
let started = false; let scanner;
export async function drainNuclei() { return scanner ? scanner.stop() : null; }
export async function runNuclei({ signal } = {}) {
  if (started || signal?.aborted) throw new WorkloadFailure('nuclei');
  started = true; readRunConfig();
  for (const name of ['nuclei.jsonl', 'nuclei-errors.log', 'nuclei.stdout.log', 'nuclei.stderr.log', 'nuclei-stage.json', 'nuclei-live.json']) {
    try { lstatSync(OUT + '/' + name); throw new WorkloadFailure('nuclei'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [file, expected] of [['laravel-env.yaml', '37566f5fb1764be65072836390d4ff3f40af4917ecf00bdb08dbfcf862bb09c7'],
    ['git-config.yaml', 'bd8bdfa0b5ed5bf4d3712edb793adfd0987d9282e51c6f7d673bf14b9e4dd524'], ['default-ignore.yaml', IGNORE]]) {
    if (digest(readBounded('/scanner/' + file, 262144)) !== expected) throw new WorkloadFailure('nuclei');
  }
  for (const file of ['/tmp/nuclei-home', '/tmp/nuclei-config', '/tmp/nuclei-cache']) mkdirSync(file, { mode: 0o700 });
  copyFileSync('/scanner/default-ignore.yaml', '/tmp/nuclei-config/.nuclei-ignore');
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/nuclei-home', TMPDIR: '/tmp', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: '/tmp/nuclei-config', XDG_CACHE_HOME: '/tmp/nuclei-cache', NUCLEI_CONFIG_DIR: '/tmp/nuclei-config' };
  const args = ['-u', 'http://127.0.0.1:18080', '-t', '/scanner/laravel-env.yaml,/scanner/git-config.yaml',
    '-pt', 'http', '-duc', '-ni', '-dr', '-nc', '-j', '-o', OUT + '/nuclei.jsonl', '-or', '-ot',
    '-stats', '-sj', '-si', '-1', '-mp', '18091', '-rl', '10', '-c', '1', '-bs', '1', '-timeout', '5', '-retries', '0',
    '-elog', OUT + '/nuclei-errors.log'];
  const child = spawnOwned('/scanner/nuclei', args, { cwd: env.HOME, env, timeoutMs: 45000, signal }); scanner = child;
  let live; let terminal; let stage;
  try { live = await metrics(child, signal); terminal = await child.closed; }
  finally {
    terminal ??= await child.stop();
    stage = Object.fromEntries(['started_at', 'finished_at', 'exit_code', 'signal', 'timed_out', 'output_overflow'].map(key => [key, terminal[key]]));
    writeFileSync(OUT + '/nuclei-stage.json', JSON.stringify(stage) + '\n', { flag: 'wx', mode: 0o600 });
    if (live) writeFileSync(OUT + '/nuclei-live.json', JSON.stringify(live) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(OUT + '/nuclei.stdout.log', terminal.stdout, { flag: 'wx', mode: 0o600 });
    writeFileSync(OUT + '/nuclei.stderr.log', terminal.stderr, { flag: 'wx', mode: 0o600 });
  }
  if (signal?.aborted || terminal.spawn_error || terminal.close_error) throw new WorkloadFailure('nuclei');
  const ignore_after_sha256 = digest(readBounded('/tmp/nuclei-config/.nuclei-ignore', 262144));
  if (ignore_after_sha256 !== IGNORE) throw new WorkloadFailure('nuclei');
  const { parseNucleiReports } = await import('./report-inputs.mjs');
  const summary = parseNucleiReports({ jsonl: readBounded(OUT + '/nuclei.jsonl', 10 * 1024 * 1024),
    stderr: terminal.stderr, errors: readBounded(OUT + '/nuclei-errors.log', CAP), stage });
  return { kind: 'nuclei', stage, live, nuclei_runtime: { metrics_host: '127.0.0.1', metrics_port: 18091, ignore_after_sha256 }, summary };
}
