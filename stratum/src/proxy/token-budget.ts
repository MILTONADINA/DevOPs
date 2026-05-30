/**
 * Per-org token-budget rate limiting (docs/RATE_LIMITS.md §Token Budget).
 *
 * Caps the INPUT tokens an org sends to CQ per minute + per day by its plan (pre-pruning — the limit
 * protects CQ infrastructure). An in-memory fixed-window accumulator per org — the same single-instance
 * model @fastify/rate-limit uses by default (a multi-instance deploy would back this with Redis). The
 * plan is resolved through `getPlan` but cached (≤1 lookup/min/org) so it's not a per-request DB hit;
 * the clock is injectable, so the windowing is fully testable.
 */

import { planLimits } from "./rate-limit-tiers";

export interface BudgetResult {
  allowed: boolean;
  limitType?: "tokens_per_minute" | "tokens_per_day";
  limit?: number;
  used?: number;
}

interface Window {
  start: number;
  tokens: number;
}
interface OrgState {
  minute: Window;
  day: Window;
  plan: string;
  planAt: number;
}

export interface TokenBudgetDeps {
  /** Resolve an org's plan (drives the budgets). Cached per org. */
  getPlan: (orgId: string) => Promise<string>;
  /** Clock (default Date.now) — injected for deterministic window tests. */
  now?: () => number;
}

export interface TokenBudget {
  /** Try to consume `tokens` for `orgId`; allowed only if both windows stay within budget. */
  tryConsume: (orgId: string, tokens: number) => Promise<BudgetResult>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const PLAN_CACHE_MS = 60_000;

/** Build an in-memory per-org token-budget limiter. */
export function createTokenBudget(deps: TokenBudgetDeps): TokenBudget {
  const clock = deps.now ?? ((): number => Date.now());
  const state = new Map<string, OrgState>();

  return {
    async tryConsume(orgId: string, tokens: number): Promise<BudgetResult> {
      const t = clock();
      let s = state.get(orgId);
      if (s === undefined) {
        s = { minute: { start: t, tokens: 0 }, day: { start: t, tokens: 0 }, plan: await deps.getPlan(orgId), planAt: t };
        state.set(orgId, s);
      } else if (t - s.planAt >= PLAN_CACHE_MS) {
        s.plan = await deps.getPlan(orgId);
        s.planAt = t;
      }
      const limits = planLimits(s.plan);

      // Roll expired windows.
      if (t - s.minute.start >= MINUTE_MS) {
        s.minute.start = t;
        s.minute.tokens = 0;
      }
      if (t - s.day.start >= DAY_MS) {
        s.day.start = t;
        s.day.tokens = 0;
      }

      // Reject if adding these tokens would exceed either budget (don't consume on reject).
      if (s.minute.tokens + tokens > limits.tokensPerMinute) {
        return { allowed: false, limitType: "tokens_per_minute", limit: limits.tokensPerMinute, used: s.minute.tokens };
      }
      if (s.day.tokens + tokens > limits.tokensPerDay) {
        return { allowed: false, limitType: "tokens_per_day", limit: limits.tokensPerDay, used: s.day.tokens };
      }

      s.minute.tokens += tokens;
      s.day.tokens += tokens;
      return { allowed: true };
    },
  };
}
