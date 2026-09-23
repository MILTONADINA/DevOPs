// Tests for readSessionsFromDir (the real-fs session reader). Uses a real OS
// temp dir (unmocks node:fs, which the global setup mocks for handler tests).

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";

vi.unmock("node:fs");
vi.unmock("fs");

const { readSessionsFromDir } = await import("../../src/proxy/routes/dashboard");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stratum-dash-"));
  fs.writeFileSync(
    path.join(dir, "session-aaa.json"),
    JSON.stringify({ session_id: "aaa", started_at: "t", total_turns: 2, total_input_tokens: 100, total_output_tokens: 10, dropped_turns: 0, requests: [] }),
  );
  fs.writeFileSync(
    path.join(dir, "session-bbb.json"),
    JSON.stringify({ session_id: "bbb", started_at: "t", total_turns: 1, total_input_tokens: 50, total_output_tokens: 5, dropped_turns: 1, requests: [] }),
  );
  fs.writeFileSync(path.join(dir, "session-corrupt.json"), "{ this is not valid json");
  fs.writeFileSync(path.join(dir, "not-a-session.txt"), "ignored");
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("readSessionsFromDir", () => {
  test("parses session-*.json, skips corrupt + non-matching files", () => {
    const sessions = readSessionsFromDir(dir);
    const ids = sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(["aaa", "bbb"]); // corrupt skipped, .txt ignored
    expect(sessions.find((s) => s.session_id === "bbb")?.dropped_turns).toBe(1);
  });

  test("missing directory returns [] (no crash)", () => {
    expect(readSessionsFromDir(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
