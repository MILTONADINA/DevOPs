// Minimal client for TypeSafe's System One API (Jev), built on Node built-ins.
// Spec: specs/graph/J-jev-judgments.md. API contract: https://docs.typesafe.ai/api.md
//
// Jev answers narrow, typed questions (choice, score, noul) about a `state`
// with calibrated probabilities. Code owns the workflow: callers gate on
// confidence with decide() and escalate the uncertain remainder. A Jev answer
// is never proof of work on its own.
//
// Only repository text and this project's own logs may be sent. The client
// refuses secret-shaped content and the API key itself, and reads the key from
// TYPESAFE_API_KEY or from the file named by TYPESAFE_API_KEY_FILE.

import { readFileSync } from 'node:fs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RETRYABLE = new Set([429, 529]);
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 8000;

export class JevUnavailableError extends Error {
  constructor(message = 'TYPESAFE_API_KEY is not set; Jev is unavailable, use the non-Jev path') {
    super(message);
    this.name = 'JevUnavailableError';
  }
}

export class JevSecretInStateError extends Error {
  constructor(rule) {
    super(`refusing to send content matching the ${rule} secret shape to Jev`);
    this.name = 'JevSecretInStateError';
    this.rule = rule;
  }
}

export class JevHttpError extends Error {
  constructor(status, body) {
    super(`Jev request failed: ${status}${body ? ` ${String(body).slice(0, 300)}` : ''}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
  }
}

// Ordered: the first matching rule names the refusal.
const SECRET_RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['connection-uri-password', /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s"'@]+:[^@/\s"']{8,}@/i],
];

/**
 * The API key: TYPESAFE_API_KEY if set, else the key read from the file named by
 * TYPESAFE_API_KEY_FILE (plain text or RTF, so a key saved from a text editor
 * works), else undefined. The file path, never the key, is what belongs in local
 * machine settings.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function resolveApiKey(env = process.env) {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  if (!env.TYPESAFE_API_KEY_FILE) return undefined;
  let text;
  try { text = readFileSync(env.TYPESAFE_API_KEY_FILE, 'utf8'); } catch { return undefined; }
  if (text.startsWith('{\\rtf')) {
    text = text.replace(/\{\\\*[^{}]*\}/g, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, ' ');
  }
  const tokens = text.match(/[A-Za-z0-9_.-]{24,}/g) || [];
  return tokens.sort((a, b) => b.length - a.length)[0];
}

/**
 * Name the first secret shape found in `text`, or null.
 * @param {string} text
 * @returns {string | null}
 */
export function findSecret(text) {
  for (const [rule, re] of SECRET_RULES) if (re.test(text)) return rule;
  return null;
}

/**
 * Return an answer's value when its confidence clears the threshold; otherwise
 * {uncertain: true}, so the caller escalates. A noul is decided when it is at
 * least `minNoulMargin` away from 0.5.
 * @param {{type: string, choice?: string, score?: number, noul?: number, confidence?: number}} answer
 * @param {{minConfidence?: number, minNoulMargin?: number}} [opts]
 */
export function decide(answer, { minConfidence = 0.8, minNoulMargin = 0.3 } = {}) {
  if (answer.type === 'noul') {
    if (answer.noul >= 0.5 + minNoulMargin) return true;
    if (answer.noul <= 0.5 - minNoulMargin) return false;
    return { uncertain: true };
  }
  if ((answer.confidence ?? 0) < minConfidence) return { uncertain: true };
  return answer.type === 'score' ? answer.score : answer.choice;
}

function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { yield k; yield* strings(v); }
  }
}

function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Ask Jev typed questions about a state.
 * @param {object} args
 * @param {string | object | Array<unknown>} args.state
 * @param {Record<string, object>} args.questions
 * @param {string} [args.model]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxAttempts]
 * @param {Record<string, string | undefined>} [args.env] - where the key is resolved from when apiKey is not given
 * @param {string} [args.apiKey]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.random]
 * @returns {Promise<{model: string, answers: Record<string, object>, usage: object}>}
 */
export async function evaluate({
  state,
  questions,
  model = 'jev-latest',
  timeoutMs = 30000,
  maxAttempts = 4,
  env = process.env,
  apiKey = resolveApiKey(env),
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
}) {
  if (!apiKey) throw new JevUnavailableError();
  // Scan every raw string (keys and values) rather than the serialized body:
  // JSON escaping turns a newline into a literal backslash-n, which would hide
  // a secret that starts a line from the word-boundary patterns.
  for (const text of strings({ state, questions })) {
    if (text.includes(apiKey)) throw new JevSecretInStateError('api-key');
    const rule = findSecret(text);
    if (rule) throw new JevSecretInStateError(rule);
  }
  const body = JSON.stringify({ state, model, questions });

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastError = new JevHttpError(err?.name === 'AbortError' ? 'timeout' : 'network', err?.message);
      if (attempt < maxAttempts) await sleep(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res.json();
    const text = await res.text();
    lastError = new JevHttpError(res.status, text);
    if (!RETRYABLE.has(res.status)) throw lastError;
    if (attempt < maxAttempts) {
      const wait = retryAfterMs(res) ?? random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      await sleep(wait);
    }
  }
  throw lastError;
}
