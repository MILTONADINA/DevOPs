#!/usr/bin/env node
import { accessSync, readFileSync, readdirSync, writeFileSync, statSync, realpathSync, chmodSync, unlinkSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, '.workflow', 'state');
const REPORT = path.resolve(process.env.GRAPH_PREFLIGHT_REPORT || path.join(STATE, 'preflight.json'));
const REGISTRY = path.resolve(process.env.GRAPH_PREFLIGHT_REGISTRY || path.join(ROOT, 'governance', 'graph', 'preflight-remediations.yml'));
const checks = [];
const run = (file, args, timeout = 5000) => spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', timeout });
const firstLine = (value) => String(value || '').split('\n')[0].trim().slice(0, 180);
const add = (id, status, evidence, remedy) => checks.push({ id, status, evidence, ...(remedy ? { remedy } : {}) });
const recordPath = (id) => path.join(path.dirname(REPORT), `preflight-revert-${id}.json`);
const insideRoot = (file) => file === ROOT || file.startsWith(`${ROOT}${path.sep}`);
function registryEntry(registry, id, evidence) {
  return registry.find((entry) => entry.check_id === id && entry.detect === evidence);
}

function repairGit(registry) {
  const evidence = 'You have not agreed to the Xcode license agreements';
  const entry = registryEntry(registry, 'git.runs', evidence);
  const target = '/Library/Developer/CommandLineTools/usr/bin/git';
  if (!entry || !existsSync(target) || run(target, ['rev-parse', '--show-toplevel']).stdout.trim() !== ROOT) return false;
  const directory = (process.env.PATH || '').split(path.delimiter).find((candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) return false;
    try { accessSync(candidate, constants.W_OK); return statSync(candidate).isDirectory() && statSync(candidate).uid === process.getuid(); }
    catch { return false; }
  });
  if (!directory) return false;
  const shim = path.join(directory, 'git');
  const previous = existsSync(shim) ? { content: readFileSync(shim, 'base64'), mode: statSync(shim).mode & 0o777 } : null;
  if (previous && !statSync(shim).isFile()) return false;
  const record = recordPath('git.runs');
  if (existsSync(record)) return false;
  const temporary = `${shim}.graph-preflight-${process.pid}`;
  try {
    writeFileSync(temporary, `#!/bin/sh\nexec ${target} "$@"\n`, { mode: 0o755, flag: 'wx' });
    chmodSync(temporary, 0o755);
    renameSync(temporary, shim);
    if (run('git', ['rev-parse', '--show-toplevel']).stdout.trim() !== ROOT) throw new Error('Git shim did not pass re-check');
    writeFileSync(record, `${JSON.stringify({ shim, previous })}\n`, { mode: 0o600, flag: 'wx' });
    checks.pop();
    add('git.runs', 'fixed', 'Command Line Tools Git shim passed re-check', entry.apply);
    return true;
  } catch {
    if (previous) { writeFileSync(shim, Buffer.from(previous.content, 'base64')); chmodSync(shim, previous.mode); }
    else if (existsSync(shim)) unlinkSync(shim);
    if (existsSync(temporary)) unlinkSync(temporary);
    return false;
  }
}

function loadRegistry() {
  if (!realpathSync(REGISTRY).startsWith(`${ROOT}${path.sep}`)) throw new Error('remediation registry leaves the project root');
  const entries = JSON.parse(readFileSync(REGISTRY, 'utf8')).remediations;
  if (!Array.isArray(entries)) throw new Error('remediation registry has no remediations array');
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.check_id || seen.has(entry.check_id) || !entry.detect || !entry.apply || !entry.revert || !entry.why
      || entry.reversible !== true || entry.needs_sudo !== false) {
      throw new Error(`invalid remediation ${entry.check_id || '(unnamed)'}: reversible must be true and needs_sudo must be false`);
    }
    seen.add(entry.check_id);
  }
  return entries;
}

function gitRuns(checkOnly, registry) {
  const result = run('git', ['rev-parse', '--show-toplevel']);
  if (result.status === 0 && result.stdout.trim() === ROOT) {
    add('git.runs', 'pass', 'git resolves this project root');
    return true;
  }
  const error = firstLine(result.stderr);
  const evidence = error.includes('You have not agreed to the Xcode license agreements')
    ? 'You have not agreed to the Xcode license agreements'
    : `git rev-parse failed (${result.error?.code || result.status || 'unknown'})`;
  add('git.runs', 'fail', evidence);
  if (!checkOnly && evidence === 'You have not agreed to the Xcode license agreements' && repairGit(registry)) return true;
  return false;
}

function gitRemote(gitReady) {
  if (!gitReady) { add('git.remote', 'skipped', 'git.runs failed'); return; }
  const allowlist = path.join(ROOT, '.workflow', 'network-allowlist.txt');
  let allowed;
  try { allowed = readFileSync(allowlist, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')); }
  catch { add('git.remote', 'fail', 'Network allowlist missing; remote check withheld', 'Add the origin host to .workflow/network-allowlist.txt'); return; }
  const origin = run('git', ['remote', 'get-url', 'origin']);
  if (origin.status !== 0) { add('git.remote', 'fail', 'origin remote is unavailable'); return; }
  const url = origin.stdout.trim();
  const host = url.match(/^git@([^:]+):/)?.[1] || (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (!host || !allowed.includes(host)) { add('git.remote', 'fail', 'Origin host is not network-allowlisted'); return; }
  const result = run('git', ['ls-remote', '--exit-code', 'origin', 'HEAD'], 20_000);
  add('git.remote', result.status === 0 ? 'pass' : 'fail', result.status === 0 ? 'origin HEAD reachable' : 'origin HEAD unreachable or timed out');
}

function nodeVersion() {
  const declared = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node;
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(declared || '');
  if (!minimum) { add('node.version', 'fail', 'Unsupported package.json engines.node expression'); return; }
  const actual = process.versions.node.split('.').map(Number);
  const required = minimum.slice(1).map(Number);
  const meets = actual[0] > required[0] || (actual[0] === required[0] && (actual[1] > required[1] || (actual[1] === required[1] && actual[2] >= required[2])));
  add('node.version', meets ? 'pass' : 'fail', `Node ${process.version}; requires ${declared}`);
}

function npmRuns() {
  const result = run('npm', ['--version']);
  add('npm.runs', result.status === 0 ? 'pass' : 'fail', result.status === 0 ? `npm ${firstLine(result.stdout)}` : 'npm --version failed');
}

function dependencyDirectory(id, directory, checkOnly, registry) {
  const bin = path.join(directory, '.bin');
  try {
    if (!statSync(directory).isDirectory() || !statSync(bin).isDirectory()) throw new Error('missing');
    const bad = readdirSync(bin).filter((name) => {
      try { accessSync(path.join(bin, name), constants.X_OK); return false; } catch { return true; }
    });
    if (bad.length && !checkOnly) {
      const entry = registry.find((item) => item.check_id === id && item.detect === 'non-executable .bin entries');
      if (entry) {
        const modes = bad.map((name) => {
          const file = path.join(bin, name);
          if (!realpathSync(file).startsWith(`${ROOT}${path.sep}`)) throw new Error('launcher leaves the project root');
          return { file, mode: statSync(file).mode & 0o777 };
        });
        try {
          for (const item of modes) chmodSync(item.file, item.mode | 0o111);
          if (bad.some((name) => { try { accessSync(path.join(bin, name), constants.X_OK); return false; } catch { return true; } })) throw new Error('chmod did not repair every launcher');
          writeFileSync(path.join(path.dirname(REPORT), `preflight-revert-${id}.json`), `${JSON.stringify(modes)}\n`, { mode: 0o600 });
          add(id, 'fixed', `${bad.length} .bin entries made executable`, entry.apply);
          return;
        } catch (error) {
          for (const item of modes) chmodSync(item.file, item.mode);
          throw error;
        }
      }
    }
    add(id, bad.length ? 'fail' : 'pass', bad.length ? `${bad.length} non-executable .bin entries: ${bad.slice(0, 5).join(', ')}` : '.bin entries executable');
  } catch (error) {
    add(id, 'fail', error.message === 'missing' || error.code === 'ENOENT'
      ? 'node_modules or .bin directory missing' : `dependency check failed: ${firstLine(error.message)}`);
  }
}

function toolVersion(name) {
  const homeBin = path.join(process.env.HOME || '', 'bin', name);
  const candidates = [name, homeBin, `${homeBin}.exe`];
  for (const file of candidates) {
    const result = run(file, name === 'cosign' ? ['version'] : ['--version']);
    if (result.status === 0) {
      const version = name === 'cosign' ? /GitVersion:\s*(\S+)/.exec(result.stdout || result.stderr)?.[1] : firstLine(result.stdout || result.stderr);
      add(`tool.${name}`, 'pass', `${name} ${version || 'version command passed'}`);
      return;
    }
  }
  add(`tool.${name}`, 'fail', `${name} unavailable or version check failed`);
}

function repairCosign(registry) {
  const entry = registryEntry(registry, 'tool.cosign', 'cosign unavailable or version check failed');
  const platform = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release-sign.yml'), 'utf8');
  const pinned = /COSIGN_VERSION:\s*['"](v[\d.]+)['"]/.exec(workflow)?.[1];
  if (!entry || !pinned || pinned !== entry.version || !entry.sha256?.[platform]) return false;
  const home = process.env.HOME || os.homedir();
  const bin = path.join(home, 'bin');
  const target = path.join(bin, 'cosign');
  if (existsSync(target)) return false;
  const allowlist = readFileSync(path.join(ROOT, '.workflow', 'network-allowlist.txt'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  if (!allowlist.includes('github.com') || !allowlist.includes('release-assets.githubusercontent.com')) return false;
  const asset = `cosign-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const initial = `https://github.com/sigstore/cosign/releases/download/${pinned}/${asset}`;
  const head = run('curl', ['--silent', '--show-error', '--head', '--max-time', '15', initial], 20_000);
  const redirect = /^location:\s*(\S+)/im.exec(head.stdout)?.[1];
  if (head.status !== 0 || !redirect) return false;
  let download;
  try { download = new URL(redirect); } catch { return false; }
  if (download.protocol !== 'https:' || download.hostname !== 'release-assets.githubusercontent.com') return false;
  mkdirSync(bin, { recursive: true });
  if (statSync(bin).uid !== process.getuid()) return false;
  const temporary = path.join(bin, `.cosign.graph-preflight-${process.pid}`);
  try {
    const fetched = run('curl', ['--silent', '--show-error', '--fail', '--max-time', '45', '--output', temporary, download.href], 50_000);
    if (fetched.status !== 0) throw new Error('download failed');
    const actual = createHash('sha256').update(readFileSync(temporary)).digest('hex');
    if (actual !== entry.sha256[platform]) throw new Error('checksum mismatch');
    chmodSync(temporary, 0o755);
    if (run(temporary, ['version']).status !== 0) throw new Error('version check failed');
    renameSync(temporary, target);
    writeFileSync(recordPath('tool.cosign'), `${JSON.stringify({ target, sha256: actual })}\n`, { mode: 0o600, flag: 'wx' });
    checks.pop();
    add('tool.cosign', 'fixed', `Cosign ${pinned} SHA-256 verified and version re-checked`, entry.apply);
    return true;
  } catch {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(target) && !existsSync(recordPath('tool.cosign'))) unlinkSync(target);
    return false;
  }
}

function writable(id, directory) {
  try { accessSync(directory, constants.W_OK); add(id, 'pass', 'writable'); }
  catch { add(id, 'fail', 'directory missing or not writable'); }
}

function haltAbsent() {
  try { statSync(path.join(STATE, 'graph-halt')); add('halt.absent', 'fail', 'graph-halt is present', 'Only the human may run /graph-resume'); }
  catch (error) { add('halt.absent', error.code === 'ENOENT' ? 'pass' : 'fail', error.code === 'ENOENT' ? 'graph-halt absent' : 'graph-halt could not be checked'); }
}

function blockedHumanAbsent() {
  try {
    const blocked = readFileSync(path.join(STATE, 'blocked.md'), 'utf8');
    add('blocked.human', /^## Class\nneeds_human$/m.test(blocked) ? 'fail' : 'pass', /^## Class\nneeds_human$/m.test(blocked) ? 'needs_human blocked record present' : 'no needs_human block');
  } catch (error) {
    add('blocked.human', error.code === 'ENOENT' ? 'pass' : 'fail', error.code === 'ENOENT' ? 'blocked record absent' : 'blocked record unreadable');
  }
}

function main() {
  if (!REPORT.startsWith(`${ROOT}${path.sep}`) || !realpathSync(path.dirname(REPORT)).startsWith(`${ROOT}${path.sep}`)) throw new Error('report path must remain inside the project');
  const registry = loadRegistry();
  if (process.argv[2] === '--revert' && process.argv.length === 4) {
    const id = process.argv[3];
    if (!registry.some((entry) => entry.check_id === id)) throw new Error(`unsupported revert: ${id}`);
    const record = recordPath(id);
    const saved = JSON.parse(readFileSync(record, 'utf8'));
    if (id === 'git.runs') {
      if (!path.isAbsolute(saved.shim) || !statSync(path.dirname(saved.shim)).isDirectory()
        || !(process.env.PATH || '').split(path.delimiter).includes(path.dirname(saved.shim))) throw new Error('invalid Git shim path');
      if (!readFileSync(saved.shim, 'utf8').includes('exec /Library/Developer/CommandLineTools/usr/bin/git "$@"')) throw new Error('Git shim changed; refusing revert');
      if (saved.previous) { writeFileSync(saved.shim, Buffer.from(saved.previous.content, 'base64')); chmodSync(saved.shim, saved.previous.mode); }
      else unlinkSync(saved.shim);
    } else if (id === 'tool.cosign') {
      if (saved.target !== path.join(process.env.HOME || os.homedir(), 'bin', 'cosign')) throw new Error('Cosign target differs from current home');
      if (createHash('sha256').update(readFileSync(saved.target)).digest('hex') !== saved.sha256) throw new Error('Cosign changed; refusing revert');
      unlinkSync(saved.target);
    } else if (['deps.root', 'deps.stratum'].includes(id)) {
      for (const item of saved) {
        if (!insideRoot(realpathSync(item.file))) throw new Error('revert path leaves the project root');
        chmodSync(item.file, item.mode);
      }
    } else throw new Error(`unsupported revert: ${id}`);
    unlinkSync(record);
    process.stdout.write(`Reverted ${id}\n`);
    return;
  }
  if (process.argv.slice(2).some((arg) => !['--json', '--check-only'].includes(arg))) throw new Error('Usage: graph-preflight.sh [--json] [--check-only] [--revert check-id]');
  const checkOnly = process.argv.includes('--check-only');
  const gitReady = gitRuns(checkOnly, registry);
  gitRemote(gitReady);
  nodeVersion();
  npmRuns();
  dependencyDirectory('deps.root', path.join(ROOT, 'node_modules'), checkOnly, registry);
  const stratumDependencies = path.resolve(process.env.GRAPH_PREFLIGHT_DEPS_STRATUM_DIR || path.join(ROOT, 'stratum', 'node_modules'));
  if (!insideRoot(stratumDependencies)) throw new Error('Stratum dependencies leave the project root');
  if (existsSync(stratumDependencies) && !insideRoot(realpathSync(stratumDependencies))) throw new Error('Stratum dependencies redirect outside the project root');
  dependencyDirectory('deps.stratum', stratumDependencies, checkOnly, registry);
  for (const name of ['gitleaks', 'semgrep', 'cosign']) {
    toolVersion(name);
    if (name === 'cosign' && checks.at(-1).status === 'fail' && !checkOnly) repairCosign(registry);
  }
  writable('state.writable', STATE);
  writable('proofs.writable', path.join(ROOT, '.workflow', 'proofs'));
  haltAbsent();
  blockedHumanAbsent();
  const sha = gitReady ? firstLine(run('git', ['rev-parse', 'HEAD']).stdout) : null;
  const status = checks.some((check) => check.status === 'fail') ? 'needs_human'
    : checks.some((check) => check.status === 'fixed') ? 'remediated' : 'ready';
  const report = { schema_version: 1, ran_at: new Date().toISOString(), git_sha: sha, status, checks };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else for (const check of checks) process.stdout.write(`${check.status === 'pass' ? '✓' : ['skipped', 'fixed'].includes(check.status) ? '!' : '✗'} ${check.id}: ${check.evidence}\n`);
  process.exitCode = status === 'ready' ? 0 : status === 'remediated' ? 10 : 20;
}

try { main(); }
catch (error) {
  const report = { schema_version: 1, ran_at: new Date().toISOString(), git_sha: null, status: 'error', checks, error: error.message };
  try {
    if (REPORT.startsWith(`${ROOT}${path.sep}`) && realpathSync(path.dirname(REPORT)).startsWith(`${ROOT}${path.sep}`)) {
      writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
  } catch { /* report path unavailable */ }
  process.stderr.write(`graph-preflight: ${error.message}\n`);
  process.exitCode = 2;
}
