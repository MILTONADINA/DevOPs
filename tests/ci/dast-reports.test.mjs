// specs/security/local-dast.md REQ3–9; fixed report-wire/Annex A.
// Synthetic owned bundles only. No scanner, Docker, model, network or real scan claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMPANIONS = ['scripts/assert-dast-reports.mjs', 'scripts/dast/report-inputs.mjs',
  'scripts/dast/isolation.mjs', 'scripts/dast/policy.json', 'scripts/dast/zap-completion.py'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const ID = 'mr21-dast-' + 'a'.repeat(32), ANCHOR = '1'.repeat(64), ZAP = '2'.repeat(64);
const ORIGIN = 'http://127.0.0.1:18080', SEED = ORIGIN + '/docs', NS = 'net:[12345]';
const SENTINEL = 'DO_NOT_EMIT_SYNTHETIC_REPORT_BODY';
const at = second => `2026-10-04T12:00:${String(second).padStart(2, '0')}.000Z`;
const PINNED = {
  schema_version: 1, origin: ORIGIN, seed: SEED,
  platforms: {
    'linux/amd64': {
      node: { ref: 'node@sha256:5a750d3be5e5c80275f8c9a5367c3aed99c2875656590c8d0701c7ee687f5f0a', config_sha256: 'b795e77f6c253b171f482eff27b9b882dc4cdcb42d773372e298481c7318fbc2' },
      zap: { ref: 'ghcr.io/zaproxy/zaproxy@sha256:71db37cd5b75663b35758d10aaec05bf6fbac23f5020e3046c70e628a5f84efa', config_sha256: '6175579a46d477338e4b641dd9c3428936f30c3719809e2f4d36f58e60c4ddb7' },
      nuclei_archive_sha256: 'ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6',
    },
    'linux/arm64': {
      node: { ref: 'node@sha256:91882e0e5959240d4413fc42c180022bbdd09c5491e00e75faa6c100d8d7751b', config_sha256: '7e6ba96b9576ae44872bdb57bc0665a70fd87bbc7c8a019ab849429c6c69ef44' },
      zap: { ref: 'ghcr.io/zaproxy/zaproxy@sha256:05cbf4cab5d2fdaef55b0cd0b586f22d0ce4f75e0995f3cea2db23afbbdfd2f8', config_sha256: '231957771c358eea88903a40b62d15ebd9304a180909d48d4ac5a924e24b11b0' },
      nuclei_archive_sha256: '8044e3d9768ba0a744b2872c1a87e813006f013da97ca9f50f7661a4203bec07',
    },
  },
  nuclei_version: '3.11.1',
  templates: { commit: '893122ffce8ebf8e264f15d2cd3960cb1dd36d6c',
    laravel_env_sha256: '37566f5fb1764be65072836390d4ff3f40af4917ecf00bdb08dbfcf862bb09c7',
    git_config_sha256: 'bd8bdfa0b5ed5bf4d3712edb793adfd0987d9282e51c6f7d673bf14b9e4dd524',
    ignore_sha256: '699053f709b11e80d853b63ebdcfe7ea0b15464f7d9709379c71bb12a41c627b' },
  zap: { version: '2.17.0', common_original_sha256: 'a1f65469bdee238424d2c32bbe15345ba3fb7089baf9800fbe72f20fa88c72c0',
    common_sha256: 'fe62f7abb3a9ef75bbf0f5edc49fa9d276607262fc8436fa87050745ec9cd361' },
};
const HEADER = '  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
function sockets(ports) {
  return { tcp: HEADER + ports.map((port, n) => ` ${n}: 0100007F:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${100 + n}\n`).join(''),
    tcp6: HEADER, udp: HEADER, udp6: HEADER };
}
function network() {
  return { netns: NS, if_nameindex: [[1, 'lo']], sysfs_entries: ['lo'], sysfs_noninterfaces: [],
    interfaces: [{ index: 1, name: 'lo', flags: 73, admin_up: true, running: true,
      ifindex_sysfs: '1', iflink_sysfs: '1', flags_sysfs: '0x9', type_sysfs: '772',
      operstate_sysfs: 'unknown', address_sysfs: '00:00:00:00:00:00', primary_ipv4: '127.0.0.1', ipv6: [] }],
    ipv6_addresses_raw: '', routes4_raw: 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n',
    routes6_raw: '', fib_trie_raw: 'Main:\n +-- 127.0.0.0/8 2 0 2\n |-- 127.0.0.1\n /32 host LOCAL\n',
    security: { Uid: '1000\t1000\t1000\t1000', CapInh: '0000000000000000', CapPrm: '0000000000000000',
      CapEff: '0000000000000000', CapBnd: '0000000000000000', CapAmb: '0000000000000000', NoNewPrivs: '1' } };
}
function inertTunnel(n) {
  n.if_nameindex.push([2, 'tunl0']); n.sysfs_entries.push('tunl0');
  n.interfaces.push({ index: 2, name: 'tunl0', flags: 128, admin_up: false, running: false,
    ifindex_sysfs: '2', iflink_sysfs: '0', flags_sysfs: '0x80', type_sysfs: '768',
    operstate_sysfs: 'down', address_sysfs: '00:00:00:00', primary_ipv4: null,
    ipv4_absent_errno: 99, ipv6: [] });
}
const bind = (asset, destination, read_only = true) => ({ type: 'bind', asset, destination, read_only });
function docker(role, kind, image) {
  const control = kind === 'positive_control', anchor = role === 'anchor';
  const tmpfs = { '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777' };
  if (anchor && !control) tmpfs['/app/runtime/data'] = 'rw,nosuid,nodev,size=32m,mode=1777';
  const common = [bind('dast_scripts', '/dast'), bind('run_config', '/dast/run.json')];
  return { id: anchor ? ANCHOR : ZAP, image, config: { user: '1000:1000' },
    host: { network_mode: anchor ? 'none' : `container:${ANCHOR}`, readonly_rootfs: anchor,
      privileged: false, cap_drop: ['ALL'], security_opt: ['no-new-privileges'], port_bindings: {},
      cap_add: null, devices: null, device_requests: null, device_cgroup_rules: null, volumes_from: null,
      publish_all_ports: false, extra_hosts: null, pid_mode: '', ipc_mode: 'private', tmpfs },
    mounts: anchor ? [...(control ? [bind('positive_control', '/control.mjs')] :
      [bind('app_runtime', '/app/runtime'), bind('app_observability', '/app/observability')]), ...common,
      bind('nuclei_binary', '/scanner/nuclei'), bind('laravel_env', '/scanner/laravel-env.yaml'),
      bind('git_config', '/scanner/git-config.yaml'), bind('nuclei_ignore', '/scanner/default-ignore.yaml'), bind('reports', '/out', false)] :
      [...common, bind('zap_common', '/zap/zap_common.py'), bind('reports', '/zap/wrk', false)] };
}
function finding(id = 'git-config') {
  return { 'template-id': id, type: 'http', host: '127.0.0.1', port: '18080', scheme: 'http',
    url: ORIGIN, ip: '127.0.0.1', 'matched-at': ORIGIN + (id === 'git-config' ? '/.git/config' : '/.env'),
    'matcher-status': true, info: { severity: id === 'git-config' ? 'medium' : 'high', description: SENTINEL }, timestamp: at(15) };
}
function alert(risk = '1', id = '10021') {
  return { pluginid: id, riskcode: risk, count: '2', instances: [{ uri: ORIGIN + '/' }, { uri: SEED }], desc: SENTINEL };
}
function bundle(hookHash, kind = 'application', platform = 'linux/amd64') {
  const pin = PINNED.platforms[platform], control = kind === 'positive_control';
  const prepared = { schema_version: 1, platform, source_manifest_sha256: '3'.repeat(64),
    images: { node: { ...pin.node, engine_id: 'sha256:' + '4'.repeat(64) }, zap: { ...pin.zap, engine_id: 'sha256:' + '5'.repeat(64) } },
    nuclei: { version: PINNED.nuclei_version, archive_sha256: pin.nuclei_archive_sha256, binary_sha256: '6'.repeat(64) },
    templates: clone(PINNED.templates), zap_hook_sha256: hookHash,
    zap_common_original_sha256: PINNED.zap.common_original_sha256, zap_common_sha256: PINNED.zap.common_sha256 };
  const terminal = (a, b) => ({ started_at: at(a), finished_at: at(b), exit_code: 0, signal: null, timed_out: false, output_overflow: false });
  const phases = ['initial', 'nuclei_before', 'nuclei_after', 'zap_before', 'zap_after'];
  const windows = [[1, 2], [3, 4], [21, 22], [23, 24], [41, 42]];
  const health = phases.map((phase, i) => ({ phase, started_at: at(windows[i][0]), finished_at: at(windows[i][1]),
    proxy_pid: 42, proxy_alive: true, health_status: 200, health: { status: 'ok', phase: '1-measurement-proxy' },
    message_status: 200, answer: 'MR21 synthetic provider response', input_tokens: 23, output_tokens: 7,
    provider_before: i, provider_after: i + 1, provider_rejected: 0,
    capture: { sessions: 1, turns: i + 1, input_tokens: 23 * (i + 1), output_tokens: 7 * (i + 1) },
    ...(i ? {} : { routes: { docs: 200, openapi: 200, dashboard: 200, dashboard_graph: 200 } }) }));
  const basePorts = control ? [18080] : [18080, 18081];
  const observations = [['nuclei_before', 5, 6], ['nuclei_live', 12, 13], ['zap_before', 25, 26], ['zap_live', 32, 32], ['zap_after', 43, 44]]
    .map(([phase, a, b]) => ({ phase, started_at: at(a), finished_at: at(b), container_id: phase === 'nuclei_live' ? ANCHOR : ZAP,
      namespace: NS, socket_tables: sockets([...basePorts, ...(phase === 'nuclei_live' ? [18091] : phase === 'zap_live' ? [18090] : [])]),
      ...(!phase.endsWith('_live') ? { network: network() } : {}) }));
  const events = ['started', 'spider_entered', 'spider_returned', 'before_report', 'before_shutdown'].map((event, i) => ({
    event, utc: at([32, 33, 34, 36, 37][i]), monotonic_ns: String(9007199254740992n + BigInt(i)),
    ...(i === 0 ? { namespace: NS, listeners: [...basePorts, 18090].map(port => ['127.0.0.1', port]), socket_tables: clone(observations[3].socket_tables) } : {}),
    ...(i === 1 ? { target: ORIGIN + '/' } : {}), ...(i >= 3 ? { queue: '0' } : {}) }));
  const witness = { schema_version: 1, run_id: ID, seed: SEED, hook_sha256: hookHash, events };
  const stat = { duration: '0:00:02', errors: '0', hosts: '1', matched: '0', percent: '100', requests: '23', rps: '11', startedAt: at(11), templates: '2', total: '23' };
  return { prepared, run: { schema_version: 1, run_id: ID, kind, platform, origin: ORIGIN, seed: SEED,
    started_at: at(0), finished_at: at(50), prepared_sha256: '', artifacts: {}, stages: { nuclei: terminal(10, 20), zap: terminal(30, 40) },
    containers: { anchor_id: ANCHOR, zap_id: ZAP, namespace: NS },
    nuclei_runtime: { metrics_host: '127.0.0.1', metrics_port: 18091, ignore_after_sha256: PINNED.templates.ignore_sha256 },
    health: control ? [] : health, ...(control ? { control_health: { before: { status: 200, marker: 'MR21 synthetic detector control' },
      after: { status: 200, marker: 'MR21 synthetic detector control' }, paths: ['/', '/docs', '/.env', '/.git/config'] } } : {}) },
    isolation: { schema_version: 1, run_id: ID, kind, prepared_sha256: '', anchor_id: ANCHOR, namespace: NS,
      docker: { anchor: docker('anchor', kind, prepared.images.node.engine_id), zap: docker('zap', kind, prepared.images.zap.engine_id) }, observations },
    findings: [], stats: [stat, clone(stat)], errors: '',
    zap: { '@version': '2.17.0', site: [{ '@name': ORIGIN, '@host': '127.0.0.1', '@port': '18080', '@ssl': 'false', alerts: [] }] },
    before: { ...clone(witness), events: clone(events.slice(0, 4)) },
    completion: { ...clone(witness), urls: [SEED, ORIGIN + '/'], rules: [{ id: '10062', name: 'PII Disclosure', enabled: 'true', alertThreshold: 'DEFAULT', quality: 'release', status: 'release' }] } };
}
function writeBundle(dir, b) {
  const prepared = json(b.prepared), zap = json(b.zap);
  b.run.prepared_sha256 = b.isolation.prepared_sha256 = hash(prepared);
  b.completion.report_sha256 = hash(zap); b.completion.report_bytes = zap.length;
  const content = { 'prepared.json': prepared, 'isolation.json': json(b.isolation),
    'nuclei.jsonl': Buffer.from(b.findings.map(x => JSON.stringify(x) + '\n').join('')),
    'nuclei.stdout.log': Buffer.alloc(0), 'nuclei.stderr.log': Buffer.from('[INF] synthetic framing only\n' + b.stats.map(x => JSON.stringify(x) + '\n').join('')),
    'nuclei-errors.log': Buffer.from(b.errors), 'zap.json': zap, 'zap.stdout.log': Buffer.alloc(0), 'zap.stderr.log': Buffer.alloc(0),
    'zap-before-report.json': json(b.before), 'zap-completion.json': json(b.completion) };
  for (const [name, raw] of Object.entries(content)) {
    writeFileSync(path.join(dir, name), raw); b.run.artifacts[name] = { bytes: raw.length, sha256: hash(raw) };
  }
  writeFileSync(path.join(dir, 'run.json'), json(b.run));
}
function snapshot(dir) {
  const out = {};
  function walk(name) {
    const file = path.join(dir, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) out[name] = ['link', readlinkSync(file)];
    else if (stat.isDirectory()) { out[name] = ['dir']; for (const child of readdirSync(file).sort()) walk(path.join(name, child)); }
    else if (stat.isFile()) out[name] = ['file', stat.mode, stat.size, hash(readFileSync(file))];
    else out[name] = ['other', stat.mode];
  }
  walk(''); return out;
}
function fixture(run, { mutate = () => {}, after = () => {}, kind = 'application', platform = 'linux/amd64' } = {}) {
  assert.ok(existsSync(path.join(ROOT, COMPANIONS[0])), 'FEATURE_ABSENT: scripts/assert-dast-reports.mjs must exist before refusals count');
  for (const name of COMPANIONS) assert.ok(existsSync(path.join(ROOT, name)), `PREREQUISITE_MISSING: ${name}`);
  // Policy is copied unchanged. These literal pins came from retained public source receipts,
  // not the implementation's exported parser or a mutable operator configuration.
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, 'scripts/dast/policy.json'), 'utf8')), PINNED, 'PREREQUISITE_POLICY: frozen schema/pins differ');
  const parent = path.join(ROOT, '.workflow/state'); mkdirSync(parent, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(parent, 'dast-reports-'))), project = path.join(outer, 'project');
  try {
    for (const name of COMPANIONS) { mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); copyFileSync(path.join(ROOT, name), path.join(project, name)); }
    const dir = path.join(project, '.workflow/proofs/dast', ID); mkdirSync(dir, { recursive: true });
    const f = { outer, project, dir, checker: path.join(project, COMPANIONS[0]), sibling: path.join(outer, 'sibling') };
    mkdirSync(f.sibling); writeFileSync(path.join(f.sibling, 'sentinel.txt'), SENTINEL);
    const b = bundle(hash(readFileSync(path.join(project, 'scripts/dast/zap-completion.py'))), kind, platform);
    mutate(b); writeBundle(dir, b); after(f, b);
    const before = snapshot(outer); run(f, b); assert.deepEqual(snapshot(outer), before, 'CLI must not change any fixture or sibling file');
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function invoke(f, args = [f.dir]) {
  const result = spawnSync(process.execPath, [f.checker, ...args], { cwd: f.project, env: {}, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
  assert.equal(result.stderr, '', 'No loader stack or raw refusal diagnostic may escape');
  assert.ok(Buffer.byteLength(result.stdout) <= 4096, 'Verdict exceeds fixed output cap');
  assert.match(result.stdout, /^\{[^\r\n]*\}\n$/, 'One compact JSON verdict is required');
  assert.doesNotMatch(result.stdout, /DO_NOT_EMIT_SYNTHETIC|MODULE_NOT_FOUND|Cannot find module|\u001b|::error::/);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema_version, 1); assert.equal(typeof value.scan_complete, 'boolean');
  assert.ok(value.run_id === null || value.run_id === ID);
  assert.notEqual(value.reason, 'internal', 'A fixture case cannot pass on an internal checker error');
  return { status: result.status, value };
}
function pass(result) { assert.equal(result.status, 0); assert.equal(result.value.verdict, 'PASS'); assert.equal(result.value.reason, 'ok'); assert.equal(result.value.scan_complete, true); }
function refuse(result, reasons) {
  assert.equal(result.status, 1); assert.equal(result.value.verdict, 'INDETERMINATE');
  assert.ok([reasons].flat().includes(result.value.reason), `Expected ${reasons}, got ${result.value.reason}`);
}
function edit(f, name, change) {
  const file = path.join(f.dir, name), value = JSON.parse(readFileSync(file, 'utf8')); change(value); rewrite(f, name, json(value));
}
function rewrite(f, name, raw) {
  writeFileSync(path.join(f.dir, name), raw);
  if (name !== 'run.json') edit(f, 'run.json', value => { value.artifacts[name] = { bytes: raw.length, sha256: hash(raw) }; });
}
function rewriteBoundZap(f, raw) {
  rewrite(f, 'zap.json', raw);
  edit(f, 'zap-completion.json', value => { value.report_sha256 = hash(raw); value.report_bytes = raw.length; });
}
const addFindings = (b, list) => { b.findings = list; for (const item of b.stats) item.matched = String(list.length); };

test('complete empty native report passes with real zero counts and safe >2^53 monotonic strings', () => fixture(f => {
  const r = invoke(f); pass(r); assert.deepEqual(r.value.nuclei.counts, { info: 0, low: 0, medium: 0, high: 0, critical: 0 });
  assert.deepEqual(r.value.zap.alerts, { 0: 0, 1: 0, 2: 0, 3: 0 }); assert.equal(r.value.nuclei.engine_units, 23);
  assert.equal(r.value.nuclei.observed_http_requests, null); assert.equal(r.value.zap.url_count, 2);
}));
test('fixed ARM64 pins and relative run path are admitted without assuming imageID equals manifest', () => fixture(f => pass(invoke(f, [path.relative(f.project, f.dir)])), { platform: 'linux/arm64' }));
test('native ZAP coverage may retain its observed bare origin alongside docs and slash', () => fixture(f => {
  const r = invoke(f); pass(r); assert.equal(r.value.zap.url_count, 3);
}, { mutate: b => { b.completion.urls.unshift(ORIGIN); } }));
test('native established TCP tails admit ssthresh minus-one only in its documented field', () => {
  for (const family of ['tcp', 'tcp6']) {
    const address = family === 'tcp' ? '0100007F' : '0000000000000000FFFF00000100007F';
    const row = `9: ${address}:C001 ${address}:46A0 01 00000000:00000000 01:00000019 00000000 1000 0 54165785 4 cd1e6040 25 4 27 3 -1\n`;
    fixture(f => pass(invoke(f)), { mutate: b => { b.isolation.observations[0].socket_tables[family] += row; } });
    fixture(f => refuse(invoke(f), 'isolation'), { mutate: b => {
      b.isolation.observations[0].socket_tables[family] += row.replace(' 1000 0 ', ' -1 0 ').replace(' 3 -1\n', ' 3 1\n');
    } });
  }
});
test('engine completion is self-consistent, not hardcoded to the control fixture 23 units', () => fixture(f => {
  const r = invoke(f); pass(r); assert.equal(r.value.nuclei.engine_units, 24); assert.equal(r.value.nuclei.engine_total, 24);
}, { mutate: b => b.stats.forEach(s => { s.requests = s.total = '24'; }) }));
test('actual Git medium plus ZAP info/low/medium remain visible with warning exit2', () => fixture(f => {
  const r = invoke(f); pass(r); assert.equal(r.value.nuclei.counts.medium, 1);
  assert.deepEqual(r.value.zap.alerts, { 0: 1, 1: 1, 2: 1, 3: 0 }); assert.equal(r.value.zap.instances['2'], 2);
}, { mutate: b => { addFindings(b, [finding()]); b.zap.site[0].alerts = ['0', '1', '2'].map(r => alert(r)); b.run.stages.zap.exit_code = 2; } }));
test('completed native high findings refuse while retaining counts and scan_complete', () => {
  for (const which of ['nuclei', 'zap']) fixture(f => { const r = invoke(f); refuse(r, 'high_finding'); assert.equal(r.value.scan_complete, true); },
    { mutate: b => { if (which === 'nuclei') addFindings(b, [finding('laravel-env')]); else b.zap.site[0].alerts = [alert('3', '10062')]; } });
});
test('positive-control kind needs both actual pinned Nuclei detections and ZAP10062 high and cannot PASS', () => {
  fixture(f => { const r = invoke(f); refuse(r, 'high_finding'); assert.equal(r.value.scan_complete, true); }, { kind: 'positive_control', mutate: b => {
    addFindings(b, [finding('laravel-env'), finding()]); b.zap.site[0].alerts = [alert('3', '10062')]; } });
  fixture(f => refuse(invoke(f), 'control_missing_detection'), { kind: 'positive_control' });
});
test('pinned template severity cannot be downgraded, swapped or expanded', () => {
  for (const severity of ['low', 'medium', 'critical', 'unknown']) fixture(f => refuse(invoke(f), 'report'), {
    mutate: b => { const x = finding('laravel-env'); x.info.severity = severity; addFindings(b, [x]); } });
});
test('nonzero matched with empty JSONL and dropped high behind a medium record are incomplete', () => {
  for (const remaining of [[], [finding()]]) fixture(f => refuse(invoke(f), 'completion'), { mutate: b => {
    b.findings = remaining; b.stats.forEach(s => { s.matched = '2'; }); } });
});
test('zero-byte findings need their actual report file and both completed statistics', () => {
  fixture(f => refuse(invoke(f), 'input'), { after: f => rmSync(path.join(f.dir, 'nuclei.jsonl')) });
  fixture(f => refuse(invoke(f), 'completion'), { mutate: b => { b.stats = []; } });
});
test('missing reports or hook receipts refuse independently of claimed terminal success', () => {
  for (const name of ['zap.json', 'zap-before-report.json', 'zap-completion.json']) fixture(f => refuse(invoke(f), 'input'), { after: f => rmSync(path.join(f.dir, name)) });
});
test('malformed UTF8/JSON/native JSONL cannot pass or leak source text', () => {
  for (const [name, raw] of [['zap.json', Buffer.from('{'+SENTINEL)], ['nuclei.jsonl', Buffer.from([0xff])],
    ['nuclei.jsonl', Buffer.from(JSON.stringify(finding())+'\n\n')]]) fixture(f => refuse(invoke(f), ['input', 'report']), { after: f => name === 'zap.json' ? rewriteBoundZap(f, raw) : rewrite(f, name, raw) });
});
test('LF/CRLF and optional final terminator preserve valid JSONL counts', () => {
  for (const ending of ['', '\r\n']) fixture(f => { const r = invoke(f); pass(r); assert.equal(r.value.nuclei.counts.medium, 1); }, {
    mutate: b => addFindings(b, [finding()]), after: f => rewrite(f, 'nuclei.jsonl', Buffer.from(JSON.stringify(finding()) + ending)) });
});
test('native statistics require exact fields, types, two snapshots and completed counters', () => {
  for (const mutate of [b => { b.stats.pop(); }, b => { b.stats.push(clone(b.stats[0])); },
    b => { b.stats[0].templates = '1'; }, b => { b.stats[0].hosts = '2'; }, b => { b.stats[0].requests = '22'; },
    b => { b.stats[0].errors = '1'; }, b => { b.stats[0].percent = '99'; }, b => { b.stats[0].total = 23; },
    b => { b.stats[0].startedAt = at(1); }, b => { b.stats[0].duration = 'invalid'; }])
    fixture(f => refuse(invoke(f), 'completion'), { mutate });
});
test('request-error log or native error diagnostic refuses despite completed counters', () => {
  fixture(f => refuse(invoke(f), 'completion'), { mutate: b => { b.errors = SENTINEL; } });
  fixture(f => refuse(invoke(f), 'completion'), { after: f => rewrite(f, 'nuclei.stderr.log', Buffer.concat([readFileSync(path.join(f.dir, 'nuclei.stderr.log')), Buffer.from('[ERR] '+SENTINEL+'\n')])) });
});
test('nonzero queue, absent event, changed prefix or unordered monotonic string refuses', () => {
  for (const mutate of [b => { b.completion.events[4].queue = '1'; }, b => { b.before.events[3].queue = '1'; },
    b => { b.completion.events.splice(2, 1); }, b => { b.completion.events[1].target = ORIGIN+'/other'; },
    b => { b.completion.events[4].monotonic_ns = b.completion.events[3].monotonic_ns; },
    b => { b.completion.events[4].monotonic_ns = 5; }]) fixture(f => refuse(invoke(f), 'completion'), { mutate });
});
test('ZAP requires scoped URLs, enabled required rule and exact report byte binding', () => {
  for (const mutate of [b => { b.completion.urls = []; }, b => { b.completion.rules[0].enabled = 'false'; }]) fixture(f => refuse(invoke(f), 'completion'), { mutate });
  fixture(f => refuse(invoke(f), ['binding', 'completion']), { after: f => edit(f, 'zap-completion.json', x => { x.report_sha256 = '0'.repeat(64); }) });
});
test('every report and receipt target rejects external, provider and scanner origins', () => {
  for (const host of ['https://example.com', 'http://127.0.0.1:18081', 'http://127.0.0.1:18090']) {
    for (const place of ['nuclei', 'site', 'instance', 'coverage']) fixture(f => refuse(invoke(f), 'scope'), { mutate: b => {
      if (place === 'nuclei') { const x = finding(); x['matched-at'] = host+'/x'; addFindings(b, [x]); }
      if (place === 'site') b.zap.site[0]['@name'] = host;
      if (place === 'instance') { b.zap.site[0].alerts = [alert()]; b.zap.site[0].alerts[0].instances[0].uri = host+'/x'; }
      if (place === 'coverage') b.completion.urls.push(host+'/x');
    } });
  }
});
test('unknown ZAP risk, wrong count type, count mismatch and malformed instances refuse', () => {
  for (const mutateAlert of [a => { a.riskcode = '4'; }, a => { a.count = 2; }, a => { a.count = '1'; }, a => { a.instances = 'not-array'; }])
    fixture(f => refuse(invoke(f), 'report'), { mutate: b => { const a = alert(); mutateAlert(a); b.zap.site[0].alerts = [a]; } });
});
test('artifact hashes, run identity, hook identity and committed source pins cannot drift', () => {
  for (const mutate of [b => { b.prepared.images.node.ref = 'node:latest'; }, b => { b.prepared.templates.git_config_sha256 = '0'.repeat(64); },
    b => { b.prepared.zap_common_sha256 = '0'.repeat(64); }, b => { b.completion.run_id = 'mr21-dast-'+'b'.repeat(32); },
    b => { b.before.hook_sha256 = '0'.repeat(64); }, b => { b.run.nuclei_runtime.ignore_after_sha256 = '0'.repeat(64); }])
    fixture(f => refuse(invoke(f), 'binding'), { mutate });
  fixture(f => refuse(invoke(f), 'binding'), { after: f => writeFileSync(path.join(f.dir, 'nuclei.jsonl'), JSON.stringify(finding())+'\n') });
});
test('native failures, signal, deadline and overflow refuse without fabricating scan success', () => {
  for (const [stage, key, value] of [['nuclei', 'exit_code', 1], ['zap', 'exit_code', 3], ['zap', 'signal', 'SIGTERM'],
    ['nuclei', 'timed_out', true], ['zap', 'output_overflow', true]]) fixture(f => refuse(invoke(f), 'terminal'), { mutate: b => { b.run.stages[stage][key] = value; } });
});
test('stale report timestamps and reversed stage order refuse', () => {
  fixture(f => refuse(invoke(f), ['binding', 'report']), { mutate: b => { const x = finding(); x.timestamp = at(1); addFindings(b, [x]); } });
  fixture(f => refuse(invoke(f), 'binding'), { mutate: b => { b.run.stages.zap.started_at = at(9); } });
});
test('dead proxy, wrong reply, missing or failed post-health retain completed scan counts', () => {
  for (const mutate of [b => { b.run.health[4].proxy_alive = false; }, b => { b.run.health[4].answer = SENTINEL; },
    b => { b.run.health.pop(); }, b => { b.run.health[4].health_status = 503; }, b => { b.run.health[2].proxy_pid = 99; }])
    fixture(f => { const r = invoke(f); refuse(r, 'health'); assert.equal(r.value.scan_complete, true); }, { mutate });
});
test('provider chain and actual capture counts must stay exactly0 through5', () => {
  for (const mutate of [b => { b.run.health[0].provider_before = 1; }, b => { b.run.health[2].provider_before = 1; },
    b => { b.run.health[3].provider_rejected = 1; }, b => { b.run.health[4].capture.turns = 1; },
    b => { b.run.health[4].capture.input_tokens = 23; }]) fixture(f => refuse(invoke(f), 'health'), { mutate });
});
test('Docker authority, engine identity, bind mount and namespace declarations must match fixed policy', () => {
  for (const mutate of [b => { b.isolation.docker.anchor.host.network_mode = 'host'; }, b => { b.isolation.docker.zap.host.privileged = true; },
    b => { b.isolation.docker.anchor.image = b.prepared.images.node.ref.split('@')[1]; },
    b => { b.isolation.docker.anchor.mounts[0].read_only = false; },
    b => { b.isolation.docker.zap.mounts.push(bind('operator', '/var/run/docker.sock', false)); },
    b => { b.isolation.observations[1].namespace = 'net:[999]'; }]) fixture(f => refuse(invoke(f), 'isolation'), { mutate });
});
test('all projected Docker authority fields must be present and null or empty', () => {
  for (const key of ['cap_add', 'devices', 'device_requests', 'device_cgroup_rules', 'volumes_from']) {
    for (const absent of [false, true]) fixture(f => refuse(invoke(f), 'isolation'), { mutate: b => {
      if (absent) delete b.isolation.docker.anchor.host[key];
      else b.isolation.docker.anchor.host[key] = ['synthetic-unexpected-authority'];
    } });
  }
  fixture(f => pass(invoke(f)), { mutate: b => {
    for (const host of [b.isolation.docker.anchor.host, b.isolation.docker.zap.host])
      for (const key of ['cap_add', 'devices', 'device_requests', 'device_cgroup_rules', 'volumes_from']) host[key] = [];
  } });
});
test('finite network admission rejects capability/address/route and live listener substitutions', () => {
  for (const mutate of [b => { b.isolation.observations[0].network.security.CapEff = '1'; },
    b => { b.isolation.observations[0].network.interfaces[0].primary_ipv4 = '10.0.0.1'; },
    b => { b.isolation.observations[0].network.routes4_raw += 'eth0 00000000 0100000A 0003 0 0 0 00000000 0 0 0\n'; },
    b => { b.isolation.observations[1].socket_tables = sockets([18080, 18081, 9092]); },
    b => { b.isolation.observations[3].socket_tables.tcp = b.isolation.observations[3].socket_tables.tcp.replace('0100007F', '00000000'); },
    b => { b.isolation.observations.pop(); }]) fixture(f => refuse(invoke(f), 'isolation'), { mutate });
});
test('an exact optional inert kernel device passes but UP, linked or unknown devices refuse', () => {
  fixture(f => pass(invoke(f)), { mutate: b => b.isolation.observations.filter(o => o.network).forEach(o => inertTunnel(o.network)) });
  for (const fault of ['up', 'linked', 'unknown']) fixture(f => refuse(invoke(f), 'isolation'), { mutate: b => {
    const n = b.isolation.observations[0].network; inertTunnel(n); const device = n.interfaces[1];
    if (fault === 'up') { device.flags = 129; device.flags_sysfs = '0x81'; device.admin_up = true; }
    if (fault === 'linked') device.iflink_sysfs = '1';
    if (fault === 'unknown') { device.name = 'eth0'; n.if_nameindex[1][1] = 'eth0'; n.sysfs_entries[1] = 'eth0'; }
  } });
});
test('positive-control path scope and app-kind relabel cannot invent application readiness', () => {
  fixture(f => refuse(invoke(f), ['scope', 'health']), { kind: 'positive_control', mutate: b => { b.run.control_health.paths.push('//example.com/x'); } });
  fixture(f => refuse(invoke(f), ['binding', 'health', 'isolation']), { kind: 'positive_control', mutate: b => { b.run.kind = 'application'; } });
});
test('leaf and ancestor redirects are refused without reading or changing the owned sibling', () => {
  for (const mode of ['leaf', 'ancestor']) fixture(f => refuse(invoke(f), 'input'), { after: f => {
    if (mode === 'leaf') { const target = path.join(f.sibling, 'foreign.json'); copyFileSync(path.join(f.dir, 'zap.json'), target); rmSync(path.join(f.dir, 'zap.json')); symlinkSync(target, path.join(f.dir, 'zap.json')); }
    else { const parent = path.dirname(f.dir), target = path.join(f.sibling, 'runs'); renameSync(parent, target); symlinkSync(target, parent); }
  } });
});
test('nonregular and multiply linked report inputs refuse without consuming alternate content', () => {
  for (const kind of ['directory', 'hardlink']) fixture(f => refuse(invoke(f), 'input'), { after: f => {
    const file = path.join(f.dir, 'zap.json');
    if (kind === 'directory') { rmSync(file); mkdirSync(file); }
    else linkSync(file, path.join(f.sibling, 'report.json'));
  } });
});
test('all three input size classes refuse cap-plus-one before parsing', () => {
  for (const [name, cap] of [['zap.json', 10*1024*1024], ['nuclei.stderr.log', 2*1024*1024], ['zap-completion.json', 256*1024]])
    fixture(f => refuse(invoke(f), 'input'), { after: f => rewrite(f, name, Buffer.alloc(cap+1, 32)) });
});
test('malformed sensitive/control bytes stay out of bounded verdict output', () => fixture(f => refuse(invoke(f), ['input', 'report']), {
  after: f => rewriteBoundZap(f, Buffer.from('{"secret":"'+SENTINEL+'\u001b[31m\n::error::raw"')) }));
test('wrong CLI arity and outside-owned-root directory refuse with inert usage/input verdicts', () => fixture(f => {
  for (const args of [[], [f.dir, 'extra']]) refuse(invoke(f, args), 'usage');
  refuse(invoke(f, [f.sibling]), 'input');
}));
