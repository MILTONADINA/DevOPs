#!/usr/bin/env node
// specs/security/local-dast.md REQ-1: online, owned preparation; no scans.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupOwned, dockerContext, executable, runCommand, successful, writeJson } from './dast/owned-run.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const POLICY = JSON.parse(readFileSync(new URL('./dast/policy.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sourceManifest(path.dirname(file), [path.basename(file)]).files[0].sha256;
const SCRIPTS = ['proxy.mjs', 'nuclei.mjs', 'report-inputs.mjs', 'inspect-network.py', 'zap-completion.py', 'policy.json'];
const POINTER = path.join(ROOT, '.workflow/state/dast-prepared.json');
const PREPARING = path.join(ROOT, '.workflow/state/dast-preparing.json');
const empty = value => value == null || Array.isArray(value) && value.length === 0;
const noPorts = value => value == null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
const generation = value => typeof value === 'string' && value.length === 42 && /^mr21-prep-[0-9a-f]{32}$/.test(value);

function ordinaryParents(file) {
  for (let parent = path.dirname(file);; parent = path.dirname(parent)) {
    const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected source');
    if (parent === path.dirname(parent)) break;
  }
}

function ensureStateDirectory() {
  ordinaryParents(path.join(ROOT, 'owned-state-parent'));
  let directory = ROOT;
  for (const name of ['.workflow', 'state']) {
    directory = path.join(directory, name);
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(directory, { mode: 0o700 }); stat = lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected state directory');
  }
}

function metadataBytes(file, limit) {
  ordinaryParents(file);
  const before = lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('Invalid metadata');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const same = stat => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.nlink === 1 &&
    stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  try {
    if (!same(fstatSync(fd))) throw new Error('Changed metadata');
    const parts = [], chunk = Buffer.alloc(65536); let total = 0, amount;
    while ((amount = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - total), null)) > 0) {
      total += amount; if (total > limit || total > before.size) throw new Error('Changed metadata');
      parts.push(Buffer.from(chunk.subarray(0, amount)));
    }
    if (total !== before.size || !same(fstatSync(fd)) || !same(lstatSync(file))) throw new Error('Changed metadata');
    return Buffer.concat(parts);
  } finally { closeSync(fd); }
}

const metadata = (file, limit = 256 * 1024) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes(file, limit)));

function preparingPointer() {
  let value;
  try { value = metadata(PREPARING); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.deepEqual(Object.keys(value).sort(), ['complete', 'generation']);
  assert(generation(value.generation) && typeof value.complete === 'boolean');
  return value;
}

export function sourceManifest(root, paths) {
  const files = [], seen = new Set();
  root = path.resolve(root);
  if (!Array.isArray(paths) || paths.length > 25000) throw new Error('Invalid source list');
  for (const name of [...paths].sort()) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.isAbsolute(name) ||
        path.posix.normalize(name) !== name || name === '..' || name.startsWith('../') || seen.has(name)) throw new Error('Invalid source path');
    seen.add(name);
    const file = path.join(root, name); ordinaryParents(file);
    const before = lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) throw new Error('Invalid source file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const same = stat => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino &&
      stat.size === before.size && stat.nlink === 1 && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    try {
      if (!same(fstatSync(fd))) throw new Error('Changed source');
      const hash = createHash('sha256'), chunk = Buffer.alloc(65536); let bytes = 0, amount;
      while ((amount = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        bytes += amount; if (bytes > before.size) throw new Error('Changed source'); hash.update(chunk.subarray(0, amount));
      }
      if (bytes !== before.size || !same(fstatSync(fd)) || !same(lstatSync(file))) throw new Error('Changed source');
      files.push({ path: name, bytes, sha256: hash.digest('hex') });
    } finally { closeSync(fd); }
  }
  return { files, sha256: digest(JSON.stringify(files)) };
}

function walk(root, prefix = '') {
  const names = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    // npm's executable aliases are unused: the entry is the named tsx CLI file.
    if (entry.isDirectory() && entry.name === '.bin' && name.includes('node_modules/')) continue;
    if (entry.isDirectory()) names.push(...walk(root, name));
    else { if (!entry.isFile()) throw new Error('Redirected source tree'); names.push(name); }
    if (names.length > 25000) throw new Error('Source tree exceeds bound');
  }
  return names;
}

function copy(source, destination) {
  const before = hashFile(source); mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination); assert.equal(hashFile(destination), before);
}

async function download(url, cap, headers = {}, cancelled) {
  const approved = new Set(['github.com', 'release-assets.githubusercontent.com', 'ghcr.io', 'registry-1.docker.io',
    'auth.docker.io', 'pkg-containers.githubusercontent.com', 'production.cloudfront.docker.com']);
  const allowed = new Set(readFileSync(path.join(ROOT, '.workflow/network-allowlist.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')));
  const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(cancelled ? [cancelled] : [])]);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(url);
    assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.hash &&
      approved.has(parsed.hostname) && allowed.has(parsed.hostname), 'Unapproved artifact authority');
    const response = await fetch(parsed, { headers, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel(); assert(location, 'Missing redirect');
      const next = new URL(location, parsed);
      if (next.origin !== parsed.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'));
      url = next.href; continue;
    }
    assert.equal(response.status, 200, 'Artifact request failed');
    const parts = []; let size = 0;
    try {
      for await (const part of response.body) { size += part.length; assert(size <= cap, 'Artifact exceeds bound'); parts.push(part); }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return Buffer.concat(parts);
  }
  throw new Error('Artifact redirect limit');
}

async function imageMetadata(tool, pin, output, signal) {
  const repository = tool === 'node' ? 'library/node' : 'zaproxy/zaproxy';
  const registry = tool === 'node' ? 'registry-1.docker.io' : 'ghcr.io';
  const auth = tool === 'node' ? 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' :
    'https://ghcr.io/token?service=ghcr.io&scope=repository:zaproxy/zaproxy:pull';
  const authData = JSON.parse((await download(auth, 65536, {}, signal)).toString('utf8'));
  const token = authData.token ?? authData.access_token; assert(typeof token === 'string' && token.length < 16384);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' };
  const raw = await download(`https://${registry}/v2/${repository}/manifests/${pin.ref.split('@')[1]}`, 1024 * 1024, headers, signal);
  assert.equal(digest(raw), pin.ref.split('sha256:')[1]); const manifest = JSON.parse(raw);
  assert.equal(manifest.config.digest, 'sha256:' + pin.config_sha256);
  const config = await download(`https://${registry}/v2/${repository}/blobs/${manifest.config.digest}`, 1024 * 1024, headers, signal);
  assert.equal(config.length, manifest.config.size); assert.equal(digest(config), pin.config_sha256);
  writeFileSync(path.join(output, tool + '-manifest.json'), raw, { flag: 'wx' });
  writeFileSync(path.join(output, tool + '-config.json'), config, { flag: 'wx' });
  return JSON.parse(config);
}

export function verifyImage(image, pin, config, arch) {
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, arch);
  assert.equal(config.os, 'linux'); assert.equal(config.architecture, arch);
  assert(image.RepoDigests.includes(pin.ref));
  if (image.Descriptor) assert.equal(image.Descriptor.digest, pin.ref.split('@')[1]);
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  for (const [key, value] of Object.entries(config.config)) assert.deepEqual(image.Config[key], value);
  for (const key of ['User', 'WorkingDir']) assert.equal(image.Config[key] ?? '', config.config[key] ?? '');
  assert.equal(image.RootFS.Type, config.rootfs.type); assert.deepEqual(image.RootFS.Layers, config.rootfs.diff_ids);
  return { ref: pin.ref, engine_id: image.Id, config_sha256: pin.config_sha256 };
}

export function loadPrepared() {
  const pointer = metadata(POINTER);
  assert(generation(pointer.generation));
  const stage = path.join(ROOT, '.workflow/state', pointer.generation);
  const preparedBytes = metadataBytes(path.join(stage, 'prepared.json'), 256 * 1024);
  assert.equal(digest(preparedBytes), pointer.prepared_sha256);
  const prepared = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(preparedBytes));
  const manifest = metadata(path.join(stage, 'source-manifest.json'), 10 * 1024 * 1024);
  const actual = sourceManifest(stage, manifest.files.map(item => item.path));
  assert.deepEqual(actual, manifest); assert.equal(actual.sha256, prepared.source_manifest_sha256);
  // A changed checkout requires a fresh preparation, even if an old stage is intact.
  const checkoutBytes = metadataBytes(path.join(stage, 'checkout-manifest.json'), 10 * 1024 * 1024);
  const boundCheckout = manifest.files.find(item => item.path === 'checkout-manifest.json');
  assert(boundCheckout && boundCheckout.sha256 === digest(checkoutBytes) && boundCheckout.bytes === checkoutBytes.length);
  const sources = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkoutBytes));
  assert.deepEqual(sourceManifest(ROOT, sources.files.map(item => item.path)), sources);
  return { stage, prepared, prepared_sha256: pointer.prepared_sha256, manifest };
}

function validateIntent(intent, run_id) {
  assert.deepEqual(Object.keys(intent).sort(), ['pending', 'resources', 'run_id']);
  assert.equal(intent.run_id, run_id);
  assert(Array.isArray(intent.resources) && intent.resources.length <= 2);
  const roles = new Set(), ids = new Set();
  for (const resource of intent.resources) {
    assert.deepEqual(Object.keys(resource).sort(), ['id', 'role', 'run_id']);
    assert.equal(resource.run_id, run_id);
    assert(['dependencies', 'source'].includes(resource.role) && !roles.has(resource.role));
    assert(typeof resource.id === 'string' && resource.id.length === 64 && /^[0-9a-f]{64}$/.test(resource.id) && !ids.has(resource.id));
    roles.add(resource.role); ids.add(resource.id);
  }
  if (intent.pending !== null) {
    assert.deepEqual(Object.keys(intent.pending).sort(), ['name', 'role']);
    assert(['dependencies', 'source'].includes(intent.pending.role) && !roles.has(intent.pending.role));
    assert.equal(intent.pending.name, run_id + '-' + intent.pending.role);
  }
}

async function cleanupIntent(docker, intent, save) {
  validateIntent(intent, intent.run_id);
  if (intent.pending) {
    try {
      const recovered = await docker.call('recover-create', ['inspect', intent.pending.name]);
      if (successful(recovered)) {
        const actual = JSON.parse(recovered.stdout)[0];
        if (actual.Name === '/' + intent.pending.name && actual.Config?.Labels?.['devops.dast.run'] === intent.run_id &&
            actual.Config.Labels['devops.dast.role'] === intent.pending.role && typeof actual.Id === 'string' &&
            actual.Id.length === 64 && /^[0-9a-f]{64}$/.test(actual.Id)) {
          intent.resources.push({ id: actual.Id, run_id: intent.run_id, role: intent.pending.role });
          intent.pending = null; save();
        }
      }
    } catch { /* Unknown creation outcome remains pending and incomplete. */ }
  }
  const inspected = new Map();
  const cleanup = await cleanupOwned(intent.resources, {
    inspect: async id => {
      const result = await docker.call('cleanup-inspect-' + id, ['inspect', id]);
      assert(successful(result)); const actual = JSON.parse(result.stdout)[0]; inspected.set(id, actual); return actual;
    },
    drain: resource => inspected.get(resource.id)?.State.Running === false ? { exit_code: 0, signal: null } :
      docker.call('cleanup-stop-' + resource.id, ['stop', '--time', '5', resource.id]),
    remove: async id => {
      const result = await docker.call('cleanup-remove-' + id, ['rm', '-f', id]);
      if (!successful(result) || result.stdout.toString('utf8').trim() !== id) return { ...result, error: 'remove' };
      // Persist each confirmed removal before processing any further resource.
      intent.resources = intent.resources.filter(resource => resource.id !== id); save();
      return result;
    },
  });
  if (intent.pending || intent.resources.length) cleanup.complete = false;
  return cleanup;
}

export async function cleanupPreparing() {
  try {
    const pointer = preparingPointer();
    if (!pointer || pointer.complete) return { complete: true, resources: [] };
    const logs = path.join(ROOT, '.workflow/proofs/dast', pointer.generation);
    const intentFile = path.join(logs, 'intent.json'), intent = metadata(intentFile);
    validateIntent(intent, pointer.generation);
    const recovery = path.join(logs, 'recovery-' + randomBytes(8).toString('hex'));
    mkdirSync(recovery, { mode: 0o700 });
    const docker = dockerContext(path.join(recovery, 'docker-config'), recovery);
    const cleanup = await cleanupIntent(docker, intent, () => writeJson(intentFile, intent));
    writeJson(path.join(recovery, 'summary.json'), cleanup);
    if (cleanup.complete) writeJson(PREPARING, { generation: pointer.generation, complete: true });
    return cleanup;
  } catch { return { complete: false, resources: [] }; }
}

async function prepare() {
  assert.equal(process.argv.length, 2, 'No preparation arguments');
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const platform = 'linux/' + arch, pin = POLICY.platforms[platform]; assert(pin, 'Unsupported architecture');
  const priorPreparation = preparingPointer();
  assert(!priorPreparation || priorPreparation.complete, 'Prior preparation cleanup incomplete');
  const run_id = 'mr21-prep-' + randomBytes(16).toString('hex');
  const stage = path.join(ROOT, '.workflow/state', run_id), logs = path.join(ROOT, '.workflow/proofs/dast', run_id);
  const controller = new AbortController(), { signal } = controller;
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let docker, pointerWritten = false, logsCreated = false;
  const resources = [];
  const intent = { run_id, resources, pending: null }; const save = () => writeJson(path.join(logs, 'intent.json'), intent);
  const call = async (label, args, options) => {
    const result = await docker.call(label, args, { ...options, signal });
    assert(successful(result), 'Preparation operation failed'); return result;
  };
  const inspect = async (id, label) => JSON.parse((await call(label, ['inspect', id])).stdout)[0];
  async function create(role, image, command, args) {
    const name = run_id + '-' + role; intent.pending = { role, name }; save();
    const output = await call(role + '-create', ['create', '--pull=never', '--name', name, '--label', 'devops.dast.run=' + run_id,
      '--label', 'devops.dast.role=' + role, '--platform', platform, ...args, '--entrypoint', '/usr/bin/env', image, ...command]);
    const id = output.stdout.toString('ascii').trim(); assert.match(id, /^[0-9a-f]{64}$/);
    resources.push({ id, run_id, role }); intent.pending = null; save(); return id;
  }
  let failure, prepared;
  try {
    ensureStateDirectory();
    writeJson(PREPARING, { generation: run_id, complete: false }); pointerWritten = true;
    mkdirSync(stage, { mode: 0o755 });
    mkdirSync(logs, { recursive: true, mode: 0o700 }); logsCreated = true; save();
    docker = dockerContext(path.join(stage, 'docker-config'), logs);
    signal.throwIfAborted();
    const images = {};
    for (const tool of ['node', 'zap']) {
      const config = await imageMetadata(tool, pin[tool], stage, signal);
      let found = await docker.call(tool + '-cached', ['image', 'inspect', pin[tool].ref], { signal });
      if (!successful(found)) {
        await call(tool + '-pull', ['pull', '--platform', platform, pin[tool].ref], { timeoutMs: 240_000 });
        found = await call(tool + '-image', ['image', 'inspect', pin[tool].ref]);
      }
      images[tool] = verifyImage(JSON.parse(found.stdout)[0], pin[tool], config, arch);
    }
    const archive = await download(`https://github.com/projectdiscovery/nuclei/releases/download/v${POLICY.nuclei_version}/nuclei_${POLICY.nuclei_version}_linux_${arch}.zip`, 64 * 1024 * 1024, {}, signal);
    assert.equal(digest(archive), pin.nuclei_archive_sha256); writeFileSync(path.join(stage, 'nuclei.zip'), archive, { flag: 'wx' });
    const unzip = executable('unzip'), env = { PATH: '/usr/bin:/bin', HOME: stage, LANG: 'C' };
    const list = await runCommand(unzip, ['-Z', '-1', path.join(stage, 'nuclei.zip')], { cwd: stage, env, timeoutMs: 20_000, maxBytes: 65536, signal });
    assert(successful(list)); assert.equal(list.stdout.toString('utf8').split(/\r?\n/).filter(name => name === 'nuclei').length, 1);
    const unpacked = await runCommand(unzip, ['-p', path.join(stage, 'nuclei.zip'), 'nuclei'], { cwd: stage, env, timeoutMs: 20_000, maxBytes: 256 * 1024 * 1024, signal });
    assert(successful(unpacked)); assert(unpacked.stdout.length > 64 && unpacked.stdout.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])));
    assert.equal(unpacked.stdout.readUInt16LE(18), arch === 'arm64' ? 183 : 62);
    writeFileSync(path.join(stage, 'nuclei'), unpacked.stdout, { flag: 'wx', mode: 0o755 });
    const sourceFiles = ['runtime/package.json', 'runtime/package-lock.json', 'runtime/tsconfig.json', 'observability/pii-redaction.ts',
      ...walk(path.join(ROOT, 'runtime/src')).map(name => 'runtime/src/' + name), ...SCRIPTS.map(name => 'scripts/dast/' + name),
      'tests/fixtures/dast-positive-target.mjs'];
    const vendorRoot = 'scripts/dast/vendor/nuclei-templates';
    const provenance = JSON.parse(readFileSync(path.join(ROOT, vendorRoot, 'UPSTREAM.json'), 'utf8'));
    const expectedVendor = { 'http/exposures/configs/laravel-env.yaml': POLICY.templates.laravel_env_sha256,
      'http/exposures/configs/git-config.yaml': POLICY.templates.git_config_sha256, '.nuclei-ignore': POLICY.templates.ignore_sha256,
      'LICENSE.md': '5fa6644d2dd1987a79c06f4af210d2cf8cfc4ee799999029d0f9980c9cf95a2c' };
    assert.equal(provenance.upstream_commit, POLICY.templates.commit);
    assert.deepEqual(provenance.files.map(entry => entry.path).sort(), Object.keys(expectedVendor).sort());
    for (const entry of provenance.files) {
      assert.equal(entry.sha256, expectedVendor[entry.path]);
      assert.equal(hashFile(path.join(ROOT, vendorRoot, entry.path)), entry.sha256);
      sourceFiles.push(vendorRoot + '/' + entry.path);
    }
    sourceFiles.push(vendorRoot + '/UPSTREAM.json');
    const checkout = sourceManifest(ROOT, sourceFiles); writeJson(path.join(stage, 'checkout-manifest.json'), checkout);
    for (const name of sourceFiles.filter(name => name.startsWith('runtime/') || name.startsWith('observability/'))) copy(path.join(ROOT, name), path.join(stage, name));
    mkdirSync(path.join(stage, 'runtime/data'));
    for (const name of SCRIPTS) copy(path.join(ROOT, 'scripts/dast', name), path.join(stage, 'dast', name));
    writeFileSync(path.join(stage, 'dast/run.json'), '', { flag: 'wx' });
    copy(path.join(ROOT, 'tests/fixtures/dast-positive-target.mjs'), path.join(stage, 'control.mjs'));
    for (const entry of provenance.files) copy(path.join(ROOT, vendorRoot, entry.path), path.join(stage, 'vendor', entry.path));
    const lock = JSON.parse(readFileSync(path.join(stage, 'runtime/package-lock.json'), 'utf8')); assert.equal(lock.lockfileVersion, 3);
    for (const entry of Object.values(lock.packages)) if (entry.resolved) {
      const url = new URL(entry.resolved); assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org');
      assert(!url.port && !url.username && !url.password && !url.hash && entry.integrity?.startsWith('sha512-'));
    }
    for (const directory of ['home', 'tmp', 'npm-cache', 'config']) { mkdirSync(path.join(stage, directory)); chmodSync(path.join(stage, directory), 0o777); }
    chmodSync(path.join(stage, 'runtime'), 0o777);
    for (const file of ['user.conf', 'global.conf']) writeFileSync(path.join(stage, 'config', file), '', { flag: 'wx' });
    const restrictions = ['--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1536m', '--cpus', '2', '--pids-limit', '256', '--no-healthcheck', '--read-only'];
    const npm = await create('dependencies', pin.node.ref, ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/prep/home', 'TMPDIR=/prep/tmp',
      'XDG_CONFIG_HOME=/prep/home', 'LANG=C.UTF-8', 'npm_config_update_notifier=false', '/usr/local/bin/npm', 'ci', '--ignore-scripts',
      '--include=dev', '--include=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
      '--userconfig=/prep/config/user.conf', '--globalconfig=/prep/config/global.conf', '--cache=/prep/npm-cache', '--fetch-retries=1', '--fetch-timeout=30000'],
    [...restrictions, '--network', 'bridge', '--mount', `type=bind,src=${stage},dst=/prep`, '--workdir', '/prep/runtime']);
    const prior = await inspect(npm, 'dependencies-prestart');
    assert.equal(prior.Image, images.node.engine_id); assert.equal(prior.HostConfig.NetworkMode, 'bridge');
    assert.equal(prior.Config.User, '1000:1000'); assert.equal(prior.HostConfig.Privileged, false);
    assert.deepEqual(prior.HostConfig.CapDrop, ['ALL']); assert.deepEqual(prior.HostConfig.SecurityOpt, ['no-new-privileges']);
    assert(empty(prior.HostConfig.CapAdd) && empty(prior.HostConfig.ExtraHosts) && noPorts(prior.HostConfig.PortBindings) && prior.HostConfig.ReadonlyRootfs);
    assert.equal(prior.Mounts.length, 1); assert.equal(prior.Mounts[0].Source, stage); assert.equal(prior.Mounts[0].Destination, '/prep');
    await call('dependencies-install', ['start', '--attach', npm], { timeoutMs: 180_000 });
    const terminal = (await inspect(npm, 'dependencies-terminal')).State;
    assert(!terminal.Running && terminal.ExitCode === 0 && !terminal.OOMKilled);
    for (const name of ['package.json', 'package-lock.json']) assert.equal(hashFile(path.join(stage, 'runtime', name)), hashFile(path.join(ROOT, 'runtime', name)));
    const modules = path.join(stage, 'runtime/node_modules');
    assert.equal(JSON.parse(readFileSync(path.join(modules, 'tsx/package.json'))).version, '4.22.3');
    const esbuild = path.join(modules, `tsx/node_modules/@esbuild/linux-${arch === 'amd64' ? 'x64' : 'arm64'}`);
    assert.equal(JSON.parse(readFileSync(path.join(esbuild, 'package.json'))).version, '0.28.2');
    const nativeBinary = path.join(esbuild, 'bin/esbuild'), nativeMode = lstatSync(nativeBinary);
    assert(nativeMode.isFile() && nativeMode.nlink === 1 && (nativeMode.mode & 0o111) === 0o111);
    const elf = readFileSync(nativeBinary);
    assert(elf.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1]))); assert.equal(elf.readUInt16LE(18), arch === 'arm64' ? 183 : 62);
    const copyContainer = await create('source', pin.zap.ref, ['-i', '/bin/true'], [...restrictions, '--network', 'none']);
    await call('zap-common-copy', ['cp', copyContainer + ':/zap/zap_common.py', path.join(stage, 'zap_common.original.py')]);
    const original = readFileSync(path.join(stage, 'zap_common.original.py'), 'utf8'); assert.equal(digest(original), POLICY.zap.common_original_sha256);
    const needle = "def create_start_options(mode, port, extra_params):\n    params = [\n        '/zap/zap-x.sh', mode,\n        '-port', str(port),\n        '-host', '0.0.0.0',";
    assert.equal(original.split(needle).length, 2);
    const replacement = needle.replace("'0.0.0.0'", "'127.0.0.1'");
    const modified = original.replace(needle, replacement);
    assert.equal(modified.replace(replacement, needle), original);
    assert.equal(digest(modified), POLICY.zap.common_sha256);
    writeFileSync(path.join(stage, 'zap_common.py'), modified, { flag: 'wx' });
    const selected = [...walk(path.join(stage, 'runtime')).map(name => 'runtime/' + name),
      ...walk(path.join(stage, 'observability')).map(name => 'observability/' + name),
      ...walk(path.join(stage, 'dast')).map(name => 'dast/' + name), ...walk(path.join(stage, 'vendor')).map(name => 'vendor/' + name),
      'nuclei', 'control.mjs', 'zap_common.py', 'node-config.json', 'zap-config.json', 'checkout-manifest.json'];
    const manifest = sourceManifest(stage, selected); writeJson(path.join(stage, 'source-manifest.json'), manifest);
    prepared = { schema_version: 1, platform, source_manifest_sha256: manifest.sha256, images,
      nuclei: { version: POLICY.nuclei_version, archive_sha256: pin.nuclei_archive_sha256, binary_sha256: digest(unpacked.stdout) },
      templates: POLICY.templates, zap_hook_sha256: hashFile(path.join(stage, 'dast/zap-completion.py')),
      zap_common_original_sha256: POLICY.zap.common_original_sha256, zap_common_sha256: POLICY.zap.common_sha256 };
    writeJson(path.join(stage, 'prepared.json'), prepared);
  } catch { failure = true; }
  finally {
    try {
      // Cancellation stops provisioning, but never skips exact owned cleanup.
      const cleanup = docker ? await cleanupIntent(docker, intent, save) : { complete: true, resources: [] };
      if (!cleanup.complete || signal.aborted) failure = true;
      if (logsCreated) writeJson(path.join(logs, 'summary.json'), {
        schema_version: 1, run_id, prepared: !!prepared, cleanup, verdict: failure ? 'INDETERMINATE' : 'PREPARED',
      });
      if (pointerWritten && cleanup.complete) writeJson(PREPARING, { generation: run_id, complete: true });
    } catch { failure = true; }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
  if (failure || !prepared) throw new Error('Preparation failed');
  writeJson(POINTER, { generation: run_id, prepared_sha256: hashFile(path.join(stage, 'prepared.json')) });
  return { schema_version: 1, run_id, verdict: 'PREPARED', platform };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await prepare()) + '\n'); }
  catch { process.stdout.write('{"schema_version":1,"verdict":"INDETERMINATE","reason":"preparation"}\n'); process.exitCode = 1; }
}
