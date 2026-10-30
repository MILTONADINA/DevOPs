/**
 * Webhook delivery (Phase 2+ commercial) — signed POST with an SSRF guard + timeout.
 *
 * The webhook URL is CUSTOMER-PROVIDED, so delivery is an SSRF surface: a malicious/misconfigured
 * URL must never let us POST to an internal address (cloud metadata 169.254.169.254, localhost,
 * RFC-1918, link-local). Two layers:
 *  1. isSafeWebhookUrl (URL layer, defense in depth): scheme, no userinfo, no localhost, and literal
 *     private IPs (numeric check via isPublicAddress, so every IPv6 encoding of an IPv4 is covered).
 *  2. Per attempt, the hostname is resolved ONCE, EVERY returned address must be public (a mixed
 *     public+private answer is refused), and the transport connects to exactly that vetted address
 *     (Host/SNI stay the hostname), so a DNS-rebinding answer cannot change between vet and connect.
 * Redirects are never followed (the transport returns a 3xx as-is, which is a non-retryable failure).
 *
 * One attempt per call; retries and dead-lettering live in retry.ts. Resolver and transport are
 * injected so this is fully testable with no network.
 */

import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import { isPublicAddress } from "./address-guard";
import { signWebhook, SIGNATURE_HEADER } from "./sign";

/** Validate a customer webhook URL against the SSRF guard (URL layer). */
export function isSafeWebhookUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "URL must be http(s)" };
  if (u.port === "0") return { ok: false, reason: "port 0 is not a valid webhook target" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "URL credentials are not allowed" };
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, ""); // strip IPv6 brackets + trailing dot
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "localhost is not an allowed webhook target" };
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    return { ok: false, reason: isIP(host) === 6 ? "private/loopback IPv6 is not an allowed webhook target" : "private/loopback IPv4 is not an allowed webhook target" };
  }
  return { ok: true };
}

export type ReasonClass = "network" | "timeout" | "http_5xx" | "http_429" | "http_4xx" | "redirect" | "ssrf_blocked" | "budget_exhausted";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface TransportRequest {
  /** The URL hostname: used for Host and TLS SNI/certificate validation, never for connecting. */
  hostname: string;
  /** The vetted address to connect to. */
  address: string;
  family: number;
  port: number;
  path: string;
  secure: boolean;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type Transport = (req: TransportRequest) => Promise<{ status: number; retryAfter?: string }>;

export interface DeliveryDeps {
  /** Resolve a hostname to all its addresses (dns.promises.lookup all:true in production). */
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  transport: Transport;
  /** Clock for Retry-After HTTP dates (Date.now by default). */
  now?: () => number;
}

export interface DeliveryResult {
  delivered: boolean;
  status?: number;
  reason?: string;
  /** Whether a later attempt could succeed (network, timeout, 5xx, 429 only). */
  retryable: boolean;
  reasonClass?: ReasonClass;
  /** Server-requested delay in ms from Retry-After (unclamped; the retrier clamps it). */
  retryAfterMs?: number;
}

/** Production dependencies: OS resolver (all addresses) + the pinned node:http(s) transport. */
export async function productionLookup(hostname: string): Promise<ResolvedAddress[]> {
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
}

/** Parse Retry-After: delta-seconds or HTTP-date. NaN/negative/garbage -> undefined; past date -> 0. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) {
    const s = Number(v);
    return Number.isFinite(s) ? s * 1000 : undefined;
  }
  if (!/^[A-Za-z]{3},/.test(v)) return undefined; // HTTP-date only (Date.parse("-5") would be a past year)
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const refuse = (reason: string): DeliveryResult => ({ delivered: false, reason, retryable: false, reasonClass: "ssrf_blocked" });

/** Race a promise against the attempt signal (dns.lookup has no timeout of its own). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Sign + POST a webhook payload to the customer URL (single attempt, time-bounded).
 *
 * @param url - the customer webhook URL (SSRF-checked first).
 * @param payload - the raw JSON body to send (and sign).
 * @param secret - the org's webhook secret.
 * @param deps - resolver + transport (production: productionLookup + createHttpTransport()).
 * @param timeoutMs - ONE budget per attempt shared by resolve, connect and response (default 10s); slow DNS shortens the rest by design, and a timeout is retryable.
 */
export async function deliverWebhook(url: string, payload: string, secret: string, deps: DeliveryDeps, timeoutMs = 10_000): Promise<DeliveryResult> {
  const safe = isSafeWebhookUrl(url);
  if (!safe.ok) return refuse(safe.reason);
  const u = new URL(url);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let addresses: ResolvedAddress[];
    const literal = isIP(hostname);
    if (literal !== 0) {
      addresses = [{ address: hostname, family: literal }];
    } else {
      addresses = await raceAbort(deps.lookup(hostname), controller.signal);
    }
    if (addresses.length === 0) return refuse("hostname did not resolve to any address");
    if (!addresses.every((a) => isPublicAddress(a.address))) return refuse("hostname resolves to a non-public address");
    const target = addresses[0] as ResolvedAddress;

    const secure = u.protocol === "https:";
    const r = await raceAbort(
      deps.transport({
        hostname,
        address: target.address,
        family: target.family,
        port: u.port !== "" ? Number(u.port) : secure ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        secure,
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signWebhook(payload, secret) },
        body: payload,
        signal: controller.signal,
      }),
      controller.signal,
    );
    const s = r.status;
    if (s >= 200 && s < 300) return { delivered: true, status: s, retryable: false };
    const retryAfterMs = parseRetryAfter(r.retryAfter, (deps.now ?? Date.now)());
    const ra = retryAfterMs !== undefined ? { retryAfterMs } : {};
    if (s >= 300 && s < 400) return { delivered: false, status: s, reason: "redirect not followed", retryable: false, reasonClass: "redirect" };
    if (s === 429) return { delivered: false, status: s, retryable: true, reasonClass: "http_429", ...ra };
    if (s >= 500) return { delivered: false, status: s, retryable: true, reasonClass: "http_5xx", ...ra };
    if (s >= 400) return { delivered: false, status: s, retryable: false, reasonClass: "http_4xx" };
    return { delivered: false, status: s, retryable: false, reasonClass: "http_4xx" }; // 1xx / unknown: not a delivery, not worth retrying
  } catch (e) {
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
    return aborted
      ? { delivered: false, reason: "delivery timed out", retryable: true, reasonClass: "timeout" }
      : { delivered: false, reason: "delivery failed", retryable: true, reasonClass: "network" };
  } finally {
    clearTimeout(timer);
  }
}
