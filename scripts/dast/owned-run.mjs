// specs/security/local-dast.md REQ-1/9: bounded children and exact owned cleanup.
import { spawn } from 'node:child_process';
import { accessSync, constants, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function runCommand(executable, args, { cwd, env, timeoutMs, maxBytes, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
      typeof executable !== 'string' || !Array.isArray(args) || !env || typeof cwd !== 'string') {
    throw new Error('Invalid owned command');
  }
  return new Promise(resolve => {
    const started_at = new Date().toISOString();
    const chunks = [[], []], sizes = [0, 0];
    let child, deadline, force, closeDeadline, stopping = false, settled = false, error;
    let exit_code = null, terminalSignal = null, timed_out = false, output_overflow = false, aborted = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Also remove descendants that closed their inherited pipes before their
      // direct parent exited. The detached group belongs only to this command.
      killGroup('SIGKILL');
      for (const timer of [deadline, force, closeDeadline]) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ exit_code, signal: terminalSignal, timed_out, output_overflow, aborted,
        stdout: Buffer.concat(chunks[0]), stderr: Buffer.concat(chunks[1]), started_at,
        finished_at: new Date().toISOString(), ...(error ? { error } : {}) });
    };
    const killGroup = value => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, value); }
      catch { try { child.kill(value); } catch { /* Exact child may already be reaped. */ } }
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true; clearTimeout(deadline);
      killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), 250);
      closeDeadline = setTimeout(() => {
        // A broken pipe/OS teardown cannot make the caller wait without a bound.
        error ??= 'drain'; killGroup('SIGKILL');
        child.stdout?.destroy(); child.stderr?.destroy(); finish();
      }, 2250);
    };
    const cancel = () => { aborted = true; stop(); };
    if (signal?.aborted) { aborted = true; finish(); return; }
    try {
      child = spawn(executable, args, { cwd, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { error = 'spawn'; finish(); return; }
    child.once('error', () => { error = 'spawn'; });
    child.once('exit', (code, value) => { if (!error) { exit_code = code; terminalSignal = value; } });
    child.once('close', (code, value) => {
      if (!error) { exit_code = code; terminalSignal = value; }
      finish();
    });
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.on('error', () => { error = 'capture'; stop(); });
      stream.on('data', bytes => {
      const available = maxBytes - sizes[index];
      const retained = bytes.subarray(0, Math.max(0, available));
      if (retained.length) { chunks[index].push(retained); sizes[index] += retained.length; }
      if (bytes.length > available) { output_overflow = true; stop(); }
      });
    });
    deadline = setTimeout(() => { timed_out = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

const successful = result => result?.exit_code === 0 && result.signal === null &&
  !result.timed_out && !result.output_overflow && !result.aborted && !result.error;

export async function cleanupOwned(resources, { inspect, drain, remove }) {
  const result = { complete: true, resources: [] }, seen = new Set();
  // Dependents are drained first, so the namespace anchor outlives its scanner.
  for (const resource of [...resources].reverse()) {
    const item = { id: resource.id, removed: false, exit_code: null, signal: null };
    result.resources.push(item);
    try {
      if (!/^[0-9a-f]{64}$/.test(resource.id) || seen.has(resource.id) ||
          !/^mr21-(?:dast|prep)-[0-9a-f]{32}$/.test(resource.run_id) || !/^[a-z][a-z0-9-]*$/.test(resource.role)) {
        throw new Error('Invalid owned resource');
      }
      seen.add(resource.id);
      const actual = await inspect(resource.id), labels = actual?.Config?.Labels;
      if (actual?.Id !== resource.id || labels?.['devops.dast.run'] !== resource.run_id ||
          labels?.['devops.dast.role'] !== resource.role) throw new Error('Foreign resource');
      try { if (!successful(await drain(resource))) result.complete = false; }
      catch { result.complete = false; }
      try {
        const removed = await remove(resource.id);
        item.removed = successful(removed);
        item.exit_code = Number.isInteger(removed?.exit_code) ? removed.exit_code : null;
        item.signal = typeof removed?.signal === 'string' ? removed.signal : null;
        if (!item.removed) result.complete = false;
      } catch { result.complete = false; }
    } catch { result.complete = false; }
  }
  return result;
}

export function finalizeSummary(gate, cleanup) {
  return cleanup.complete ? { ...gate, cleanup } : {
    ...gate, cleanup, verdict: 'INDETERMINATE', reason: 'cleanup', scan_reason: gate.reason,
  };
}

export { successful };

export function writeJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Owned record exceeds bound');
  const temp = file + '.' + randomBytes(8).toString('hex');
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const parent = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
    const candidate = path.join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Next explicit PATH entry. */ }
  }
  throw new Error('Required executable unavailable');
}

export function dockerContext(directory, logs) {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  writeFileSync(path.join(directory, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const host = process.platform === 'darwin' ? `unix://${homedir()}/.docker/run/docker.sock` :
    process.platform === 'linux' ? 'unix:///var/run/docker.sock' : null;
  if (!host) throw new Error('Unsupported Docker platform');
  const binary = executable('docker');
  const prefix = ['--config', directory, '--host', host];
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, LC_ALL: 'C' };
  const used = new Set();
  return {
    async call(label, args, options = {}) {
      if (!/^[a-z0-9_-]+$/.test(label) || used.has(label)) throw new Error('Invalid owned operation label');
      used.add(label);
      const result = await runCommand(binary, [...prefix, ...args], {
        cwd: directory, env, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, ...options,
      });
      writeFileSync(path.join(logs, label + '.stdout.log'), result.stdout, { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(logs, label + '.stderr.log'), result.stderr, { flag: 'wx', mode: 0o600 });
      const { stdout, stderr, ...terminal } = result;
      writeJson(path.join(logs, label + '.json'), { argv: args, ...terminal, stdout_bytes: stdout.length, stderr_bytes: stderr.length });
      return result;
    },
  };
}
