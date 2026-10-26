#!/usr/bin/env node
// Pack a package twice (separate temp dirs, same working tree) and compare the tarballs:
// the sha256 of each and, per entry, the sorted file list and each file's sha256. Exits 1
// and prints the differing entries when they differ (specs/release/npm-package.md REQ-12).
// Not shipped in the package.
//
//   node scripts/pack-twice.mjs [package-dir]     (default: the repository root)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fail = (msg) => { console.error(`pack-twice: ${msg}`); process.exitCode = 1; };

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

// Pack into its own temp dir; return the tarball's hash and a path -> sha256 map of its entries.
function packOnce(pkgDir, work, label) {
  const dest = path.join(work, label);
  const out = path.join(dest, 'unpacked');
  mkdirSync(out, { recursive: true });
  const name = sh('npm', ['pack', pkgDir, '--pack-destination', dest, '--silent']).trim().split('\n').pop();
  const tarball = path.join(dest, name);
  sh('tar', ['-xzf', tarball, '-C', out]);
  const entries = new Map(walk(out).sort().map((f) => [f.replace(/^package\//, ''), sha256(readFileSync(path.join(out, f)))]));
  return { sha: sha256(readFileSync(tarball)), entries };
}

const pkgDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
if (!existsSync(path.join(pkgDir, 'package.json')) || !statSync(pkgDir).isDirectory()) {
  fail(`no package.json in ${pkgDir}`);
} else {
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'pack-twice-')));
  try {
    const a = packOnce(pkgDir, work, 'first');
    const b = packOnce(pkgDir, work, 'second');
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
