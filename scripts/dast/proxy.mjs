// specs/security/local-dast.md REQ4/9 and Annex B: one fixed personal proxy lifetime.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { drainNuclei, readRunConfig, runNuclei, spawnOwned, WorkloadFailure } from './nuclei.mjs';

const PHASES = ['initial', 'nuclei_before', 'nuclei', 'nuclei_after', 'zap_before', 'zap_after'];
const REASONS = ['protocol', 'phase_order', 'busy', 'startup', 'target_dead', 'provider', 'health', 'nuclei', 'deadline', 'output_limit', 'shutdown', 'internal'];
const SOCKET = '/tmp/dast-control/control.sock';
const ANSWER = 'MR21 synthetic provider response';
const PROMPT = 'DAST readiness fixture';
const utc = () => new Date().toISOString();
const budget = phase => phase === 'initial' ? 30000 : phase === 'nuclei' ? 50000 : 20000;
const known = phase => PHASES.includes(phase) || phase === 'drain';

export function createPhaseController(runId, { perform, drain }) {
  let sequence = 0; let next = 0; let failure = null; let active = null; let draining = false; let drained = false;
  const refuse = (phase, reason) => ({ schema_version: 1, run_id: runId, phase, sequence, ok: false, reason });
  const fail = reason => { failure ??= REASONS.includes(reason) ? reason : 'internal'; };
  const execute = async (phase, action, context) => {
    let timer; let cancel;
    const cancelled = new Promise((resolve, reject) => { cancel = () => reject(new WorkloadFailure(context.reason ?? 'shutdown')); });
    context.abort.signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { context.reason = 'deadline'; context.abort.abort(); }, budget(phase));
    try {
      const result = await Promise.race([Promise.resolve().then(() => action(context.abort.signal)), cancelled]);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WorkloadFailure('internal');
      const reply = { schema_version: 1, run_id: runId, phase, sequence: sequence + 1, ok: true, result };
      if (Buffer.byteLength(JSON.stringify(reply) + '\n') > 65536) throw new WorkloadFailure('output_limit');
      sequence++; return reply;
    } catch (error) {
      const reason = context.reason ?? (error instanceof WorkloadFailure && REASONS.includes(error.code) ? error.code : 'internal');
      fail(reason); return refuse(phase, reason);
    } finally { clearTimeout(timer); context.abort.signal.removeEventListener('abort', cancel); }
  };
  async function handle(bytes) {
    let phase;
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 1024 || bytes.at(-1) !== 10) throw new Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.slice(0, -1).includes('\n')) throw new Error();
      const value = JSON.parse(text);
      if (!value || Object.keys(value).sort().join(',') !== 'phase,run_id,schema_version' || value.schema_version !== 1 || value.run_id !== runId || !known(value.phase)) throw new Error();
      phase = value.phase;
    } catch { return refuse(null, 'protocol'); }
    if (drained || draining) return refuse(phase, 'phase_order');
    if (phase === 'drain') {
      draining = true;
      if (active) { active.reason = 'shutdown'; active.abort.abort(); await active.promise; }
      const reply = await execute(phase, () => drain(), { abort: new AbortController() });
      drained = true; draining = false; return reply;
    }
    if (active) return refuse(phase, 'busy');
    if (failure) return refuse(phase, failure);
    if (phase !== PHASES[next]) return refuse(phase, 'phase_order');
    const context = { abort: new AbortController() }; active = context;
    context.promise = execute(phase, signal => perform(phase, { signal }), context);
    const reply = await context.promise;
    if (reply.ok) next++;
    if (active === context) active = null;
    return reply;
  }
  return { handle, fail };
}

export async function serveControl(socketPath, controller) {
  const server = createServer({ allowHalfOpen: true }, socket => {
    let finished = false; let size = 0; const chunks = [];
    const send = async (bytes, reason) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try {
        const reply = await controller.handle(bytes);
        if (reason) reply.reason = reason;
        await controller.record?.(reply); // Production persists before ACK; unit actions have no file effects.
        const encoded = JSON.stringify(reply) + '\n';
        if (Buffer.byteLength(encoded) > 65536) throw new Error();
        if (!socket.destroyed) socket.end(encoded);
        controller.afterReply?.(reply);
      } catch { socket.destroy(); }
    };
    const timer = setTimeout(() => { void send(Buffer.alloc(0), 'deadline'); }, 2000);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > 1024) void send(Buffer.alloc(0)); else chunks.push(chunk);
    });
    socket.on('end', () => { void send(Buffer.concat(chunks)); });
    socket.on('close', () => { clearTimeout(timer); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600); return server;
}

async function request(urlPath, signal, options = {}) {
  const response = await fetch('http://127.0.0.1:18080' + urlPath, {
    ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 262144) throw new WorkloadFailure('health'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return { status: response.status, type: response.headers.get('content-type'), text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
}
function createApplication() {
  let proxy; let nucleiOperation; let counter = 0; let rejected = 0; let draining = false; let fatal = null; let notify = () => {};
  const refuse = code => { fatal ??= code; notify(code); };
  const provider = httpServer(async (req, res) => {
    req.setTimeout(3000, () => req.destroy());
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, undefined);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; assert(size <= 8192); chunks.push(chunk); }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      assert.equal(body.model, 'dast-fixture'); assert.equal(body.stream, undefined);
      assert.deepEqual(body.messages, [{ role: 'user', content: PROMPT }]); counter++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mr21-synthetic', object: 'chat.completion', created: 0, model: 'dast-fixture',
        choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } }));
    } catch { rejected++; refuse('provider'); res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"synthetic provider refused"}'); }
  });
  provider.requestTimeout = 5000; provider.headersTimeout = 5000;
  provider.on('error', () => refuse('provider'));
  provider.on('close', () => { if (!draining) refuse('provider'); });
  const alive = () => { if (fatal) throw new WorkloadFailure(fatal); if (!proxy?.live || !provider.listening) throw new WorkloadFailure('target_dead'); };
  async function start(signal) {
    assert.equal(process.getuid(), 1000);
    mkdirSync('/app/runtime/data/sessions', { recursive: true }); assert.equal(readdirSync('/app/runtime/data/sessions').length, 0);
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(18081, '127.0.0.1', resolve); });
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8',
      NODE_ENV: 'production', LOG_LEVEL: 'info', DEVOPS_PROXY_HOST: '127.0.0.1', PORT: '18080',
      CQ_LOCAL_BASE_URL: 'http://127.0.0.1:18081/v1', CQ_CAPTURE_DIR: '/app/runtime/data/sessions',
      STRATUM_TELEMETRY_OPT_OUT: 'true', DOTENV_CONFIG_PATH: '/tmp/absent-dotenv',
      CQ_UPSTREAM_TIMEOUT_MS: '5000', CQ_UPSTREAM_IDLE_MS: '5000', RATE_LIMIT_MAX: '1000' };
    proxy = spawnOwned('/usr/local/bin/node', ['/app/runtime/node_modules/tsx/dist/cli.mjs', 'src/proxy/index.ts'],
      { cwd: '/app/runtime', env, timeoutMs: 600000, graceMs: 10000 });
    proxy.closed.then(result => { if (!draining) refuse(result.output_overflow ? 'output_limit' : 'target_dead'); });
    while (!signal.aborted) {
      alive();
      try {
        const response = await request('/health', signal);
        if (response.status === 200 && JSON.parse(response.text).status === 'ok') return;
      } catch { if (signal.aborted) break; }
      await delay(100, undefined, { signal });
    }
    throw new WorkloadFailure('startup');
  }
  async function health(phase, signal) {
    const started_at = utc(); alive();
    const response = await request('/health', signal); assert.equal(response.status, 200);
    const health = JSON.parse(response.text);
    assert.equal(health.status, 'ok'); assert.equal(health.phase, '1-measurement-proxy'); assert.equal(health.dependencies, undefined);
    if (phase === 'initial') assert.equal(JSON.parse((await request('/dashboard/api', signal)).text).session_count, 0);
    const provider_before = counter;
    const message = await request('/v1/messages', signal, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'local/dast-fixture', max_tokens: 16, stream: false, messages: [{ role: 'user', content: PROMPT }] }) });
    assert.equal(message.status, 200); const value = JSON.parse(message.text);
    assert.equal(value.type, 'message'); assert.equal(value.role, 'assistant'); assert.equal(value.stop_reason, 'end_turn');
    assert.deepEqual(value.content, [{ type: 'text', text: ANSWER }]); assert.deepEqual(value.usage, { input_tokens: 23, output_tokens: 7 });
    assert.equal(counter, provider_before + 1); assert.equal(rejected, 0);
    const dashboardResponse = await request('/dashboard/api', signal); assert.equal(dashboardResponse.status, 200);
    const dashboard = JSON.parse(dashboardResponse.text);
    assert.equal(dashboard.session_count, 1); assert.equal(dashboard.total_turns, counter); assert.equal(dashboard.total_dropped_turns, 0);
    assert.equal(dashboard.total_input_tokens, counter * 23); assert.equal(dashboard.total_output_tokens, counter * 7);
    const result = { phase, started_at, finished_at: '', proxy_pid: proxy.pid, proxy_alive: true,
      health_status: response.status, health: { status: health.status, phase: health.phase }, message_status: message.status,
      answer: value.content[0].text, input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens,
      provider_before, provider_after: counter, provider_rejected: rejected,
      capture: { sessions: dashboard.session_count, turns: dashboard.total_turns, input_tokens: dashboard.total_input_tokens, output_tokens: dashboard.total_output_tokens } };
    if (phase === 'initial') {
      result.routes = {};
      for (const [name, route] of [['docs', '/docs'], ['dashboard', '/dashboard'], ['dashboard_graph', '/dashboard/graph']]) {
        const page = await request(route, signal); assert.equal(page.status, 200); assert(page.type?.startsWith('text/html'));
        assert(/<!doctype html>/i.test(page.text)); result.routes[name] = page.status;
      }
      const openapi = await request('/openapi.json', signal); assert.equal(openapi.status, 200);
      const doc = JSON.parse(openapi.text); assert.equal(doc.openapi, '3.1.0'); assert(doc.paths['/v1/messages']); result.routes.openapi = openapi.status;
    }
    alive(); result.finished_at = utc(); return result;
  }
  return {
    setFailureHandler(fn) { notify = fn; },
    async perform(phase, { signal }) {
      try {
        if (phase === 'initial') await start(signal);
        alive();
        if (phase === 'nuclei') { nucleiOperation = runNuclei({ signal }); return await nucleiOperation; }
        return await health(phase, signal);
      } catch (error) { throw error instanceof WorkloadFailure ? error : new WorkloadFailure(phase === 'nuclei' ? 'nuclei' : phase === 'initial' ? 'startup' : 'health'); }
    },
    async drain() {
      draining = true; const scanner = await drainNuclei();
      if (nucleiOperation) await nucleiOperation.catch(() => null);
      const terminal = proxy ? await proxy.stop() : null;
      try {
        if (terminal) {
          writeFileSync('/out/proxy.stdout.log', terminal.stdout, { flag: 'wx', mode: 0o644 });
          writeFileSync('/out/proxy.stderr.log', terminal.stderr, { flag: 'wx', mode: 0o644 });
        }
      } finally { provider.closeAllConnections(); if (provider.listening) await new Promise(resolve => provider.close(resolve)); }
      if (terminal && (terminal.exit_code !== 0 || terminal.signal !== null || terminal.timed_out || terminal.output_overflow || terminal.close_error)) throw new WorkloadFailure('shutdown');
      if (scanner?.close_error) throw new WorkloadFailure('shutdown');
      return { kind: 'drain', proxy_terminal: terminal ? { exit_code: terminal.exit_code, signal: terminal.signal } : null,
        nuclei_terminal: scanner ? { exit_code: scanner.exit_code, signal: scanner.signal } : null, provider_closed: !provider.listening };
    },
  };
}

async function phaseClient(config, phase) {
  const until = Date.now() + 5000; let socket;
  while (!socket) {
    try {
      socket = await new Promise((resolve, reject) => {
        const peer = createConnection(SOCKET); const timer = setTimeout(() => { peer.destroy(); reject(new Error()); }, Math.max(1, until - Date.now()));
        peer.once('connect', () => { clearTimeout(timer); resolve(peer); });
        peer.once('error', error => { clearTimeout(timer); reject(error); });
      });
    } catch { if (Date.now() >= until) throw new Error(); await delay(50); }
  }
  const bytes = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let ended = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error()); }, budget(phase) + 5000);
    socket.on('data', chunk => { size += chunk.length; if (size > 65536) socket.destroy(new Error()); else chunks.push(chunk); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('end', () => { ended = true; clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    socket.once('close', () => { if (!ended) { clearTimeout(timer); reject(new Error()); } });
    socket.end(JSON.stringify({ schema_version: 1, run_id: config.run_id, phase }) + '\n');
  });
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error();
  const reply = JSON.parse(text);
  const keys = reply.ok ? 'ok,phase,result,run_id,schema_version,sequence' : 'ok,phase,reason,run_id,schema_version,sequence';
  if (!reply || Object.keys(reply).sort().join(',') !== keys || reply.schema_version !== 1 || reply.run_id !== config.run_id || reply.phase !== phase ||
      !Number.isSafeInteger(reply.sequence) || reply.sequence < 0 || typeof reply.ok !== 'boolean' ||
      (reply.ok ? !reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result) : !REASONS.includes(reply.reason))) throw new Error();
  process.stdout.write(text); process.exitCode = reply.ok ? 0 : 1;
}
async function main() {
  const [mode, phase, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== 'serve' && mode !== 'phase') || (mode === 'serve' ? phase !== undefined : !known(phase))) throw new Error();
  const config = readRunConfig(); if (config.kind !== 'application') throw new Error();
  if (mode === 'phase') return phaseClient(config, phase);
  mkdirSync('/tmp/dast-control', { mode: 0o700 });
  const events = openSync('/out/supervisor.events.jsonl', 'wx', 0o644); let eventBytes = 0; let hadFailure = false;
  const app = createApplication(); const controller = createPhaseController(config.run_id, app); app.setFailureHandler(controller.fail);
  controller.record = reply => {
    const bytes = Buffer.from(JSON.stringify(reply) + '\n'); eventBytes += bytes.length;
    if (eventBytes > 2 * 1024 * 1024) { controller.fail('output_limit'); throw new Error(); }
    appendFileSync(events, bytes); fsyncSync(events); if (!reply.ok) hadFailure = true;
  };
  let server;
  try {
    server = await serveControl(SOCKET, controller);
    controller.afterReply = reply => {
      if (reply.phase === 'drain' && reply.reason !== 'phase_order') { if (hadFailure) process.exitCode = 1; server.close(); }
    };
    const close = async () => {
      const reply = await controller.handle(Buffer.from(JSON.stringify({ schema_version: 1, run_id: config.run_id, phase: 'drain' }) + '\n'));
      try { controller.record(reply); } finally { server.close(); }
    };
    const stop = () => { void close().catch(() => { process.exitCode = 1; server.close(); }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await new Promise(resolve => server.once('close', resolve));
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  } finally { closeSync(events); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.stderr.write('dast-control: unavailable\n'); process.exitCode = 1; });
}
