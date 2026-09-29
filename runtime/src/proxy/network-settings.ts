/**
 * Shared, pure network-settings helpers (specs/security/stratum-local-network.md).
 *
 * A leaf module imported by BOTH ./app.ts (the Host check's loopback `listenHost`, REQ-2, and the
 * RATE_LIMIT_MAX fallback, REQ-4) and ./index.ts (the startup bind, upstream and numeric-setting
 * checks, REQ-3 to REQ-5). app.ts cannot take these helpers from index.ts without an
 * app.ts → index.ts → app.ts cycle, because index.ts imports `buildProxy` from ./app.ts.
 * `resolvePort` has no app.ts caller; it sits beside `resolveRateLimitMax`, the other REQ-4
 * numeric-setting check.
 */

/**
 * True when `host` names a loopback BIND address (the loopback address REQ-3 and REQ-5 refer to):
 * the literal name "localhost", any IPv4 address in 127.0.0.0/8, or "::1". The bracketed spelling
 * `[::1]` counts too: one enclosing pair of square brackets around text that contains a ':' is
 * removed, once, before the checks (REQ-3, AC-4). So `[[::1]]` (removing one pair leaves `[::1]`),
 * `[::1`, `::1]`, `[localhost]` and `[127.0.0.1]` are NOT loopback.
 * Two independent callers share this one predicate: index.ts's REQ-3/REQ-5 startup gates
 * ({@link assertRemoteBindAllowed}, {@link assertUpstreamAllowed}) ask whether the address the proxy
 * itself binds (or an upstream base URL's host) is loopback; app.ts asks whether the CONFIGURED
 * `listenHost` is loopback, to decide whether to also accept its literal value as a Host name
 * (REQ-2's Definitions entry for a loopback name). Deliberately WIDER than the loopback names app.ts
 * accepts as a Host (the three fixed names 127.0.0.1, localhost and [::1], plus the configured
 * `listenHost` itself when that is loopback): this one classifies an address, that one a Host
 * header. Deliberately narrow: an expanded IPv6 loopback spelling (`0:0:0:0:0:0:0:1`) or a mapped
 * form (`::ffff:127.0.0.1`), bracketed or not, is treated as NON-loopback (fails closed, requiring
 * auth or the opt-in), because this predicate accepts exactly "localhost", 127.0.0.0/8 and "::1";
 * `[::1]` is that same `::1` in URL notation, not another address.
 *
 * @param host - the candidate bind address (any case; leading/trailing whitespace tolerated).
 * @returns whether it names a loopback bind address.
 */
export function isLoopbackBindAddress(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  // The text inside one enclosing pair of square brackets ("" when there is none); it replaces the value only when it holds a ':'.
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : "";
  const h = inner.includes(":") ? inner : trimmed;
  if (h === "localhost" || h === "::1") return true;
  const octets = h.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === "127";
}

// --- specs/security/stratum-local-network.md — REQ-4 (numeric settings fail closed). ---

/**
 * Parses `raw` as a base-10, unsigned integer written as nothing but ASCII digits — rejecting
 * `parseInt`'s own silent truncation of trailing garbage (`parseInt("4080abc", 10) === 4080`) and
 * `Number`'s own leniency (leading/trailing whitespace, `"0x10"`, `"1e3"`, `""` coercing to `0`).
 *
 * @param raw - the raw env-var string.
 * @returns the parsed integer, or `undefined` when `raw` is not exactly a run of digits or does not
 *   fit a JS safe integer.
 */
function parseStrictNonNegativeInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * REQ-4's PORT validation (specs/security/stratum-local-network.md): returns the default 4080 when
 * `env.PORT` is unset. Otherwise throws an Error naming "PORT" and the exact raw
 * string rejected when it is not an integer from 1 to 65535 inclusive (a blank string is set-but-
 * invalid, not unset, and is rejected the same way). Pure and side-effect-free so `start()` can call
 * it before any network or database connection is attempted, mirroring {@link assertRemoteBindAllowed}
 * (index.ts).
 *
 * @param env - the relevant environment (reads PORT only).
 * @returns the validated port number.
 * @throws {Error} naming PORT and the rejected raw string when set and invalid.
 */
export function resolvePort(env: { PORT?: string | undefined }): number {
  const raw = env.PORT;
  if (raw === undefined) return 4080;
  const n = parseStrictNonNegativeInteger(raw);
  if (n === undefined || n < 1 || n > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; got ${JSON.stringify(raw)}.`);
  }
  return n;
}

/**
 * REQ-4's RATE_LIMIT_MAX validation (specs/security/stratum-local-network.md): returns the default
 * 100 when `env.RATE_LIMIT_MAX` is unset. Otherwise throws an Error naming "RATE_LIMIT_MAX" and the
 * exact raw string rejected when it is not a positive integer (>= 1; a blank string is
 * set-but-invalid, not unset, and is rejected the same way). Pure and side-effect-free.
 *
 * Called from TWO places: `start()` (index.ts) calls it early, before `createDefaultMessagesDeps()`/
 * `buildStartOptions()` can construct a provider or Supabase client, so an invalid value refuses
 * before any network or database connection is attempted, in every mode; `buildProxy()`'s own
 * per-IP rate-limit fallback (app.ts) calls it too, so a caller that builds the app directly and
 * skips `start()` entirely still fails closed on an invalid value when its options take that path
 * (e.g. a test built on `app.inject()` that passes no `rateLimit`). `buildProxy()` calls this ONLY
 * on that fallback path — when `opts.rateLimit` is neither `false` nor a number AND
 * `opts.rateLimitByPlan` is not set — so an explicit numeric `opts.rateLimit` passed directly to
 * `buildProxy()` bypasses RATE_LIMIT_MAX entirely, and so does a `rateLimitByPlan` (team mode),
 * where the org's plan sets the limit.
 *
 * @param env - the relevant environment (reads RATE_LIMIT_MAX only).
 * @returns the validated rate-limit ceiling.
 * @throws {Error} naming RATE_LIMIT_MAX and the rejected raw string when set and invalid.
 */
export function resolveRateLimitMax(env: { RATE_LIMIT_MAX?: string | undefined }): number {
  const raw = env.RATE_LIMIT_MAX;
  if (raw === undefined) return 100;
  const n = parseStrictNonNegativeInteger(raw);
  if (n === undefined || n < 1) {
    throw new Error(`RATE_LIMIT_MAX must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return n;
}
