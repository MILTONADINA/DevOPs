// Unit tests for the per-plan rate-limit table (pure).

import { describe, test, expect } from "vitest";
import { planRequestsPerMinute, planLimits, PLAN_RATE_LIMITS } from "../../src/proxy/rate-limit-tiers";

describe("rate-limit tiers", () => {
  test("requests-per-minute matches RATE_LIMITS.md per plan", () => {
    expect(planRequestsPerMinute("starter")).toBe(20);
    expect(planRequestsPerMinute("growth")).toBe(60);
    expect(planRequestsPerMinute("enterprise")).toBe(300);
    expect(planRequestsPerMinute("custom")).toBe(1_000);
  });
  test("an unknown plan falls back to starter (never unlimited)", () => {
    expect(planRequestsPerMinute("mystery")).toBe(20);
    expect(planLimits("mystery")).toEqual(PLAN_RATE_LIMITS["starter"]);
  });
  test("limits include rph + concurrent sessions per the spec", () => {
    expect(planLimits("growth")).toEqual({ requestsPerMinute: 60, requestsPerHour: 2_000, concurrentSessions: 5 });
  });
});
