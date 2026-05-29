/**
 * Retry / backoff wrapper for upstream Anthropic forwarding (§2d).
 *
 * Policy (per plan.md §2d):
 *   - 429 Too Many Requests → wait the `Retry-After` header (seconds) when
 *     present, else exponential backoff; retry up to maxRetries.
 *   - 5xx → exponential backoff with jitter; retry up to maxRetries.
 *   - network/transport error (the forward fn throws) → retry ONCE, then surface.
 *   - 2xx / 4xx (non-429) → return immediately (never retried).
 *
 * `sleep` and `rng` are injectable so the policy is unit-testable without real
 * timers or nondeterministic jitter.
 */

import type { ForwardResult, MessagesBody } from "./forward";

export type ForwardFn = (body: MessagesBody, apiKey: string) => Promise<ForwardResult>;

export interface RetryConfig {
  /** Max retries for 429/5xx (network errors get exactly one retry). Default 3. */
  maxRetries: number;
  /** Base backoff in ms (exponential: base * 2^attempt). Default 500. */
  baseDelayMs: number;
  /** Cap on any single backoff (incl. Retry-After), ms. Default 30_000. */
  maxDelayMs: number;
  /** Injectable sleep (default real setTimeout). */
  sleep: (ms: number) => Promise<void>;
  /** Injectable [0,1) jitter source (default Math.random). */
  rng: () => number;
}

const DEFAULTS: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  rng: Math.random,
};

/** Parse a Retry-After header (delta-seconds form) into ms; null if absent/invalid. */
export function parseRetryAfterMs(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // HTTP-date form is rare for this API; ignore (fall back to exponential).
  return null;
}

/**
 * Wrap a forward function with the retry/backoff policy above.
 *
 * @param forward - the underlying forward (e.g. forwardToAnthropic-bound).
 * @param config - partial overrides; unset fields use {@link DEFAULTS}.
 * @returns a forward fn with identical signature that applies retries.
 */
export function withRetry(forward: ForwardFn, config: Partial<RetryConfig> = {}): ForwardFn {
  const cfg: RetryConfig = { ...DEFAULTS, ...config };

  const expBackoff = (attempt: number): number => {
    const base = cfg.baseDelayMs * Math.pow(2, attempt);
    const jitter = base * 0.25 * cfg.rng(); // up to +25% jitter
    return Math.min(cfg.maxDelayMs, Math.round(base + jitter));
  };

  return async (body: MessagesBody, apiKey: string): Promise<ForwardResult> => {
    let networkRetried = false;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result: ForwardResult;
      try {
        result = await forward(body, apiKey);
      } catch (err) {
        if (!networkRetried) {
          networkRetried = true;
          await cfg.sleep(cfg.baseDelayMs);
          continue; // does NOT consume an HTTP-retry attempt
        }
        throw err; // second network failure → surface
      }

      const retryable = result.status === 429 || (result.status >= 500 && result.status < 600);
      if (!retryable || attempt >= cfg.maxRetries) {
        return result;
      }

      const delay =
        result.status === 429
          ? (parseRetryAfterMs(result.headers) ?? expBackoff(attempt))
          : expBackoff(attempt);
      await cfg.sleep(Math.min(cfg.maxDelayMs, delay));
      attempt++;
    }
  };
}
