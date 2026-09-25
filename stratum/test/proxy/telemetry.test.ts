// Tests for src/proxy/telemetry.ts + its wiring into /v1/messages.
// Verifies: structured attributes emitted, NEVER any message/response content,
// soft-dep no-crash on a throwing sink, and emission on a real proxied turn.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { emitTurnTelemetry, type TurnTelemetry, type TelemetrySink } from "../../src/proxy/telemetry";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
const { buildProxy } = await import("../../src/proxy/app");
const captureMod = await import("../../src/proxy/capture");
import type { MessagesDeps } from "../../src/proxy/forward";

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

const attrs: TurnTelemetry = {
  "stratum.session_id": "s1",
  "stratum.turn_number": 1,
  "stratum.model": "claude-opus-4-7",
  "stratum.input_tokens": 100,
  "stratum.output_tokens": 20,
  "stratum.token_count_method": "exact",
  "stratum.elapsed_ms": 12,
  "stratum.streaming": false,
  "stratum.dropped": false,
};

describe("emitTurnTelemetry", () => {
  test("passes attributes to the sink", () => {
    const sink = vi.fn();
    emitTurnTelemetry(attrs, sink);
    expect(sink).toHaveBeenCalledWith(attrs);
  });

  test("a throwing sink NEVER propagates (soft-dep)", () => {
    const sink: TelemetrySink = () => {
      throw new Error("exporter down");
    };
    expect(() => emitTurnTelemetry(attrs, sink)).not.toThrow();
  });
});

describe("/v1/messages telemetry wiring", () => {
  test("emits content-free attributes on a proxied turn", async () => {
    const events: TurnTelemetry[] = [];
    const fs = { writes: [] as { path: string; data: string }[], writeFileSync: (p: string, d: string) => void fs.writes.push({ path: p, data: d }) };
    const deps: MessagesDeps = {
      apiKey: "sk-test",
      forward: async () => ({
        status: 200,
        data: { id: "msg_x", usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn", content: [{ type: "text", text: "SECRET-ANSWER" }] },
      }),
      forwardStream: async () => ({ status: 200 }),
      countTokens: async () => ({ input_tokens: 100, token_count_method: "exact", message_breakdown: [] }),
      capture: captureMod.createCaptureStore({ sessionId: "tele", outputFile: "/tmp/tele.json", fs }),
      telemetry: (a) => void events.push(a),
    };
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "claude-opus-4-7", messages: [{ role: "user", content: "MY-SECRET-PROMPT" }], max_tokens: 64 },
    });

    expect(events).toHaveLength(1);
    const a = events[0]!;
    expect(a["stratum.model"]).toBe("claude-opus-4-7");
    expect(a["stratum.output_tokens"]).toBe(20);
    expect(a["stratum.streaming"]).toBe(false);
    expect(a["stratum.dropped"]).toBe(false);

    // HARD RULE: NO message/response content in telemetry attributes.
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain("MY-SECRET-PROMPT");
    expect(serialized).not.toContain("SECRET-ANSWER");
  });
});

// v0.8 telemetry opt-out (stratum/docs/TELEMETRY.md): STRATUM_TELEMETRY_OPT_OUT=true stops the per-turn record.
describe("STRATUM_TELEMETRY_OPT_OUT", () => {
  test("true (or 1) resolves the no-op sink; unset, empty or anything else keeps the structured-log sink", async () => {
    const { resolveTelemetrySink, defaultTelemetrySink, noopTelemetrySink } = await import("../../src/proxy/telemetry");
    for (const value of ["true", "TRUE", " true ", "1"]) expect(resolveTelemetrySink({ STRATUM_TELEMETRY_OPT_OUT: value })).toBe(noopTelemetrySink);
    for (const env of [{}, { STRATUM_TELEMETRY_OPT_OUT: "" }, { STRATUM_TELEMETRY_OPT_OUT: "false" }, { STRATUM_TELEMETRY_OPT_OUT: "no" }]) expect(resolveTelemetrySink(env)).toBe(defaultTelemetrySink);
  });

  test("the no-op sink emits nothing", async () => {
    const { noopTelemetrySink } = await import("../../src/proxy/telemetry");
    const { logger } = await import("../../src/lib/logger");
    const info = vi.spyOn(logger, "info");
    try {
      noopTelemetrySink(attrs);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});

test("an unset sink still honors STRATUM_TELEMETRY_OPT_OUT", async () => {
  const { logger } = await import("../../src/lib/logger");
  const info = vi.spyOn(logger, "info");
  const prior = process.env["STRATUM_TELEMETRY_OPT_OUT"];
  try {
    process.env["STRATUM_TELEMETRY_OPT_OUT"] = "true";
    emitTurnTelemetry(attrs, undefined);
    expect(info).not.toHaveBeenCalled();
    delete process.env["STRATUM_TELEMETRY_OPT_OUT"];
    emitTurnTelemetry(attrs, undefined);
    expect(info).toHaveBeenCalledTimes(1);
  } finally {
    if (prior === undefined) delete process.env["STRATUM_TELEMETRY_OPT_OUT"]; else process.env["STRATUM_TELEMETRY_OPT_OUT"] = prior;
    info.mockRestore();
  }
});

