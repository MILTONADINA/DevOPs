// Registry/network resilience: every workflow that installs from npm sets the fetch retry
// config, and every explicit docker pull of a public image sits in a bounded retry loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const DIR = path.resolve(import.meta.dirname, '..', '..', '.github/workflows');
const RETRY = {
  npm_config_fetch_retries: '5',
  npm_config_fetch_retry_mintimeout: '10000',
  npm_config_fetch_retry_maxtimeout: '60000',
};
const NPM_FETCH = /\bnpm\s+(ci|install|i|audit)\b/;
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml')).sort();
const load = (f) => parse(readFileSync(path.join(DIR, f), 'utf8'));
const covers = (env) => Object.entries(RETRY).every(([k, v]) => String(env?.[k]) === v);

test('every npm install/audit step runs with the fetch retry config', () => {
  let steps = 0;
  for (const f of files) {
    const wf = load(f);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (!NPM_FETCH.test(step.run ?? '')) continue;
        steps++;
        assert.ok(
          covers({ ...wf.env, ...job.env, ...step.env }),
          `${f} job ${name}: npm step "${step.name ?? step.run.split('\n')[0]}" has no fetch retry config`,
        );
      }
    }
  }
  assert.ok(steps >= 8, `expected to find the npm steps, found ${steps}`);
});

// Run the step's shell with docker/sleep stubbed: docker pull fails `fails` times, then succeeds.
function runPull(run, fails) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pull-retry-'));
  const stub = (name, body) => { writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(dir, name), 0o755); };
  stub('docker', `case "$1" in pull) echo pull >> "${dir}/log"; n=$(grep -c pull "${dir}/log"); [ "$n" -gt ${fails} ] ;; *) echo "$1" >> "${dir}/log" ;; esac`);
  stub('sleep', `echo "$1" >> "${dir}/sleeps"`);
  const r = spawnSync('bash', ['-c', run], {
    env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_WORKSPACE: dir, HOME: dir },
    encoding: 'utf8',
  });
  const read = (f) => { try { return readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { status: r.status, log: read('log'), sleeps: read('sleeps') };
}

test('the Semgrep image pull retries exactly 3 times with backoff, then stops the step', () => {
  const step = load('security-scan.yml').jobs.semgrep.steps.find((x) => /docker run/.test(x.run ?? ''));
  assert.ok(step, 'semgrep docker step not found');
  // Keep only the pull loop: everything between the image assignment and `docker run`.
  const head = step.run.slice(step.run.indexOf('semgrep_image='), step.run.indexOf('docker run'));
  const script = `set -euo pipefail\n${head}\ndocker run`;
  const ok = runPull(script, 2);
  assert.equal(ok.status, 0); assert.deepEqual(ok.log, ['pull', 'pull', 'pull', 'run']); assert.deepEqual(ok.sleeps, ['5', '10']);
  const first = runPull(script, 0);
  assert.equal(first.status, 0); assert.deepEqual(first.log, ['pull', 'run']); assert.deepEqual(first.sleeps, []);
  const bad = runPull(script, 99);
  assert.notEqual(bad.status, 0); assert.deepEqual(bad.log, ['pull', 'pull', 'pull']); assert.deepEqual(bad.sleeps, ['5', '10']);
});

test('every workflow step that pulls or runs a docker image has a bounded retry loop before it', () => {
  let n = 0;
  for (const f of files) {
    for (const [name, job] of Object.entries(load(f).jobs)) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? '';
        if (!/\bdocker\s+(pull|run)\b/.test(run)) continue;
        n++;
        const loop = run.match(/for delay in ([^;\n]+);\s*do([\s\S]*?)\bdone\b/);
        const where = `${f} job ${name}`;
        assert.ok(loop, `${where}: no retry loop`);
        assert.ok(loop[1].trim().split(/\s+/).length >= 3, `${where}: fewer than 3 tries`);
        assert.match(loop[2], /docker pull\b/, `${where}: docker pull is not inside the loop`);
        assert.match(loop[2], /\bsleep\b/, `${where}: no backoff in the loop`);
        assert.match(loop[2], /exit 1/, `${where}: exhausted retries do not fail the step`);
        assert.ok(run.indexOf('docker run') < 0 || run.indexOf('docker run') > run.indexOf('done'), `${where}: docker run precedes the pull loop`);
      }
    }
  }
  assert.ok(n >= 2, `expected docker steps, found ${n}`);
});
