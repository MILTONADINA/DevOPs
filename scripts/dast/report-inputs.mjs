// Fixed local DAST input boundaries and pure native report parsing (Annex A).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class ReportFailure extends Error {
  constructor(code) { super('dast-report: unavailable'); this.code = code; }
}
export const requireValue = (value, code) => { if (!value) throw new ReportFailure(code); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const integer = value => Number.isSafeInteger(value) && value >= 0;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ORIGIN = 'http://127.0.0.1:18080';
export const SEED = ORIGIN + '/docs';
export const digest = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
export function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
export function decode(bytes, code = 'input') {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ReportFailure(code); }
}
export function parseJSON(bytes, code = 'input') {
  try { const value = JSON.parse(decode(bytes, code)); requireValue(object(value), code); return value; }
  catch { throw new ReportFailure(code); }
}
export function containedDirectory(directory, root) {
  try {
    const relative = path.relative(root, directory);
    requireValue(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'input');
    let current = root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = fs.lstatSync(current);
      requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'input');
    }
  } catch { throw new ReportFailure('input'); }
}
export function readContained(file, root, cap) {
  let fd;
  try {
    containedDirectory(path.dirname(file), root);
    const before = fs.lstatSync(file);
    requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= cap, 'input');
    requireValue(typeof fs.constants.O_NOFOLLOW === 'number' && typeof fs.constants.O_NONBLOCK === 'number', 'input');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    requireValue(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'input');
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    requireValue(size === opened.size && after.size === size && after.nlink === 1 && after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs && named.isFile() && named.dev === after.dev && named.ino === after.ino && named.nlink === 1, 'input');
    containedDirectory(path.dirname(file), root);
    return bytes.subarray(0, size);
  } catch { throw new ReportFailure('input'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function utc(value, code = 'binding') {
  requireValue(typeof value === 'string' && value.trim() === value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value), code);
  const stamp = Date.parse(value);
  requireValue(Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 19) === value.slice(0, 19), code);
  return stamp;
}
export function windowOf(value, code = 'binding') {
  requireValue(object(value), code);
  const result = [utc(value.started_at, code), utc(value.finished_at, code)];
  requireValue(result[0] <= result[1], code); return result;
}
export function inside(value, window, code) {
  const stamp = utc(value, code); requireValue(stamp >= window[0] && stamp <= window[1], code); return stamp;
}
export function scopedURL(value) {
  requireValue(typeof value === 'string' && (value === ORIGIN || value.startsWith(ORIGIN + '/')) && !/[\u0000-\u0020\u007f\\]/.test(value), 'scope');
  try {
    const url = new URL(value);
    requireValue(url.origin === ORIGIN && url.protocol === 'http:' && !url.username && !url.password && !url.hash, 'scope');
  } catch { throw new ReportFailure('scope'); }
  return value;
}
export function terminal(stage, allowed) {
  requireValue(object(stage) && allowed.includes(stage.exit_code) && stage.signal === null &&
    stage.timed_out === false && stage.output_overflow === false, 'terminal');
  return windowOf(stage, 'binding');
}
function decimal(value, code, positive = false) {
  requireValue(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value), code);
  const number = Number(value); requireValue(integer(number) && String(number) === value && (!positive || number > 0), code); return number;
}

export function parseNucleiReports({ jsonl, stderr, errors, stage }) {
  const window = terminal(stage, [0]);
  requireValue(Buffer.isBuffer(jsonl) && jsonl.length <= 10 * 1024 * 1024 && Buffer.isBuffer(stderr) &&
    stderr.length <= 2 * 1024 * 1024 && Buffer.isBuffer(errors) && errors.length <= 2 * 1024 * 1024, 'input');
  const text = decode(jsonl), log = decode(stderr); decode(errors);
  requireValue(errors.length === 0 && !/\[(?:ERR|FTL)\]/.test(log), 'completion');
  const stats = log.split(/\r?\n/).filter(line => line.trimStart().startsWith('{')).map(line => parseJSON(Buffer.from(line), 'completion'));
  requireValue(stats.length === 2, 'completion');
  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const lines = text ? text.split(/\r?\n/) : [];
  if (text.endsWith('\n')) lines.pop();
  // Count framing before severity checks so a dropped record cannot hide a high.
  const values = lines.map(line => { requireValue(line.trim().length > 0, 'report'); return parseJSON(Buffer.from(line), 'report'); });
  for (const item of stats) {
    for (const key of ['errors', 'hosts', 'matched', 'percent', 'requests', 'rps', 'templates', 'total']) decimal(item[key], 'completion');
    requireValue(typeof item.duration === 'string' && /^(?:0|[1-9][0-9]*):[0-5][0-9]:[0-5][0-9]$/.test(item.duration), 'completion');
    inside(item.startedAt, window, 'completion');
    requireValue(item.templates === '2' && item.hosts === '1' && item.errors === '0' && item.percent === '100' &&
      item.requests === item.total && Number(item.total) > 0 && Number(item.matched) === values.length, 'completion');
  }
  for (const key of ['templates', 'hosts', 'matched', 'requests', 'total', 'errors', 'percent', 'startedAt'])
    requireValue(stats[0][key] === stats[1][key], 'completion');
  const records = values.map(item => {
    const id = item['template-id'], severity = id === 'laravel-env' ? 'high' : id === 'git-config' ? 'medium' : null;
    requireValue(severity && item.type === 'http' && item['matcher-status'] === true && object(item.info) && item.info.severity === severity, 'report');
    requireValue(item.host === '127.0.0.1' && item.port === '18080' && item.scheme === 'http' && item.url === ORIGIN && item.ip === '127.0.0.1', 'scope');
    scopedURL(item['matched-at']); inside(item.timestamp, window, 'report'); counts[severity]++;
    return { template_id: id, severity, matched_at: item['matched-at'], timestamp: item.timestamp };
  });
  return { complete: true, counts, engine_units: Number(stats[0].requests), engine_total: Number(stats[0].total), observed_http_requests: null, records };
}

export function parseZapReport({ report, before, completion, stage, run, hookHash }) {
  const window = terminal(stage, [0, 2]);
  for (const receipt of [before, completion]) requireValue(object(receipt) && receipt.schema_version === 1 && receipt.run_id === run.run_id &&
    receipt.seed === SEED && receipt.hook_sha256 === hookHash, 'binding');
  requireValue(Array.isArray(before.events) && before.events.length === 4 && Array.isArray(completion.events) && completion.events.length === 5 &&
    equal(before.events, completion.events.slice(0, 4)), 'completion');
  const names = ['started', 'spider_entered', 'spider_returned', 'before_report', 'before_shutdown'];
  let prior = -1n, priorUtc = -Infinity;
  completion.events.forEach((event, i) => {
    requireValue(object(event) && event.event === names[i] && typeof event.monotonic_ns === 'string' && event.monotonic_ns.trim() === event.monotonic_ns && /^(?:0|[1-9][0-9]*)$/.test(event.monotonic_ns), 'completion');
    const now = BigInt(event.monotonic_ns), stamp = inside(event.utc, window, 'completion');
    requireValue(now > prior && stamp >= priorUtc, 'completion'); prior = now; priorUtc = stamp;
  });
  const [started, spider, , pre, final] = completion.events;
  requireValue(spider.target === ORIGIN + '/' && pre.queue === '0' && final.queue === '0', 'completion');
  requireValue(Array.isArray(completion.urls) && completion.urls.length > 0 && completion.urls.length <= 4096 && completion.urls.includes(SEED), 'completion');
  completion.urls.forEach(scopedURL);
  requireValue(Array.isArray(completion.rules) && completion.rules.length > 0 && completion.rules.length <= 512, 'completion');
  for (const rule of completion.rules) requireValue(object(rule) && ['id', 'name', 'enabled', 'alertThreshold', 'quality', 'status'].every(k => typeof rule[k] === 'string') &&
    ['true', 'false'].includes(rule.enabled), 'completion');
  requireValue(completion.rules.some(rule => rule.id === '10062' && rule.enabled === 'true'), 'completion');
  requireValue(completion.report_sha256 === sha256(report) && completion.report_bytes === report.length, 'binding');
  const value = parseJSON(report, 'report');
  requireValue(value['@version'] === '2.17.0' && Array.isArray(value.site) && value.site.length === 1 && object(value.site[0]), 'report');
  const site = value.site[0];
  requireValue(site['@name'] === ORIGIN && site['@host'] === '127.0.0.1' && site['@port'] === '18080' && site['@ssl'] === 'false', 'scope');
  requireValue(Array.isArray(site.alerts), 'report');
  const alerts = { 0: 0, 1: 0, 2: 0, 3: 0 }, instances = { ...alerts }, detections = [];
  for (const alert of site.alerts) {
    requireValue(object(alert) && ['0', '1', '2', '3'].includes(alert.riskcode), 'report');
    decimal(alert.pluginid, 'report', true); const count = decimal(alert.count, 'report', true);
    requireValue(Array.isArray(alert.instances) && alert.instances.length === count, 'report');
    for (const instance of alert.instances) { requireValue(object(instance), 'report'); scopedURL(instance.uri); }
    alerts[alert.riskcode]++; instances[alert.riskcode] += count;
    requireValue(integer(instances[alert.riskcode]), 'report'); detections.push({ id: alert.pluginid, risk: alert.riskcode });
  }
  return { complete: true, alerts, instances, url_count: completion.urls.length, detections, started };
}
