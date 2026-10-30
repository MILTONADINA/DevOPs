// Dead-letter store: private, contained, minimal records; event ids validated before they become filenames.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// test/setup.ts stubs node:fs mkdirSync/writeFileSync globally; this suite needs the real ones.
vi.unmock("node:fs");
vi.unmock("fs");

import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebhookRetrier } from "../../src/webhooks/retry";
import { createDeadLetterStore } from "../../src/webhooks/dead-letter";

const EVT = "evt_123e4567-e89b-12d3-a456-426614174000";
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dlq-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const info = (over: Record<string, unknown> = {}) => ({
  eventId: EVT,
  url: "https://u:p@hook.example:8443/path/secret?token=x",
  attempts: 6,
  lastStatus: 503,
  reasonClass: "http_5xx" as const,
  firstAttemptAt: "2026-01-01T00:00:00.000Z",
  lastAttemptAt: "2026-01-01T03:00:00.000Z",
  ...over,
});

describe("dead-letter store", () => {
  test("writes one 0600 file in a 0700 dir with only the allowed fields", () => {
    const dir = join(root, "dlq");
    const store = createDeadLetterStore({ dir, projectRoot: root });
    store.record(info());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual([`${EVT}.json`]);
    const raw = readFileSync(join(dir, `${EVT}.json`), "utf8");
    expect(statSync(join(dir, `${EVT}.json`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(raw)).toEqual({
      eventId: EVT, host: "hook.example", port: 8443, attempts: 6, lastStatus: 503, reasonClass: "http_5xx",
      firstAttemptAt: "2026-01-01T00:00:00.000Z", lastAttemptAt: "2026-01-01T03:00:00.000Z",
    });
    for (const leak of ["u:p", "/path", "secret", "token", "sha256="]) expect(raw).not.toContain(leak);
  });
  test("default port follows the scheme", () => {
    const store = createDeadLetterStore({ dir: join(root, "d"), projectRoot: root });
    store.record(info({ url: "https://hook.example/x" }));
    expect(JSON.parse(readFileSync(join(root, "d", `${EVT}.json`), "utf8")).port).toBe(443);
  });
  test.each(["../../x", "evt_../../x", "x", `${EVT}/../y`, "evt_" + "a".repeat(200), ""])("rejects eventId %j and writes nothing", (bad) => {
    const dir = join(root, "d2");
    const store = createDeadLetterStore({ dir, projectRoot: root });
    expect(() => store.record(info({ eventId: bad }))).toThrow(/event id/);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(["d2"]);
  });
  test("refuses a dir outside the project root and a symlinked dir", () => {
    expect(() => createDeadLetterStore({ dir: join(tmpdir(), "elsewhere-dlq"), projectRoot: root })).toThrow(/inside project root/);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(() => createDeadLetterStore({ dir: join(root, "link"), projectRoot: root })).toThrow(/real directory/);
  });
  test("a second record for the same event id keeps the first and never throws", () => {
    const dir = join(root, "d3");
    const store = createDeadLetterStore({ dir, projectRoot: root });
    store.record(info());
    store.record(info());
    expect(() => store.record(info({ attempts: 2 }))).not.toThrow();
    expect(JSON.parse(readFileSync(join(dir, `${EVT}.json`), "utf8")).attempts).toBe(6);
  });
  test("record tolerates an unparseable URL (host null, no port)", () => {
    const dir = join(root, "d5");
    createDeadLetterStore({ dir, projectRoot: root }).record(info({ url: "not a url" }));
    const rec = JSON.parse(readFileSync(join(dir, `${EVT}.json`), "utf8"));
    expect(rec.host).toBeNull();
    expect("port" in rec).toBe(false);
    expect(JSON.stringify(rec)).not.toContain("not a url");
  });
  test("an explicit projectRoot reached through a symlink is accepted", () => {
    mkdirSync(join(root, "phys"));
    symlinkSync(join(root, "phys"), join(root, "viaLink"));
    expect(() => createDeadLetterStore({ dir: join(root, "viaLink", "dlq"), projectRoot: join(root, "viaLink") })).not.toThrow();
    expect(readdirSync(join(root, "phys"))).toEqual(["dlq"]);
  });
  test("wired as the retrier's onUndelivered: a 403 dead-letters after one attempt with no body or secret", async () => {
    const store = createDeadLetterStore({ dir: join(root, "d4"), projectRoot: root });
    const retrier = createWebhookRetrier({
      deliver: () => Promise.resolve({ delivered: false, status: 403, retryable: false, reasonClass: "http_4xx" }),
      schedule: () => {
        throw new Error("must not schedule");
      },
      onUndelivered: store.record,
    });
    await retrier.send("https://hook.example/p?token=x", '{"secret":"BODY"}', "whsec_s", EVT);
    const raw = readFileSync(join(root, "d4", `${EVT}.json`), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ eventId: EVT, host: "hook.example", attempts: 1, lastStatus: 403, reasonClass: "http_4xx" });
    for (const leak of ["BODY", "whsec_s", "token", "/p"]) expect(raw).not.toContain(leak);
  });
});
