import { expect, test, vi } from "vitest";

vi.mock("dotenv", () => ({ default: { config: () => { process.env["CQ_COMMERCIAL"] = "true"; } } }));

test("proxy entry point ignores dotenv overrides of process settings", async () => {
  const prior = process.env["CQ_COMMERCIAL"];
  try {
    process.env["CQ_COMMERCIAL"] = "false";
    vi.resetModules();
    await import("../../src/proxy/index");
    expect(process.env["CQ_COMMERCIAL"]).toBe("false");
  } finally {
    if (prior === undefined) delete process.env["CQ_COMMERCIAL"];
    else process.env["CQ_COMMERCIAL"] = prior;
  }
});
