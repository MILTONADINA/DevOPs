// Registry/network resilience: every workflow that installs from npm sets the fetch retry
// config, and every explicit docker pull of a public image sits in a bounded retry loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
          covers(wf.env) || covers(job.env) || covers(step.env),
          `${f} job ${name}: npm step "${step.name ?? step.run.split('\n')[0]}" has no fetch retry config`,
        );
      }
    }
  }
  assert.ok(steps >= 8, `expected to find the npm steps, found ${steps}`);
});

test('every docker pull and public-image docker run retries up to 3 times with backoff', () => {
  let pulls = 0;
  for (const f of files) {
    const wf = load(f);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? '';
        if (!/\bdocker\s+(pull|run)\b/.test(run)) continue;
        pulls++;
        const where = `${f} job ${name}`;
        assert.match(run, /docker pull\b/, `${where}: docker run without an explicit pull`);
        assert.match(run, /for delay in\b[^\n]*;\s*do/, `${where}: pull is not in a retry loop`);
        assert.match(run, /\bsleep\b/, `${where}: pull retry has no backoff`);
        const m = run.match(/for delay in ([^;\n]+);/);
        assert.ok(m.input && m[1].trim().split(/\s+/).length >= 3, `${where}: fewer than 3 tries`);
      }
    }
  }
  assert.ok(pulls >= 2, `expected docker pull steps, found ${pulls}`);
});
