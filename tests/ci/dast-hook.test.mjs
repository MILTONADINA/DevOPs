// specs/security/local-dast.md: fixed hook loading and passive completion witnesses.
// Fake local APIs/kernel text only; no daemon, scanner or real detector is invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts/dast/zap-completion.py');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const FIXTURE = String.raw`
from pathlib import Path
from datetime import datetime
from importlib.machinery import SourceFileLoader
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
import hashlib, json, os, sys

source = Path(sys.argv[1]).resolve(strict=True)
owned = Path(sys.argv[2]).resolve(strict=True)
scenario = sys.argv[3]
raw = source.read_bytes()
source_hash = hashlib.sha256(raw).hexdigest()
run_id = 'mr21-dast-' + 'a' * 32
origin = 'http://127.0.0.1:18080'
seed = origin + '/docs'
kind = 'application' if scenario.startswith('application_') else 'positive_control'
run_config = {'schema_version': 1, 'run_id': run_id, 'kind': kind, 'prepared_sha256': 'f' * 64}
native_ignored = ['-1', '50003', '60000', '60001']
reads = []
original_read = Path.read_bytes
# Synthetic proc rows contain only fields consumed by the fixed hook. This is
# a primitive fixture, never evidence of a real namespace or socket owner.
header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
tables = {
    '/proc/net/tcp': (header + '0: 0100007F:46A0 00000000:0000 0A 0:0 00:0 0 1000 0 101\n').encode(),
    '/proc/net/tcp6': (header + '0: 0000000000000000FFFF00000100007F:46AA ' + '0' * 32 + ':0000 0A 0:0 00:0 0 1000 0 102\n').encode(),
    '/proc/net/udp': header.encode(),
    '/proc/net/udp6': header.encode(),
}
if scenario in ['application_complete', 'control_extra_provider']:
    tables['/proc/net/tcp'] += b'1: 0100007F:46A1 00000000:0000 0A 0:0 00:0 0 1000 0 103\n'

def fixed_read(file):
    text = str(file)
    if text == '/dast/zap-completion.py':
        reads.append(text)
        return raw
    if text == '/dast/run.json':
        reads.append(text)
        return json.dumps(run_config).encode()
    if text in tables:
        reads.append(text)
        return tables[text]
    resolved = file.resolve(strict=True)
    assert resolved.is_relative_to(owned), 'Unexpected read outside the owned fixture'
    return original_read(file)

def fixed_link(file):
    assert str(file) == '/proc/self/ns/net'
    return 'net:[12345]'

def expect_refusal(function, errors=(AssertionError,)):
    try:
        function()
    except errors:
        return
    raise AssertionError('Completion or configuration was incorrectly accepted')

with patch.dict(os.environ, {}, clear=True):
    with patch.object(Path, 'read_bytes', fixed_read), patch.object(os, 'readlink', fixed_link):
        # Pinned upstream uses this exact public loader sequence. It does not
        # initialize __file__; a normal import_module would hide that defect.
        loader = SourceFileLoader('zap_hooks', str(source))
        hook = ModuleType(loader.name)
        loader.exec_module(hook)
        assert not hasattr(hook, '__file__')
        assert sorted(reads) == ['/dast/run.json', '/dast/zap-completion.py']
        assert hook.STATE['run_id'] == run_id and hook.STATE['seed'] == seed
        assert hook.STATE['hook_sha256'] == source_hash and hook.STATE['events'] == []
        names = ['zap_started', 'zap_spider', 'zap_spider_wrap', 'zap_get_alerts', 'zap_pre_shutdown']
        assert all(callable(getattr(hook, name)) for name in names)
        hook.OUT = owned
        if scenario != 'loader':
            zap = SimpleNamespace(
                pscan=SimpleNamespace(records_to_scan='0', scanners=[{'id': '10062', 'enabled': 'true'}]),
                core=SimpleNamespace(version='2.17.0', urls=lambda: [seed, origin + '/']))
            if scenario in ['application_missing_provider', 'control_extra_provider']:
                expect_refusal(lambda: hook.zap_started(zap, seed))
                assert not (owned / 'zap-before-report.json').exists()
                assert not (owned / 'zap-completion.json').exists()
            else:
                started = hook.zap_started(zap, seed)
                assert started[0] is zap and started[1] == seed
                spider = hook.zap_spider(zap, origin + '/')
                assert spider[0] is zap and spider[1] == origin + '/'
                assert hook.zap_spider_wrap(None) is None
                assert [e['event'] for e in hook.STATE['events']] == ['started', 'spider_entered', 'spider_returned']
                ignored = list(native_ignored)
                excluded = {}
                if scenario == 'extra_ignore':
                    ignored.append('10062')
                if scenario == 'before_pending':
                    zap.pscan.records_to_scan = '1'
                if scenario != 'missing_before':
                    if scenario in ['extra_ignore', 'before_pending']:
                        expect_refusal(lambda: hook.zap_get_alerts(zap, origin + '/', ignored, excluded))
                    else:
                        returned = hook.zap_get_alerts(zap, origin + '/', ignored, excluded)
                        assert len(returned) == 4
                        assert returned[0] is zap and returned[1] == origin + '/'
                        assert returned[2] is ignored and returned[3] is excluded
                        assert ignored == native_ignored and excluded == {}
                if scenario in ['extra_ignore', 'before_pending', 'missing_before']:
                    assert not (owned / 'zap-before-report.json').exists()
                    zap.pscan.records_to_scan = '0'
                    expect_refusal(lambda: hook.zap_pre_shutdown(zap))
                    assert not (owned / 'zap-completion.json').exists()
                elif scenario == 'argument_identity':
                    assert (owned / 'zap-before-report.json').is_file()
                    assert not (owned / 'zap-completion.json').exists()
                else:
                    witness = json.loads((owned / 'zap-before-report.json').read_bytes())
                    assert witness['events'][-1]['event'] == 'before_report'
                    assert witness['events'][-1]['queue'] == '0'
                    report_bytes = b'{"synthetic_callback_fixture":true}\n'
                    if scenario != 'report_missing':
                        (owned / 'zap.json').write_bytes(report_bytes)
                    if scenario == 'foreign_scope':
                        zap.core.urls = lambda: [seed, 'http://127.0.0.1:18081/private']
                    if scenario == 'rule_absent':
                        zap.pscan.scanners = [{'id': '10038', 'enabled': 'true'}]
                    if scenario == 'final_pending':
                        zap.pscan.records_to_scan = '1'
                    if scenario in ['complete', 'application_complete']:
                        hook.zap_pre_shutdown(zap)
                        complete = json.loads((owned / 'zap-completion.json').read_bytes())
                        assert complete['schema_version'] == 1 and complete['run_id'] == run_id
                        assert complete['seed'] == seed and complete['hook_sha256'] == source_hash
                        assert complete['events'][:-1] == witness['events']
                        assert [e['event'] for e in complete['events']] == ['started', 'spider_entered', 'spider_returned', 'before_report', 'before_shutdown']
                        assert complete['events'][-1]['queue'] == '0'
                        assert complete['urls'] == [seed, origin + '/']
                        assert complete['rules'] == [{'id': '10062', 'enabled': 'true'}]
                        assert complete['report_bytes'] == len(report_bytes)
                        assert complete['report_sha256'] == hashlib.sha256(report_bytes).hexdigest()
                        times = [event['monotonic_ns'] for event in complete['events']]
                        assert all(type(value) is str and value.isascii() and value.isdecimal() and (value == '0' or not value.startswith('0')) for value in times)
                        numeric_times = [int(value) for value in times]
                        assert all(left < right for left, right in zip(numeric_times, numeric_times[1:]))
                        assert all(datetime.fromisoformat(event['utc']).utcoffset().total_seconds() == 0 for event in complete['events'])
                        assert (owned / 'zap.json').read_bytes() == report_bytes
                    else:
                        errors = (FileNotFoundError,) if scenario == 'report_missing' else (AssertionError,)
                        expect_refusal(lambda: hook.zap_pre_shutdown(zap), errors)
                        assert not (owned / 'zap-completion.json').exists()
assert original_read(source) == raw, 'Hook input changed'
print(json.dumps({'scenario': scenario, 'passed': True, 'scope': 'fake API callback contract only'}))
`;

function verify(scenario) {
  assert.ok(existsSync(HOOK), 'FEATURE_ABSENT: scripts/dast/zap-completion.py is not implemented');
  const state = path.join(ROOT, '.workflow/state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'dast-hook-')));
  const before = hash(readFileSync(HOOK));
  try {
    const source = path.join(outer, 'zap-completion.py');
    const output = path.join(outer, 'output');
    mkdirSync(output);
    copyFileSync(HOOK, source);
    const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-', source, output, scenario], {
      input: FIXTURE, cwd: outer, env: { PATH: '/usr/bin:/bin', HOME: outer, TMPDIR: outer, LANG: 'C' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true, scope: 'fake API callback contract only' });
    assert.equal(hash(readFileSync(source)), before);
    assert.equal(hash(readFileSync(HOOK)), before);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

test('hook loads through the real no-__file__ loader and hashes the fixed mount', () => verify('loader'));
test('hook preserves all four alert arguments and the exact native ignore defaults', () => verify('argument_identity'));
test('zero before-report and final queues produce bound prefix and report witnesses', () => verify('complete'));
test('unfinished before-report queue cannot be repaired by a later zero queue', () => verify('before_pending'));
test('missing before-report witness refuses final completion', () => verify('missing_before'));
test('an added ignored rule refuses before-report and final witnesses', () => verify('extra_ignore'));
test('a final nonzero queue refuses completion after a valid before-report witness', () => verify('final_pending'));
test('a foreign service URL refuses completion', () => verify('foreign_scope'));
test('missing passive rule10062 refuses completion', () => verify('rule_absent'));
test('missing actual report refuses completion', () => verify('report_missing'));

test('hook chooses exact application and control listeners from fixed run config', () => {
  for (const scenario of ['application_complete', 'application_missing_provider', 'control_extra_provider']) verify(scenario);
});
