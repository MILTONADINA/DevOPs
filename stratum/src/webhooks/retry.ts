/**
 * Webhook delivery retries (docs/WEBHOOKS.md §Delivery and Retries).
 *
 * On a failed delivery, retry with exponential backoff 5s → 30s → 5min → 30min → 2hr (5 attempts);
 * after the last failure, the event is marked undelivered + logged. In-memory single-instance
 * scheduling (the same model as the rate limiter / token budget) — the `schedule` timer is INJECTED,
 * so the whole backoff sequence is deterministically testable. Build-ahead of event-driven delivery
 * (the test endpoint stays single-shot; production event sources route through this retrier).
 */

import type { DeliveryFetch, DeliveryResult } from "./deliver";
import { deliverWebhook } from "./deliver";

/** Backoff schedule (ms): 5s, 30s, 5min, 30min, 2hr (docs/WEBHOOKS.md). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000, 7_200_000];

export interface UndeliveredInfo {
  url: string;
  attempts: number;
}

export interface RetrierDeps {
  /** One delivery attempt. */
  deliver: (url: string, payload: string, secret: string) => Promise<DeliveryResult>;
  /** Schedule `fn` to run after `delayMs` (setTimeout in prod, collected in tests). */
  schedule: (fn: () => Promise<void>, delayMs: number) => void;
  /** Called after all retries fail (log/persist the undelivered event). */
  onUndelivered?: (info: UndeliveredInfo) => void;
}

export interface WebhookRetrier {
  /** Attempt delivery; on failure, schedule the backoff retries in the background. Returns the FIRST attempt. */
  send: (url: string, payload: string, secret: string) => Promise<DeliveryResult>;
}

/** Build an in-memory backoff retrier around a delivery function. */
export function createWebhookRetrier(deps: RetrierDeps): WebhookRetrier {
  const scheduleRetry = (url: string, payload: string, secret: string, attemptIdx: number): void => {
    if (attemptIdx >= RETRY_DELAYS_MS.length) {
      deps.onUndelivered?.({ url, attempts: RETRY_DELAYS_MS.length + 1 }); // initial + all retries
      return;
    }
    deps.schedule(async () => {
      const r = await deps.deliver(url, payload, secret);
      if (!r.delivered) scheduleRetry(url, payload, secret, attemptIdx + 1);
    }, RETRY_DELAYS_MS[attemptIdx] as number);
  };

  return {
    async send(url: string, payload: string, secret: string): Promise<DeliveryResult> {
      const first = await deps.deliver(url, payload, secret);
      if (!first.delivered) scheduleRetry(url, payload, secret, 0);
      return first;
    },
  };
}

/** Production retrier: real fetch delivery + setTimeout scheduling. */
export function createDefaultWebhookRetrier(doFetch: DeliveryFetch = (url, init) => fetch(url, init), onUndelivered?: (info: UndeliveredInfo) => void): WebhookRetrier {
  return createWebhookRetrier({
    deliver: (url, payload, secret) => deliverWebhook(url, payload, secret, doFetch),
    schedule: (fn, delayMs) => {
      setTimeout(() => void fn(), delayMs);
    },
    ...(onUndelivered !== undefined ? { onUndelivered } : {}),
  });
}
