// hooks/universal/pre-tool/budget-brake.sh: a reserve or cap that is not a plain
// non-negative decimal blocks the call (exit 2) instead of lowering the projected
// spend or running as awk code, and a valid reserve is still checked against the
// caps. Runs the hook in a disposable project with its own ledger and config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'budget-brake.sh');

function brake(reserve, { config, spent = 0, ledger: ledgerText } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-brake-'));
  try {
    const state = path.join(dir, '.workflow', 'state');
    mkdirSync(state, { recursive: true });
    const ledger = path.join(state, 'budget-ledger.jsonl');
    if (spent) writeFileSync(ledger, `${JSON.stringify({ ts: Math.floor(Date.now() / 1000), session_id: 'toy', type: 'spend', cost_usd: spent })}\n`);
    if (ledgerText) writeFileSync(ledger, ledgerText);
    if (config) writeFileSync(path.join(state, 'budget.yml'), config);
    const sentinel = path.join(dir, 'awk-ran-code');
    const args = reserve === undefined ? [HOOK] : [HOOK, reserve.replaceAll('SENTINEL', sentinel)];
    const result = spawnSync('bash', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C', DEVOPS_SESSION_ID: 'toy' } });
    assert.equal(result.error, undefined, String(result.error));
    return { status: result.status, injected: existsSync(sentinel), ledger: existsSync(ledger) ? readFileSync(ledger, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('budget-brake allows a valid reserve under the caps and records it', () => {
  const result = brake('0.25');
  assert.equal(result.status, 0);
  assert.match(result.ledger, /"type":"reserve","cost_usd":0.25/);
});

test('budget-brake blocks a valid reserve that would pass the session cap', () => {
  assert.equal(brake('1.00', { spent: 4.5 }).status, 2);
});

for (const reserve of ['-100', '1e9', 'abc', '0.1}; END { system("touch SENTINEL") } BEGIN {']) {
  test(`budget-brake blocks the reserve ${JSON.stringify(reserve)} without running it`, () => {
    const result = brake(reserve, { spent: 4.5 });
    assert.equal(result.status, 2);
    assert.equal(result.injected, false, 'the reserve never runs as awk code');
  });
}

test('budget-brake blocks a cap in budget.yml that is not a decimal amount', () => {
  assert.equal(brake('0.10', { config: 'session_cap_usd: unlimited\nhourly_cap_usd: 20\ndaily_cap_usd: 100\n' }).status, 2);
});

for (const cost of ['-100', '"abc"', '""']) {
  test(`budget-brake blocks a ledger whose cost_usd is ${cost}`, () => {
    const ts = Math.floor(Date.now() / 1000);
    assert.equal(brake('0.10', { ledger: `{"ts":${ts},"session_id":"toy","type":"spend","cost_usd":${cost}}\n` }).status, 2);
  });
}
