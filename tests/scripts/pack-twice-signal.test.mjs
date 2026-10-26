// specs/ops/script-entrypoints.md REQ-4: pack-twice stops its child, removes its temp dir and
// exits 130/143 on SIGINT/SIGTERM. The slow step is a synthetic prepack script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pack-twice.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function interrupted(signal) {
  const base = mkdtempSync(path.join(tmpdir(), 'pack-twice-sig-'));
  const pkg = path.join(base, 'pkg'), scratch = path.join(base, 'tmp'), marker = path.join(base, 'pid');
  try {
    mkdirSync(pkg); mkdirSync(scratch);
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'toy-slow', version: '1.0.0', files: ['index.js'],
      scripts: { prepack: `node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" ${JSON.stringify(marker)}` },
    }));
    writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 1;\n');
    const child = spawn(process.execPath, [SCRIPT, pkg], { env: { ...process.env, TMPDIR: scratch }, stdio: 'ignore' });
    const exit = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
    for (let i = 0; i < 300 && !existsSync(marker); i++) await sleep(50);
    assert.ok(existsSync(marker), 'the slow step never started');
    const slowPid = Number(readFileSync(marker, 'utf8'));
    assert.ok(readdirSync(scratch).some((n) => n.startsWith('pack-twice-')), 'temp dir should exist mid-run');
    child.kill(signal);
    const guard = setTimeout(() => child.kill('SIGKILL'), 20000);
    const result = await exit; clearTimeout(guard);
    return { ...result, left: readdirSync(scratch).filter((n) => n.startsWith('pack-twice-')), slowAlive: alive(slowPid) };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`pack-twice: ${signal} stops the slow step, removes the temp dir and exits ${code}`, async () => {
    const r = await interrupted(signal);
    assert.deepEqual({ code: r.code, sig: r.sig }, { code, sig: null });
    assert.deepEqual(r.left, []);
    assert.equal(r.slowAlive, false);
  });
}
