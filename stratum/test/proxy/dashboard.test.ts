// Tests for the dashboard: pure aggregation (dashboard-data) + the route
// (app.inject() with an injected session reader; no disk).

import { describe, test, expect, afterEach, vi } from "vitest";
import { runInNewContext } from "node:vm";
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

  test("dashboard conflict shell uses the scoped API and safe browser boundaries", async () => {
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: () => [] } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("/v1/memory/conflicts");
    expect(res.payload).toContain("/v1/memory/audit-statuses");
    expect(res.payload).toContain("Audit status");
    expect(res.payload).toContain("Historical Drift");
    expect(res.payload).toContain("Authorization: 'Bearer '");
    expect(res.payload).toContain("sessionStorage");
    expect(res.payload).not.toContain("innerHTML");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
  });

  test("browser renders hostile conflict text without HTML and waits for an explicit scope", async () => {
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: () => [] } });
    await app.ready();
    const html = (await app.inject({ method: "GET", url: "/dashboard" })).payload;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    class Node {
      children: Node[] = [];
      textContent = "";
      className = "";
      value = "";
      hidden = false;
      colSpan = 1;
      listeners = new Map<string, () => void>();
      constructor(readonly tag: string) {}
      appendChild(child: Node): Node { this.children.push(child); return child; }
      replaceChildren(...children: Node[]): void { this.children = children; }
      addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
    }
    const ids = new Map<string, Node>();
    const byId = (id: string): Node => {
      let n = ids.get(id);
      if (!n) { n = new Node("div"); ids.set(id, n); }
      return n;
    };
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const hostile = '<img src=x onerror="alert(1)">';
    let failAuth = false;
    const fetch = async (url: string, opts?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: opts?.headers });
      return { ok: !(failAuth && url.startsWith("/v1/memory/conflicts")), status: failAuth ? 401 : 200, json: async () => url === "/dashboard/api"
        ? { note: hostile, session_count: 0, total_turns: 0, total_dropped_turns: 0, total_input_tokens: 0, total_output_tokens: 0, estimated_cost_usd: 0, top_waste_type: hostile, waste: [{ type: hostile, severity: "high", token_estimate: 1, description: hostile }], sessions: [] }
        : url.startsWith("/v1/memory/audit-statuses")
          ? { statuses: [{ fact_table: "function_changes", fact_id: "f1", status: hostile, evidence_commit: hostile, audited_at: "t" }] }
        : { conflicts: [{ fact_table: "function_changes", fact_id: "f1", claimed_state: hostile, actual_state: hostile, conflict_commit: "c1" }] } };
    };
    const storage = new Map<string, string>();
    const document = {
      hidden: false,
      getElementById: byId,
      querySelector: (selector: string) => byId(selector),
      createElement: (tag: string) => new Node(tag),
      addEventListener: () => undefined,
    };
    let intervalMs = 0;
    runInNewContext(script!, {
      document, fetch, sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
      location: { search: "" }, URLSearchParams, setInterval: (_fn: () => void, ms: number) => { intervalMs = ms; return 1; }, encodeURIComponent,
    });
    await vi.waitFor(() => expect(byId("#waste tbody").children).toHaveLength(1));
    expect(calls.map((c) => c.url)).toEqual(["/dashboard/api"]);

    byId("key").value = "cq_test_secret";
    byId("load-conflicts").listeners.get("click")!();
    await vi.waitFor(() => expect(byId("drift-rows").children).toHaveLength(1));
    await vi.waitFor(() => expect(byId("#audit-status-table tbody").children).toHaveLength(1));
    expect(calls[1]).toEqual({ url: "/v1/memory/conflicts?limit=10", headers: { Authorization: "Bearer cq_test_secret" } });
    expect(calls[2]).toEqual({ url: "/v1/memory/audit-statuses?limit=10", headers: { Authorization: "Bearer cq_test_secret" } });
    expect(byId("drift").hidden).toBe(false);
    expect(byId("drift-rows").children[0]!.children[1]!.textContent).toBe(hostile);
    expect(byId("#audit-status-table tbody").children[0]!.children[1]!.textContent).toBe(hostile);
    expect([...ids.values()].flatMap((n) => n.children).every((n) => n.tag !== "img")).toBe(true);
    expect(storage.get("cq_dashboard_key")).toBe("cq_test_secret");
    expect(intervalMs).toBeLessThan(5000);

    failAuth = true;
    byId("load-conflicts").listeners.get("click")!();
    await vi.waitFor(() => expect(byId("drift-status").textContent).toContain("Invalid or missing CQ API key"));
    expect(byId("drift").hidden).toBe(true);
    byId("key").value = "";
    byId("load-conflicts").listeners.get("click")!();
    expect(calls.filter((c) => c.url.startsWith("/v1/memory/conflicts"))).toHaveLength(2);
    expect(storage.has("cq_dashboard_key")).toBe(false);
  });

  test("async session reader is awaited", async () => {
    const s1 = sess("cccccccc-3", [turn(100)], 100, 5);
    app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: async () => [s1] } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/dashboard/api" });
    expect(res.json().session_count).toBe(1);
  });

  test("commercial mode does not publish unscoped captured sessions", async () => {
    const readSessions = vi.fn(() => [sess("private-session", [turn(100)], 100, 5)]);
    app = buildProxy({
      cors: false, rateLimit: false,
      auth: { resolve: async () => ({ orgId: "o1", keyId: "k1" }), protectedPrefixes: ["/v1/"] },
      dashboard: { readSessions },
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/dashboard/api" });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("private-session");
    expect(readSessions).not.toHaveBeenCalled();
  });
});
