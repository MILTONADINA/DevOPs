#!/usr/bin/env node
// Read-only local DAST verdict. Importing this module starts no work.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportFailure, requireValue, object, integer, digest, equal, sha256, decode, parseJSON,
  containedDirectory, readContained, windowOf, parseNucleiReports, parseZapReport, ORIGIN, SEED } from './dast/report-inputs.mjs';
import { assertIsolation } from './dast/isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = 256 * 1024, REPORT = 10 * 1024 * 1024, LOG = 2 * 1024 * 1024;
const FILES = { 'run.json': RECEIPT, 'prepared.json': RECEIPT, 'isolation.json': RECEIPT,
  'nuclei.jsonl': REPORT, 'zap.json': REPORT, 'nuclei.stdout.log': LOG, 'nuclei.stderr.log': LOG,
  'nuclei-errors.log': LOG, 'zap.stdout.log': LOG, 'zap.stderr.log': LOG,
  'zap-before-report.json': RECEIPT, 'zap-completion.json': RECEIPT };
const PRIORITY = ['usage', 'input', 'binding', 'terminal', 'completion', 'report', 'scope', 'isolation', 'health',
  'control_missing_detection', 'high_finding', 'control_only', 'ok', 'internal'];
const check = (value, code = 'binding') => requireValue(value, code);
function emptySummary() {
  return { schema_version: 1, run_id: null, kind: null, verdict: 'INDETERMINATE', reason: 'internal', scan_complete: false,
    nuclei: { complete: false, counts: null, engine_units: null, engine_total: null, observed_http_requests: null },
    zap: { complete: false, alerts: null, instances: null, url_count: null } };
}
function binding(run, prepared, bytes, policy, dir, hookHash) {
  check(run.schema_version === 1 && typeof run.run_id === 'string' && /^mr21-dast-[0-9a-f]{32}$/.test(run.run_id) && run.run_id.length === 42 && path.basename(dir) === run.run_id);
  check(['application', 'positive_control'].includes(run.kind) && Object.hasOwn(policy.platforms, run.platform) && prepared.platform === run.platform);
  check(run.origin === ORIGIN && run.seed === SEED && run.prepared_sha256 === sha256(bytes['prepared.json']));
  check(object(run.artifacts) && equal(Object.keys(run.artifacts).sort(), Object.keys(FILES).filter(name => name !== 'run.json').sort()));
  for (const [name, raw] of Object.entries(bytes)) {
    if (name === 'run.json') continue;
    const artifact = run.artifacts[name];
    check(object(artifact) && integer(artifact.bytes) && artifact.bytes === raw.length && digest(artifact.sha256) && artifact.sha256 === sha256(raw));
  }
  const pin = policy.platforms[run.platform];
  check(prepared.schema_version === 1 && digest(prepared.source_manifest_sha256) && object(prepared.images));
  for (const role of ['node', 'zap']) {
    const image = prepared.images[role];
    check(object(image) && image.ref === pin[role].ref && image.config_sha256 === pin[role].config_sha256 &&
      typeof image.engine_id === 'string' && image.engine_id.length === 71 && /^sha256:[0-9a-f]{64}$/.test(image.engine_id));
  }
  check(object(prepared.nuclei) && prepared.nuclei.version === policy.nuclei_version && prepared.nuclei.archive_sha256 === pin.nuclei_archive_sha256 && digest(prepared.nuclei.binary_sha256));
  check(equal(prepared.templates, policy.templates) && prepared.zap_hook_sha256 === hookHash && prepared.zap_common_original_sha256 === policy.zap.common_original_sha256 && prepared.zap_common_sha256 === policy.zap.common_sha256);
  check(object(run.nuclei_runtime) && run.nuclei_runtime.metrics_host === '127.0.0.1' && run.nuclei_runtime.metrics_port === 18091 && run.nuclei_runtime.ignore_after_sha256 === policy.templates.ignore_sha256);
  check(object(run.containers) && digest(run.containers.anchor_id) && digest(run.containers.zap_id) && run.containers.anchor_id !== run.containers.zap_id &&
    typeof run.containers.namespace === 'string' && /^net:\[[1-9][0-9]*\]$/.test(run.containers.namespace) && run.containers.namespace.trim() === run.containers.namespace);
  const bounds = windowOf(run);
  check(object(run.stages) && object(run.stages.nuclei) && object(run.stages.zap), 'terminal');
  const nuclei = windowOf(run.stages.nuclei), zap = windowOf(run.stages.zap);
  check(bounds[0] <= nuclei[0] && nuclei[1] <= zap[0] && zap[1] <= bounds[1]);
}
function health(run) {
  const fail = value => check(value, 'health'), bounds = windowOf(run, 'health');
  if (run.kind === 'positive_control') {
    fail(Array.isArray(run.health) && run.health.length === 0 && object(run.control_health));
    const h = run.control_health;
    fail(equal(Object.keys(h).sort(), ['after', 'before', 'paths']));
    for (const key of ['before', 'after']) fail(equal(h[key], { status: 200, marker: 'MR21 synthetic detector control' }));
    fail(Array.isArray(h.paths) && h.paths.length <= 4096);
    for (const value of h.paths) {
      check(typeof value === 'string' && value.length <= 1024 && value.startsWith('/') && !value.startsWith('//') && !/[\u0000-\u001f\u007f\\?#]/.test(value), 'scope');
      check(new URL(value, ORIGIN).origin === ORIGIN, 'scope');
    }
    return;
  }
  const phases = ['initial', 'nuclei_before', 'nuclei_after', 'zap_before', 'zap_after'];
  fail(Array.isArray(run.health) && run.health.length === phases.length);
  let pid;
  const windows = run.health.map((h, i) => {
    fail(object(h) && h.phase === phases[i] && integer(h.proxy_pid) && h.proxy_pid > 0);
    if (i === 0) pid = h.proxy_pid;
    fail(h.proxy_pid === pid && h.proxy_alive === true && h.health_status === 200 && equal(h.health, { status: 'ok', phase: '1-measurement-proxy' }) &&
      h.message_status === 200 && h.answer === 'MR21 synthetic provider response' && h.input_tokens === 23 && h.output_tokens === 7 &&
      h.provider_before === i && h.provider_after === i + 1 && h.provider_rejected === 0 &&
      equal(h.capture, { sessions: 1, turns: i + 1, input_tokens: 23 * (i + 1), output_tokens: 7 * (i + 1) }));
    if (i === 0) fail(equal(h.routes, { docs: 200, openapi: 200, dashboard: 200, dashboard_graph: 200 }));
    const window = windowOf(h, 'health'); fail(window[0] >= bounds[0] && window[1] <= bounds[1]); return window;
  });
  const n = windowOf(run.stages.nuclei, 'health'), z = windowOf(run.stages.zap, 'health');
  fail(windows[0][1] <= windows[1][0] && windows[1][1] <= n[0] && n[1] <= windows[2][0] && windows[2][1] <= windows[3][0] &&
    windows[3][1] <= z[0] && z[1] <= windows[4][0]);
}
function safeCode(error) { return error instanceof ReportFailure && PRIORITY.includes(error.code) ? error.code : 'internal'; }

export function evaluateRun(directory) {
  const summary = emptySummary();
  try {
    check(typeof directory === 'string' && directory.length > 0, 'usage');
    const dir = path.resolve(directory), parent = path.join(ROOT, '.workflow/proofs/dast');
    check(path.dirname(dir) === parent, 'input');
    containedDirectory(dir, ROOT);
    const bytes = {};
    for (const [name, cap] of Object.entries(FILES)) { bytes[name] = readContained(path.join(dir, name), ROOT, cap); decode(bytes[name]); }
    const run = parseJSON(bytes['run.json']), prepared = parseJSON(bytes['prepared.json']), isolation = parseJSON(bytes['isolation.json']);
    const before = parseJSON(bytes['zap-before-report.json']), completion = parseJSON(bytes['zap-completion.json']);
    const policy = parseJSON(readContained(path.join(ROOT, 'scripts/dast/policy.json'), ROOT, RECEIPT));
    const hookHash = sha256(readContained(path.join(ROOT, 'scripts/dast/zap-completion.py'), ROOT, RECEIPT));
    binding(run, prepared, bytes, policy, dir, hookHash);
    summary.run_id = run.run_id; summary.kind = run.kind;
    const errors = [], record = action => { try { return action(); } catch (error) { errors.push(safeCode(error)); return null; } };
    const nuclei = record(() => parseNucleiReports({ jsonl: bytes['nuclei.jsonl'], stderr: bytes['nuclei.stderr.log'], errors: bytes['nuclei-errors.log'], stage: run.stages.nuclei }));
    const zap = record(() => parseZapReport({ report: bytes['zap.json'], before, completion, stage: run.stages.zap, run, hookHash }));
    if (nuclei) { const { records, ...projection } = nuclei; summary.nuclei = projection; }
    if (zap) { const { detections, started, ...projection } = zap; summary.zap = projection; }
    summary.scan_complete = Boolean(nuclei && zap);
    record(() => {
      check(isolation.namespace === run.containers.namespace, 'isolation');
      assertIsolation(isolation, { run_id: run.run_id, kind: run.kind, prepared, prepared_sha256: run.prepared_sha256,
        ...run.containers, started_at: run.started_at, finished_at: run.finished_at, stages: run.stages });
      if (zap) {
        const live = isolation.observations.find(o => o.phase === 'zap_live'), started = zap.started;
        const ports = run.kind === 'application' ? [18080, 18081, 18090] : [18080, 18090];
        check(started.namespace === run.containers.namespace && started.namespace === live.namespace &&
          equal(started.socket_tables, live.socket_tables) && Array.isArray(started.listeners) &&
          equal([...started.listeners].sort((a, b) => a?.[1] - b?.[1]), ports.map(port => ['127.0.0.1', port])), 'isolation');
      }
    });
    record(() => health(run));
    if (summary.scan_complete) {
      if (run.kind === 'positive_control' && (!nuclei.records.some(r => r.template_id === 'laravel-env' && r.severity === 'high') ||
        !nuclei.records.some(r => r.template_id === 'git-config' && r.severity === 'medium') || !zap.detections.some(d => d.id === '10062' && d.risk === '3'))) errors.push('control_missing_detection');
      if (nuclei.counts.high || nuclei.counts.critical || zap.alerts['3']) errors.push('high_finding');
      if (run.kind === 'positive_control') errors.push('control_only');
    }
    summary.reason = errors.length ? errors.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0] : 'ok';
    summary.verdict = summary.reason === 'ok' && summary.scan_complete && run.kind === 'application' ? 'PASS' : 'INDETERMINATE';
  } catch (error) { summary.reason = safeCode(error); }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = process.argv.length === 3 ? evaluateRun(process.argv[2]) : { ...emptySummary(), reason: 'usage' };
  process.stdout.write(JSON.stringify(summary) + '\n'); process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
