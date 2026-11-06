#!/usr/bin/env node
// Pack a package twice (separate temp dirs, same working tree) and compare the tarballs:
// the sha256 of each and, per entry, the sorted file list and each file's sha256. Exits 1
// and prints the differing entries when they differ (specs/release/npm-package.md REQ-13).
// Not shipped in the package.
//
//   node scripts/pack-twice.mjs [package-dir]     (default: the repository root)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fail = (msg) => { console.error(`pack-twice: ${msg}`); process.exitCode = 1; };

// Children run in their own process group so a signal can stop npm and its lifecycle scripts.
let current = null;
const stopGroup = (pid, sig) => { try { process.kill(process.platform === 'win32' ? pid : -pid, sig); } catch { /* already gone */ } };

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', (e) => { current = null; reject(new Error(`${cmd} ${args[0]} failed: ${e.message}`)); });
    child.once('close', (status) => {
      current = null;
      if (status !== 0) reject(new Error(`${cmd} ${args[0]} failed: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

// Pack into its own temp dir; return the tarball's hash and a path -> sha256 map of its entries.
async function packOnce(pkgDir, work, label) {
  const dest = path.join(work, label);
  const out = path.join(dest, 'unpacked');
  mkdirSync(out, { recursive: true });
  const name = (await sh('npm', ['pack', pkgDir, '--pack-destination', dest, '--silent'])).trim().split('\n').pop();
  const tarball = path.join(dest, name);
  await sh('tar', ['-xzf', tarball, '-C', out]);
  const entries = new Map(walk(out).sort().map((f) => [f.replace(/^package\//, ''), sha256(readFileSync(path.join(out, f)))]));
  return { sha: sha256(readFileSync(tarball)), entries };
}

const pkgDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
if (!existsSync(path.join(pkgDir, 'package.json')) || !statSync(pkgDir).isDirectory()) {
  fail(`no package.json in ${pkgDir}`);
} else {
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'pack-twice-')));
  // SIGINT/SIGTERM: stop the running child (SIGKILL for what is left), remove the temp dir, exit 130/143.
  let stopping = false;
  const onSignal = (sig, code) => {
    if (stopping) return; stopping = true;
    const child = current;
    // SIGKILL the whole group even after npm closes: a lifecycle script may have left a worker behind.
    const done = () => { if (child?.pid) stopGroup(child.pid, 'SIGKILL'); rmSync(work, { recursive: true, force: true }); process.exit(code); };
    if (!child?.pid) return done();
    stopGroup(child.pid, 'SIGTERM');
    const timer = setTimeout(done, 2000);
    child.once('close', () => { clearTimeout(timer); done(); });
  };
  process.on('SIGINT', () => onSignal('SIGINT', 130));
  process.on('SIGTERM', () => onSignal('SIGTERM', 143));
  try {
    const a = await packOnce(pkgDir, work, 'first');
    const b = await packOnce(pkgDir, work, 'second');
    if (a.sha === b.sha) {
      console.log(`pack-twice: reproducible, ${a.entries.size} files, sha256 ${a.sha}`);
    } else {
      console.error(`pack-twice: FAIL: tarballs differ\n  first  sha256 ${a.sha}\n  second sha256 ${b.sha}`);
      let listed = 0;
      for (const f of [...new Set([...a.entries.keys(), ...b.entries.keys()])].sort()) {
        const line = !b.entries.has(f) ? 'only in first' : !a.entries.has(f) ? 'only in second' : a.entries.get(f) !== b.entries.get(f) ? 'differs' : null;
        if (line) { console.error(`  ${line}: ${f}`); listed++; }
      }
      if (!listed) console.error('  every entry matches: the archive metadata or compression differs');
      process.exitCode = 1;
    }
  } catch (err) {
    fail(err.message);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
