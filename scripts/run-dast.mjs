// specs/security/local-dast.md: fixed offline application scan and exact ownership.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadPrepared, sourceManifest, verifyImage } from './prepare-dast.mjs';
import { cleanupOwned, dockerContext, finalizeSummary, successful, writeJson } from './dast/owned-run.mjs';
import { assertDockerProjection, assertSnapshot } from './dast/isolation.mjs';
import { ReportFailure, readContained } from './dast/report-inputs.mjs';
import { evaluateRun } from './assert-dast-reports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ACTIVE = path.join(ROOT, '.workflow/state/dast-active-run.json');
const BASE = path.join(ROOT, '.workflow/proofs/dast');
const POLICY = JSON.parse(readFileSync(new URL('./dast/policy.json', import.meta.url), 'utf8'));
const ORIGIN = 'http://127.0.0.1:18080', SEED = ORIGIN + '/docs';
const utc = () => new Date().toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const fail = code => { throw new ReportFailure(code); };
const FILES = { 'prepared.json': 262144, 'isolation.json': 262144, 'nuclei.jsonl': 10485760, 'zap.json': 10485760,
  'nuclei.stdout.log': 2097152, 'nuclei.stderr.log': 2097152, 'nuclei-errors.log': 2097152,
  'zap.stdout.log': 2097152, 'zap.stderr.log': 2097152, 'zap-before-report.json': 262144, 'zap-completion.json': 262144 };
const EXPORTS = { ...FILES, 'supervisor.events.jsonl': 2097152, 'nuclei-stage.json': 262144, 'nuclei-live.json': 262144,
  'proxy.stdout.log': 2097152, 'proxy.stderr.log': 2097152 };
delete EXPORTS['prepared.json']; delete EXPORTS['isolation.json'];
const empty = (reason = 'internal', run_id = null, kind = null) => ({ schema_version: 1, run_id, kind,
  verdict: 'INDETERMINATE', reason, scan_complete: false,
  nuclei: { complete: false, counts: null, engine_units: null, engine_total: null, observed_http_requests: null },
  zap: { complete: false, alerts: null, instances: null, url_count: null } });
const terminal = result => Object.fromEntries(['started_at', 'finished_at', 'exit_code', 'signal', 'timed_out', 'output_overflow'].map(key => [key, result[key]]));
const fixedEnv = home => ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=' + home, 'TMPDIR=/tmp', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8'];
const nodeEnv = fixedEnv('/tmp');
const inert = "import signal,sys;signal.signal(signal.SIGTERM,lambda *_:sys.exit(0));signal.pause()";
const ZAP_OPTIONS = '-silent -Xmx512m -config extensions.extension(0).name=ExtensionOast ' +
  '-config extensions.extension(0).enabled=false -config extensions.extension(1).name=ExtensionHUD ' +
  '-config extensions.extension(1).enabled=false';

function ordinaryDirectory(directory, mode = 0o700) {
  assert(directory.startsWith(ROOT + path.sep));
  let cursor = ROOT;
  assert(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink());
  for (const part of path.relative(ROOT, directory).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { const stat = lstatSync(cursor); assert(stat.isDirectory() && !stat.isSymbolicLink()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(cursor, { mode }); }
  }
}
function saveExclusive(file, value) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function readJSON(file, cap = 262144) { return parse(readContained(file, ROOT, cap)); }
function validateIntent(value, run_id) {
  assert(value.schema_version === 1 && value.run_id === run_id && /^mr21-dast-[0-9a-f]{32}$/.test(run_id));
  assert(['application', 'positive_control'].includes(value.kind) && Array.isArray(value.resources) && value.resources.length <= 2);
  const roles = new Set(), ids = new Set();
  for (const item of value.resources) {
    assert(['anchor', 'zap'].includes(item.role) && !roles.has(item.role)); roles.add(item.role);
    assert(item.run_id === run_id && item.name === run_id + '-' + item.role && typeof item.create_attempted === 'boolean');
    assert(item.id === null || typeof item.id === 'string' && /^[0-9a-f]{64}$/.test(item.id));
    assert(typeof item.removed === 'boolean' && (!item.removed || item.id !== null));
    if (item.id) { assert(!ids.has(item.id)); ids.add(item.id); }
  }
  return value;
}
function context(directory, intent, suffix) {
  const logs = path.join(directory, 'docker-' + suffix); ordinaryDirectory(logs);
  const docker = dockerContext(path.join(directory, 'cli-' + suffix), logs); let serial = 0;
  const call = (name, args, options) => docker.call(String(++serial).padStart(3, '0') + '-' + name, args, options);
  const save = () => writeJson(path.join(directory, 'intent.json'), intent);
  const inspect = async (id, label = 'inspect') => {
    const result = await call(label, ['inspect', id]); if (!successful(result)) fail('terminal');
    const rows = parse(result.stdout); assert(Array.isArray(rows) && rows.length === 1);
    return rows[0];
  };
  return { directory, intent, call, save, inspect };
}
function owns(info, item) {
  return info?.Id === item.id && info?.Config?.Labels?.['devops.dast.run'] === item.run_id &&
    info?.Config?.Labels?.['devops.dast.role'] === item.role;
}
async function recover(ctx) {
  let complete = true;
  for (const item of ctx.intent.resources) {
    if (item.removed || item.id || !item.create_attempted) continue;
    try {
      const result = await ctx.call('recover-' + item.role, ['inspect', item.name]);
      if (!successful(result)) {
        // A failed create is absent only with Docker's specific missing-object result.
        if (result.exit_code === 1 && !result.signal && !result.timed_out && !result.output_overflow && !result.aborted && !result.error &&
            result.stderr.toString('utf8').includes('No such object: ' + item.name)) continue;
        throw new Error();
      }
      const rows = parse(result.stdout); assert(Array.isArray(rows) && rows.length === 1);
      const info = rows[0]; assert(/^[0-9a-f]{64}$/.test(info.Id));
      assert(owns(info, { ...item, id: info.Id })); item.id = info.Id; ctx.save();
    } catch { complete = false; }
  }
  return complete;
}

// A fixed export changes permissions only on named, bounded, ordinary owned outputs.
// Host metadata/intent/config are outside the sole writable report mount.
const EXPORT_CODE = "const fs=require('node:fs'),out='/out/',caps=" + JSON.stringify(EXPORTS) + ";" +
  "for(const [name,cap] of Object.entries(caps)){const p=out+name;let s;try{s=fs.lstatSync(p)}catch(e){if(e.code==='ENOENT')continue;throw e}" +
  "if(!s.isFile()||s.nlink!==1||s.size>cap)throw Error('export');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);" +
  "try{const a=fs.fstatSync(fd);if(a.dev!==s.dev||a.ino!==s.ino||a.size!==s.size||a.nlink!==1)throw Error('export');fs.fchmodSync(fd,0o644)}finally{fs.closeSync(fd)}}";
async function exportReports(ctx, anchor) {
  const state = await ctx.inspect(anchor.id, 'export-state'); assert(owns(state, anchor));
  if (state.State.Running) {
    const result = await ctx.call('export-permissions', ['exec', '--user', '1000:1000', anchor.id,
      '/usr/bin/env', ...nodeEnv, '/usr/local/bin/node', '-e', EXPORT_CODE]);
    if (!successful(result)) fail('input');
  }
  for (const [name, cap] of Object.entries(EXPORTS)) {
    const input = path.join(ctx.directory, 'raw', name);
    try { const bytes = readContained(input, ROOT, cap); writeFileSync(path.join(ctx.directory, name), bytes, { mode: 0o600 }); }
    catch (error) { if (error.code === 'ENOENT' || !lstatExists(input)) continue; throw error; }
  }
}
function lstatExists(file) { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function phase(ctx, anchor, name, signal) {
  const result = await ctx.call('phase-' + name, ['exec', '--user', '1000:1000', anchor.id,
    '/usr/bin/env', ...nodeEnv, '/usr/local/bin/node', '/dast/proxy.mjs', 'phase', name],
  { timeoutMs: name === 'nuclei' ? 60000 : name === 'initial' ? 40000 : 30000, maxBytes: 65536, signal });
  if (!successful(result)) fail(name === 'nuclei' ? 'terminal' : 'health');
  const reply = parse(result.stdout);
  assert(reply.schema_version === 1 && reply.run_id === anchor.run_id && reply.phase === name && reply.ok === true);
  return reply.result;
}
function cleanupCallbacks(ctx) {
  return {
    inspect: id => ctx.inspect(id, 'cleanup-inspect'),
    async drain(item) {
      let okay = true; let state = await ctx.inspect(item.id, 'drain-state'); assert(owns(state, item));
      if (state.State.Running && item.role === 'anchor' && ctx.intent.kind === 'application') {
        try { await phase(ctx, item, 'drain'); } catch { okay = false; }
      }
      try {
        const logs = await ctx.call('logs-' + item.role, ['logs', item.id]); if (!successful(logs)) okay = false;
        if (item.role === 'anchor') await exportReports(ctx, item);
        else if (state.State.Running && ctx.intent.baseline_started === true) {
          const read = "from pathlib import Path\nimport sys\nwith Path('/zap/zap.out').open('rb') as f: b=f.read(2097153)\nif len(b)>2097152: raise ValueError('limit')\nsys.stdout.buffer.write(b)";
          const log = await ctx.call('daemon-log', ['exec', '--user', '1000:1000', item.id, '/usr/bin/env', ...fixedEnv('/home/zap'), 'python3', '-c', read]);
          writeFileSync(path.join(ctx.directory, 'zap-daemon.log'), log.stdout, { mode: 0o600 });
          if (!successful(log)) okay = false;
        }
      } catch { okay = false; }
      if (state.State.Running) {
        const stopped = await ctx.call('stop-' + item.role, ['stop', '--time', '15', item.id], { timeoutMs: 20000 });
        if (!successful(stopped)) okay = false;
      }
      state = await ctx.inspect(item.id, 'stopped-state'); assert(owns(state, item));
      if (state.State.Running || state.State.OOMKilled || state.State.Error || state.State.ExitCode !== 0) okay = false;
      return { exit_code: okay ? 0 : 1, signal: null, timed_out: false, output_overflow: false };
    },
    async remove(id) {
      const result = await ctx.call('remove', ['rm', '-f', id]);
      if (successful(result) && result.stdout.toString('utf8').trim() !== id) return { ...result, exit_code: 1 };
      if (successful(result)) {
        const item = ctx.intent.resources.find(row => row.id === id); assert(item && !item.removed);
        // The separate Docker call receipt keeps the actual terminal result.
        // Only confirmed removal advances this durable remaining-resource ledger.
        item.removed = true; ctx.save();
      }
      return result;
    },
  };
}

// The always step can recover this one durable intent; it never enumerates Docker.
export async function cleanupCurrentRun() {
  try {
    if (!lstatExists(ACTIVE)) return { complete: true, resources: [] };
    const pointer = readJSON(ACTIVE, 1024); assert(Object.keys(pointer).sort().join(',') === 'run_id,schema_version' && pointer.schema_version === 1);
    assert(typeof pointer.run_id === 'string' && /^mr21-dast-[0-9a-f]{32}$/.test(pointer.run_id));
    const directory = path.join(BASE, pointer.run_id); const intent = validateIntent(readJSON(path.join(directory, 'intent.json')), pointer.run_id);
    const ctx = context(directory, intent, 'recovery-' + randomBytes(6).toString('hex'));
    const recovered = await recover(ctx);
    const cleanup = await cleanupOwned(intent.resources.filter(item => item.id && !item.removed).map(({ id, run_id, role }) => ({ id, run_id, role })), cleanupCallbacks(ctx));
    if (!recovered) cleanup.complete = false;
    writeJson(path.join(directory, 'recovery-cleanup.json'), cleanup);
    if (!lstatExists(path.join(directory, 'summary.json'))) writeJson(path.join(directory, 'summary.json'),
      finalizeSummary(empty('terminal', intent.run_id, intent.kind), cleanup));
    if (cleanup.complete) unlinkSync(ACTIVE);
    return cleanup;
  } catch { return { complete: false, resources: [] }; }
}

export async function runDast(kind = 'application') {
  if (!['application', 'positive_control'].includes(kind)) return empty('usage');
  const run_id = 'mr21-dast-' + randomBytes(16).toString('hex');
  let directory; let ctx; let pointerOwned = false; let gate = empty('internal', run_id, kind); let summary;
  const abort = new AbortController(); const stop = () => abort.abort();
  const deadline = setTimeout(stop, 600000); process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    const { stage, prepared, prepared_sha256, manifest } = loadPrepared();
    const arch = prepared.platform.split('/')[1], pin = POLICY.platforms[prepared.platform]; assert(pin);
    ordinaryDirectory(BASE); directory = path.join(BASE, run_id); mkdirSync(directory, { mode: 0o700 });
    const raw = path.join(directory, 'raw'); mkdirSync(raw, { mode: 0o777 }); chmodSync(raw, 0o777);
    const intent = { schema_version: 1, run_id, kind, prepared_sha256, resources: [] };
    saveExclusive(path.join(directory, 'intent.json'), intent);
    saveExclusive(ACTIVE, { schema_version: 1, run_id }); pointerOwned = true;
    ctx = context(directory, intent, 'run');
    const call = async (label, args, options = {}) => {
      const result = await ctx.call(label, args, { ...options, signal: abort.signal });
      if (!successful(result)) fail('terminal'); return result;
    };
    writeJson(path.join(directory, 'runner-sources.json'), sourceManifest(ROOT, ['scripts/run-dast.mjs', 'scripts/prepare-dast.mjs',
      'scripts/dast/owned-run.mjs', 'scripts/dast/isolation.mjs', 'scripts/dast/report-inputs.mjs', 'scripts/assert-dast-reports.mjs', 'scripts/dast/policy.json']));
    for (const name of ['prepared.json', 'source-manifest.json', 'checkout-manifest.json']) {
      const bytes = readContained(path.join(stage, name), ROOT, name === 'prepared.json' ? 262144 : 10485760);
      if (name === 'source-manifest.json') assert.deepEqual(parse(bytes), manifest);
      writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    if (kind === 'application') {
      const mountpoint = path.join(stage, 'runtime/data');
      assert(lstatSync(mountpoint).isDirectory() && !lstatSync(mountpoint).isSymbolicLink()); assert.equal(readdirSync(mountpoint).length, 0);
    }
    const configPath = path.join(directory, 'run-config.json');
    const config = { schema_version: 1, run_id, kind, prepared_sha256 };
    saveExclusive(configPath, config); chmodSync(configPath, 0o444); assert.deepEqual(readJSON(configPath, 1024), config);
    for (const tool of ['node', 'zap']) {
      const result = await call('image-' + tool, ['image', 'inspect', pin[tool].ref]);
      const configs = readContained(path.join(stage, tool + '-config.json'), ROOT, 1048576);
      assert.equal(digest(configs), pin[tool].config_sha256);
      const identity = verifyImage(parse(result.stdout)[0], pin[tool], parse(configs), arch); assert.deepEqual(identity, prepared.images[tool]);
    }
    const asset = (name, source, destination, readonly = true) => ({ name, source, destination, readonly });
    const common = [asset('dast_scripts', path.join(stage, 'dast'), '/dast'), asset('run_config', configPath, '/dast/run.json')];
    const anchorMounts = [...common, ...(kind === 'application' ? [asset('app_runtime', path.join(stage, 'runtime'), '/app/runtime'),
      asset('app_observability', path.join(stage, 'observability'), '/app/observability')] : [asset('positive_control', path.join(stage, 'control.mjs'), '/control.mjs')]),
    asset('nuclei_binary', path.join(stage, 'nuclei'), '/scanner/nuclei'),
    asset('laravel_env', path.join(stage, 'vendor/http/exposures/configs/laravel-env.yaml'), '/scanner/laravel-env.yaml'),
    asset('git_config', path.join(stage, 'vendor/http/exposures/configs/git-config.yaml'), '/scanner/git-config.yaml'),
    asset('nuclei_ignore', path.join(stage, 'vendor/.nuclei-ignore'), '/scanner/default-ignore.yaml'), asset('reports', raw, '/out', false)];
    const zapMounts = [...common, asset('zap_common', path.join(stage, 'zap_common.py'), '/zap/zap_common.py'), asset('reports', raw, '/zap/wrk', false)];
    const zapEnv = [...fixedEnv('/home/zap'), 'IS_CONTAINERIZED=true', 'JAVA_HOME=/usr/lib/jvm/java-17-openjdk-' + arch, 'PYTHONDONTWRITEBYTECODE=1'];
    const create = async (role, image, network, mounts, command, env) => {
      const item = { role, run_id, name: run_id + '-' + role, id: null, create_attempted: true, removed: false };
      intent.resources.push(item); ctx.save(); // Intent is durable before Docker mutates anything.
      const args = ['create', '--pull=never', '--name', item.name, '--label', 'devops.dast.run=' + run_id, '--label', 'devops.dast.role=' + role,
        '--platform', prepared.platform, '--network', network, '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '1536m', '--cpus', '2', '--pids-limit', '256', '--ipc', 'private', '--no-healthcheck', '--workdir', role === 'zap' ? '/zap' : '/tmp',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--entrypoint', '/usr/bin/env'];
      if (role === 'anchor') { args.push('--read-only'); if (kind === 'application') args.push('--tmpfs', '/app/runtime/data:rw,nosuid,nodev,size=32m,mode=1777'); }
      for (const mount of mounts) { assert(!mount.source.includes(',')); args.push('--mount', `type=bind,src=${mount.source},dst=${mount.destination}${mount.readonly ? ',readonly' : ''}`); }
      item.create_argv = [...args, image, ...env, ...command]; ctx.save();
      const result = await call('create-' + role, item.create_argv);
      const id = result.stdout.toString('utf8').trim(); assert.match(id, /^[0-9a-f]{64}$/); item.id = id; ctx.save();
      return item;
    };
    const anchor = await create('anchor', pin.node.ref, 'none', anchorMounts,
      ['/usr/local/bin/node', ...(kind === 'application' ? ['/dast/proxy.mjs', 'serve'] : ['/control.mjs'])], nodeEnv);
    const zap = await create('zap', pin.zap.ref, 'container:' + anchor.id, zapMounts, ['python3', '-c', inert], zapEnv);
    const projection = async (item, mounts) => {
      const info = await ctx.inspect(item.id, 'boundary-' + item.role); assert(owns(info, item));
      const host = info.HostConfig; assert.equal(host.Memory, 1536 * 1024 * 1024); assert.equal(host.NanoCpus, 2000000000); assert.equal(host.PidsLimit, 256);
      const actual = info.Mounts.filter(m => m.Type !== 'tmpfs'); assert.equal(actual.length, mounts.length);
      const mapped = actual.map(m => { const match = mounts.filter(a => a.destination === m.Destination); assert.equal(match.length, 1);
        const a = match[0]; assert.equal(m.Type, 'bind'); assert.equal(m.Source, a.source); assert.equal(m.RW, !a.readonly);
        return { type: m.Type, asset: a.name, destination: m.Destination, read_only: !m.RW }; });
      for (const m of info.Mounts.filter(m => m.Type === 'tmpfs')) assert(Object.hasOwn(host.Tmpfs, m.Destination));
      return { id: info.Id, image: info.Image, config: { user: info.Config.User }, host: {
        network_mode: host.NetworkMode, readonly_rootfs: host.ReadonlyRootfs, privileged: host.Privileged, cap_drop: host.CapDrop,
        cap_add: host.CapAdd, devices: host.Devices, device_requests: host.DeviceRequests, device_cgroup_rules: host.DeviceCgroupRules,
        volumes_from: host.VolumesFrom, security_opt: host.SecurityOpt, port_bindings: host.PortBindings, publish_all_ports: host.PublishAllPorts,
        extra_hosts: host.ExtraHosts, pid_mode: host.PidMode, ipc_mode: host.IpcMode, tmpfs: host.Tmpfs }, mounts: mapped };
    };
    const docker = { anchor: await projection(anchor, anchorMounts), zap: await projection(zap, zapMounts) };
    assertDockerProjection(docker, { kind, prepared, anchor_id: anchor.id, zap_id: zap.id });
    const started_at = utc();
    await call('start-anchor', ['start', anchor.id]); await call('start-zap', ['start', zap.id]);
    const health = []; let controlBefore;
    const controlHealth = async label => {
      const code = "const until=Date.now()+5000;for(;;){try{const r=await fetch('http://127.0.0.1:18080/docs',{redirect:'error',signal:AbortSignal.timeout(1000)});const b=await r.text();if(r.status!==200||b.length>65536||!b.includes('MR21 synthetic detector control'))throw Error();process.stdout.write(JSON.stringify({status:r.status,marker:'MR21 synthetic detector control'}));break}catch{if(Date.now()>=until)process.exit(1);await new Promise(r=>setTimeout(r,50))}}";
      return parse((await call(label, ['exec', '--user', '1000:1000', anchor.id, '/usr/bin/env', ...nodeEnv, '/usr/local/bin/node', '--input-type=module', '-e', code], { timeoutMs: 10000 })).stdout);
    };
    if (kind === 'application') health.push(await phase(ctx, anchor, 'initial', abort.signal)); else controlBefore = await controlHealth('control-before');
    const namespace = (await call('anchor-namespace', ['exec', '--user', '1000:1000', anchor.id, '/usr/bin/env', ...nodeEnv,
      '/usr/local/bin/node', '-e', "process.stdout.write(require('node:fs').readlinkSync('/proc/self/ns/net'))"])).stdout.toString('utf8');
    assert.match(namespace, /^net:\[[1-9][0-9]*\]$/);
    const observations = [];
    const observe = async name => {
      const until = Date.now() + (name === 'zap_after' ? 15000 : 1);
      for (;;) {
        const result = await call('observe-' + name, ['exec', '--user', '1000:1000', zap.id, '/usr/bin/env', ...zapEnv, 'python3', '/dast/inspect-network.py']);
        const observation = { ...parse(result.stdout), phase: name, container_id: zap.id };
        try { assertSnapshot(observation, { kind, namespace, phase: name, container_id: zap.id }); observations.push(observation); return; }
        catch (error) { if (name !== 'zap_after' || Date.now() >= until) throw error; await delay(100, undefined, { signal: abort.signal }); }
      }
    };
    if (kind === 'application') health.push(await phase(ctx, anchor, 'nuclei_before', abort.signal));
    await observe('nuclei_before');
    let nuclei;
    if (kind === 'application') nuclei = await phase(ctx, anchor, 'nuclei', abort.signal);
    else nuclei = parse((await call('control-nuclei', ['exec', '--user', '1000:1000', anchor.id, '/usr/bin/env', ...nodeEnv,
      '/usr/local/bin/node', '--input-type=module', '-e', "import {runNuclei} from '/dast/nuclei.mjs'; process.stdout.write(JSON.stringify(await runNuclei())+'\\n');"], { timeoutMs: 60000 })).stdout);
    assert.equal(nuclei.kind, 'nuclei');
    const live = { ...nuclei.live, phase: 'nuclei_live', container_id: anchor.id };
    assertSnapshot(live, { kind, namespace, phase: 'nuclei_live', container_id: anchor.id }); observations.push(live);
    if (kind === 'application') { health.push(await phase(ctx, anchor, 'nuclei_after', abort.signal)); health.push(await phase(ctx, anchor, 'zap_before', abort.signal)); }
    await observe('zap_before');
    intent.baseline_started = true; ctx.save();
    const zapResult = await ctx.call('baseline', ['exec', '--user', '1000:1000', zap.id, '/usr/bin/env', ...zapEnv,
      'python3', '/zap/zap-baseline.py', '--autooff', '-t', SEED, '-P', '18090', '-m', '1', '-T', '3', '-J', 'zap.json',
      '--hook', '/dast/zap-completion.py', '-z', ZAP_OPTIONS], { timeoutMs: 270000, signal: abort.signal });
    writeFileSync(path.join(directory, 'zap.stdout.log'), zapResult.stdout); writeFileSync(path.join(directory, 'zap.stderr.log'), zapResult.stderr);
    if (![0, 2].includes(zapResult.exit_code) || zapResult.signal || zapResult.timed_out || zapResult.output_overflow || zapResult.aborted || zapResult.error) fail('terminal');
    await exportReports(ctx, anchor);
    const completion = readJSON(path.join(directory, 'zap-completion.json')); const began = completion.events?.[0];
    assert(began?.event === 'started');
    const zapLive = { phase: 'zap_live', container_id: zap.id, namespace: began.namespace, socket_tables: began.socket_tables,
      started_at: began.utc, finished_at: began.utc };
    assertSnapshot(zapLive, { kind, namespace, phase: 'zap_live', container_id: zap.id }); observations.push(zapLive);
    await observe('zap_after');
    let control_health;
    if (kind === 'application') health.push(await phase(ctx, anchor, 'zap_after', abort.signal));
    else {
      const after = await controlHealth('control-after');
      const output = (await call('control-paths', ['logs', anchor.id])).stdout;
      const records = new TextDecoder('utf-8', { fatal: true }).decode(output).trim().split('\n').map(line => JSON.parse(line));
      assert(records.length <= 4098 && records[0]?.event === 'ready' && records.slice(1).every(r => r.event === 'request' && typeof r.path === 'string'));
      control_health = { before: controlBefore, after, paths: records.slice(1).map(r => r.path) };
    }
    for (const item of [anchor, zap]) { const info = await ctx.inspect(item.id, 'final-state'); assert(owns(info, item) && info.State.Running && !info.State.OOMKilled && !info.State.Error); }
    await exportReports(ctx, anchor);
    const isolation = { schema_version: 1, run_id, kind, prepared_sha256, anchor_id: anchor.id, namespace, docker, observations };
    writeJson(path.join(directory, 'isolation.json'), isolation);
    const artifacts = Object.fromEntries(Object.entries(FILES).map(([name, cap]) => {
      const bytes = readContained(path.join(directory, name), ROOT, cap); return [name, { bytes: bytes.length, sha256: digest(bytes) }];
    }));
    writeJson(path.join(directory, 'run.json'), { schema_version: 1, run_id, kind, platform: prepared.platform, origin: ORIGIN, seed: SEED,
      started_at, finished_at: utc(), prepared_sha256, artifacts, stages: { nuclei: nuclei.stage, zap: terminal(zapResult) },
      containers: { anchor_id: anchor.id, zap_id: zap.id, namespace }, nuclei_runtime: nuclei.nuclei_runtime, health, ...(control_health ? { control_health } : {}) });
    if (abort.signal.aborted) fail('terminal');
    gate = evaluateRun(directory);
  } catch (error) { gate = empty(error instanceof ReportFailure ? error.code : 'internal', run_id, kind); }
  finally {
    clearTimeout(deadline);
    let recovered = true;
    if (ctx) recovered = await recover(ctx);
    const cleanup = await cleanupOwned(ctx ? ctx.intent.resources.filter(item => item.id && !item.removed).map(({ id, run_id, role }) => ({ id, run_id, role })) : [],
      ctx ? cleanupCallbacks(ctx) : { inspect: async () => null, drain: async () => null, remove: async () => null });
    if (!recovered) cleanup.complete = false;
    summary = finalizeSummary(gate, cleanup);
    if (pointerOwned && cleanup.complete) {
      try { unlinkSync(ACTIVE); } catch { cleanup.complete = false; summary = finalizeSummary(gate, cleanup); }
    }
    if (directory) { try { writeJson(path.join(directory, 'summary.json'), summary); } catch { summary = { ...summary, verdict: 'INDETERMINATE', reason: 'input' }; } }
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const summary = process.argv.length !== 2 || process.env.DAST_TARGET !== SEED ? empty('usage') : await runDast();
  process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
