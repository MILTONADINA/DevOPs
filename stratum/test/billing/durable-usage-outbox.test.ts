import { afterEach, describe, expect, test, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLocalUsageOutbox } from "../../src/billing/durable-usage-outbox";
import type { UsageEvent } from "../../src/billing/usage-recorder";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const EVENT: UsageEvent = {
  orgId: "org-1",
  projectScopeId: "org-1/orion",
  eventId: "00000000-0000-4000-8000-000000000123",
  occurredAt: "2026-09-24T23:59:59.000Z",
  model: "claude-sonnet-4-6",
  inputTokens: 42,
  outputTokens: 3,
};

function directory(): string {
  const dir = mkdtempSync(join(process.cwd(), "data", "usage-outbox-test-"));
  dirs.push(dir);
  return dir;
}

describe("project-local durable usage outbox", () => {
  test("fsyncs a private event before ack, leaves failed writes, and replays the original price after restart", async () => {
    const dir = directory();
    const first = createLocalUsageOutbox({
      dir,
      recordUsage: async () => {
        throw new Error("database unavailable");
      },
      priceFn: () => 0.000003,
      retryMs: 60_000,
    });
    first.enqueue(EVENT);
    const names = readdirSync(dir);
    expect(names).toEqual([`${EVENT.eventId}.json`]);
    expect(statSync(join(dir, names[0]!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, names[0]!), "utf8"))).toMatchObject({ ...EVENT, apiPricePerToken: 0.000003 });
    await first.close();
    expect(readdirSync(dir)).toEqual(names);

    const replayed: UsageEvent[] = [];
    const second = createLocalUsageOutbox({
      dir,
      recordUsage: async (event) => {
        replayed.push(event);
      },
      priceFn: () => 9,
      retryMs: 60_000,
    });
    await second.flush();
    expect(replayed).toEqual([{ ...EVENT, apiPricePerToken: 0.000003 }]);
    expect(readdirSync(dir)).toEqual([]);
    await second.close();
  });

  test("keeps malformed events and ignores incomplete temporary files", async () => {
    const dir = directory();
    writeFileSync(join(dir, `${EVENT.eventId}.json`), "invalid JSON");
    writeFileSync(join(dir, "bad-name.json"), JSON.stringify(EVENT));
    writeFileSync(join(dir, ".incomplete.tmp"), "partial");
    const errors: string[] = [];
    const outbox = createLocalUsageOutbox({
      dir,
      recordUsage: async () => {
        throw new Error("should not replay");
      },
      onError: (error) => errors.push(error.message),
      retryMs: 60_000,
    });
    await outbox.flush();
    expect(readdirSync(dir).sort()).toEqual([".incomplete.tmp", `${EVENT.eventId}.json`, "bad-name.json"].sort());
    expect(errors.some((error) => error.includes("JSON"))).toBe(true);
    expect(errors.some((error) => error.includes("invalid usage outbox event"))).toBe(true);
    await outbox.close();
  });

  test("rejects a nonpositive pinned price before writing an event", async () => {
    const dir = directory();
    const outbox = createLocalUsageOutbox({ dir, recordUsage: async () => undefined, priceFn: () => 0 });
    expect(() => outbox.enqueue(EVENT)).toThrow(/invalid usage event/);
    expect(readdirSync(dir)).toEqual([]);
    await outbox.close();
  });
});
