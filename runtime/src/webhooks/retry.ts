/**
 * Webhook delivery retries (docs/WEBHOOKS.md §Delivery and Retries).
 *
 * On a retryable failure (network error, timeout, 5xx, 429), retry with the documented backoff
 * 5s → 30s → 5min → 30min → 2hr (5 retries), each delay jittered by ±20% and replaced by a server
 * Retry-After when one is given (clamped to the longest backoff). Never retried: other 4xx, redirects,
 * SSRF refusals, or any result whose `retryable` is not exactly true. A total-time cap stops the
 * sequence early (budget_exhausted). Each retry re-runs a full delivery attempt, so the hostname is
 * resolved and vetted afresh and pinned within that attempt. After the last failure the event is
 * reported through `onUndelivered` (production: the local dead-letter store). In-memory
 * single-instance scheduling: the `schedule` timer, `random` and `now` are INJECTED, so the whole
 * sequence is deterministic in tests. The test endpoint stays single-shot.
 */

import type { DeliveryResult, ReasonClass, Transport, DeliveryDeps } from "./deliver";
import { deliverWebhook, productionLookup } from "./deliver";
import { EVENT_ID_PATTERN, type UndeliveredInfo } from "./dead-letter";
import { createHttpTransport } from "./transport";

export type { UndeliveredInfo } from "./dead-letter";

/** Backoff schedule (ms): 5s, 30s, 5min, 30min, 2hr (docs/WEBHOOKS.md). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000, 7_200_000];

/** Default cap on the time from the first attempt to the last scheduled retry. */
export const DEFAULT_MAX_TOTAL_MS = 3 * 60 * 60 * 1000;

export interface RetrierDeps {
  /** One delivery attempt. */
  deliver: (url: string, payload: string, secret: string) => Promise<DeliveryResult>;
  /** Schedule `fn` to run after `delayMs` (setTimeout in prod, collected in tests). */
  schedule: (fn: () => Promise<void>, delayMs: number) => void;
  /** Called after delivery is given up on (log/persist the undelivered event). */
  onUndelivered?: (info: UndeliveredInfo) => void;
  /** Uniform [0,1) source for jitter (Math.random in prod). */
  random?: () => number;
  /** Clock in ms (Date.now in prod). */
  now?: () => number;
  /** Cap on elapsed time since the first attempt (default 3h). */
  maxTotalMs?: number;
}

export interface WebhookRetrier {
  /** Attempt delivery; on failure, schedule the backoff retries in the background. Returns the FIRST attempt. */
  send: (url: string, payload: string, secret: string, eventId: string) => Promise<DeliveryResult>;
}

/** Build an in-memory backoff retrier around a delivery function. */
export function createWebhookRetrier(deps: RetrierDeps): WebhookRetrier {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const maxTotalMs = deps.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const maxDelayMs = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] as number;

  const giveUp = (url: string, eventId: string, attempts: number, last: DeliveryResult, reasonClass: ReasonClass, firstAt: number): void => {
    deps.onUndelivered?.({
      eventId,
      url,
      attempts,
      ...(last.status !== undefined ? { lastStatus: last.status } : {}),
      reasonClass,
      firstAttemptAt: new Date(firstAt).toISOString(),
      lastAttemptAt: new Date(now()).toISOString(),
    });
  };

  const afterFailure = (url: string, payload: string, secret: string, eventId: string, last: DeliveryResult, attemptIdx: number, firstAt: number): void => {
    const attempts = attemptIdx + 1; // attempts made so far
    const cls = last.reasonClass ?? "network";
    if (last.retryable !== true) return giveUp(url, eventId, attempts, last, cls, firstAt);
    if (attemptIdx >= RETRY_DELAYS_MS.length) return giveUp(url, eventId, attempts, last, cls, firstAt);
    const ra = last.retryAfterMs;
    const delay = ra !== undefined && Number.isFinite(ra) && ra >= 0 ? Math.min(ra, maxDelayMs) : (RETRY_DELAYS_MS[attemptIdx] as number) * (0.8 + 0.4 * random());
    if (now() - firstAt + delay > maxTotalMs) return giveUp(url, eventId, attempts, last, "budget_exhausted", firstAt);
    deps.schedule(async () => {
      // Recheck the cap at fire time: a busy event loop can delay the timer past the budget.
      if (now() - firstAt > maxTotalMs) return giveUp(url, eventId, attempts, last, "budget_exhausted", firstAt);
      const r = await deps.deliver(url, payload, secret);
      if (!r.delivered) afterFailure(url, payload, secret, eventId, r, attemptIdx + 1, firstAt);
    }, delay);
  };

  return {
    async send(url: string, payload: string, secret: string, eventId: string): Promise<DeliveryResult> {
      if (!EVENT_ID_PATTERN.test(eventId)) throw new Error("invalid webhook event id");
      const firstAt = now();
      const first = await deps.deliver(url, payload, secret);
      if (!first.delivered) afterFailure(url, payload, secret, eventId, first, 0, firstAt);
      return first;
    },
  };
}

/** Production retrier: vetted + pinned delivery, setTimeout scheduling, dead-lettering on give-up. */
export function createDefaultWebhookRetrier(
  transport: Transport = createHttpTransport(),
  onUndelivered?: (info: UndeliveredInfo) => void,
  lookup: DeliveryDeps["lookup"] = productionLookup,
): WebhookRetrier {
  return createWebhookRetrier({
    deliver: (url, payload, secret) => deliverWebhook(url, payload, secret, { lookup, transport }),
    schedule: (fn, delayMs) => {
      setTimeout(() => void fn().catch(() => undefined), delayMs).unref();
    },
    ...(onUndelivered !== undefined ? { onUndelivered } : {}),
  });
}
