// Tests for the dashboard: pure aggregation (dashboard-data) + the route
// (app.inject() with an injected session reader; no disk).

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildDashboardData } from "../../src/proxy/dashboard-data";
import type { CaptureSession, CapturedTurn } from "../../src/proxy/capture";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
const { buildProxy } = await import("../../src/proxy/app");

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function turn(input: number, content = "hi"): CapturedTurn {
  return {
    turn: 1,
    timestamp: 0,
    request: { model: "m", messages: [{ role: "user", content }], max_tokens: 8 },
    token_counts: { input_tokens: input, token_count_method: "exact", message_breakdown: [] },
    response: {},
    elapsed_ms: 1,
  };
}

function sess(id: string, turns: CapturedTurn[], inTok: number, outTok: number, dropped = 0): CaptureSession {
  return {
    session_id: id,
    started_at: "2026-05-29T00:00:00Z",
    total_turns: turns.length,
    total_input_tokens: inTok,
    total_output_tokens: outTok,
    dropped_turns: dropped,
    requests: turns,
  };
}

describe("buildDashboardData", () => {
  test("aggregates totals + cost estimate + waste", () => {
    const sys = "S".repeat(8000);
    const s1 = sess(
      "aaaaaaaa-1",
      [
        { ...turn(200), request: { model: "m", messages: [], system: sys, max_tokens: 8 } },
        { ...turn(400), request: { model: "m", messages: [], system: sys, max_tokens: 8 } },
      ],
      600,
      50,
      1,
    );
    const d = buildDashboardData([s1]);
    expect(d.session_count).toBe(1);
    expect(d.total_turns).toBe(2);
    expect(d.total_dropped_turns).toBe(1);
    expect(d.total_input_tokens).toBe(600);
    expect(d.total_output_tokens).toBe(50);
    expect(d.estimated_cost_usd).toBeGreaterThan(0);
    expect(d.waste.length).toBeGreaterThanOrEqual(1);
    expect(d.top_waste_type).toBeTruthy();
    // waste sorted descending
    for (let i = 1; i < d.waste.length; i++) {
      expect(d.waste[i - 1]!.token_estimate).toBeGreaterThanOrEqual(d.waste[i]!.token_estimate);
    }
  });

  test("empty input → zeroed data, null top waste", () => {
    const d = buildDashboardData([]);
    expect(d.session_count).toBe(0);
    expect(d.total_turns).toBe(0);
    expect(d.estimated_cost_usd).toBe(0);
    expect(d.top_waste_type).toBeNull();
    expect(d.waste).toEqual([]);
  });

  test("old/partial artifact missing numeric fields → coerced to 0 (no NaN)", () => {
    // e.g. a pre-`dropped_turns` capture: the field is absent.
    const legacy = {
      session_id: "legacy-1",
      started_at: "2026-05-28T10:14:15Z",
      total_turns: 5,
      total_input_tokens: 60,
      total_output_tokens: 40,
      requests: [],
    } as unknown as CaptureSession;
    const d = buildDashboardData([legacy]);
    expect(d.total_dropped_turns).toBe(0); // was NaN before the guard
    expect(Number.isNaN(d.total_dropped_turns)).toBe(false);
    expect(d.total_input_tokens).toBe(60);
  });
});

describe("dashboard route", () => {
  test("GET /dashboard/api returns aggregated JSON", async () => {
    const s1 = sess("bbbbbbbb-2", [turn(100), turn(300)], 400, 20);
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: () => [s1] } });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/dashboard/api" });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.session_count).toBe(1);
    expect(d.total_input_tokens).toBe(400);
    expect(d.note).toContain("§2b corpus");
  });

  test("GET /dashboard serves HTML that fetches the api", async () => {
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: () => [] } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("/dashboard/api");
    expect(res.payload).toContain("Waste Dashboard");
  });

  test("async session reader is awaited", async () => {
    const s1 = sess("cccccccc-3", [turn(100)], 100, 5);
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: async () => [s1] } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/dashboard/api" });
    expect(res.json().session_count).toBe(1);
  });
});
