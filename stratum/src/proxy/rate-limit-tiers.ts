/**
 * Per-plan rate-limit tiers (docs/RATE_LIMITS.md) — pure table + lookups.
 *
 * The proxy rate-limits requests-per-minute per ORG by the org's plan (commercial mode); the
 * request limit is enforced via @fastify/rate-limit's dynamic `max`. Token-budget + concurrent-
 * session caps (also in the spec) need windowed accounting / session tracking — a later slice.
 */

export interface PlanLimits {
  requestsPerMinute: number;
  requestsPerHour: number;
  concurrentSessions: number;
}

/** Plan → limits (docs/RATE_LIMITS.md §CQ Proxy Rate Limits). Custom = generous negotiated defaults. */
export const PLAN_RATE_LIMITS: Record<string, PlanLimits> = {
  starter: { requestsPerMinute: 20, requestsPerHour: 500, concurrentSessions: 1 },
  growth: { requestsPerMinute: 60, requestsPerHour: 2_000, concurrentSessions: 5 },
  enterprise: { requestsPerMinute: 300, requestsPerHour: 10_000, concurrentSessions: 25 },
  custom: { requestsPerMinute: 1_000, requestsPerHour: 50_000, concurrentSessions: 100 },
};

/** The limits for a plan, falling back to starter for an unknown plan. */
export function planLimits(plan: string): PlanLimits {
  return PLAN_RATE_LIMITS[plan] ?? PLAN_RATE_LIMITS["starter"]!;
}

/** Requests-per-minute allowance for a plan (the rate-limit `max`). */
export function planRequestsPerMinute(plan: string): number {
  return planLimits(plan).requestsPerMinute;
}
