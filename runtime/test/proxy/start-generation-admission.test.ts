import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  admission: vi.fn(),
  provider: vi.fn(() => ({})),
  outbox: vi.fn(() => ({})),
  listen: vi.fn(async () => undefined),
  build: vi.fn(),
}));
vi.mock("../../src/lib/erasure-generation", () => ({ assertErasureStartup: calls.admission }));
vi.mock("../../src/proxy/default-deps", () => ({ createDefaultMessagesDeps: calls.provider }));
vi.mock("../../src/usage/durable-usage-outbox", () => ({ createLocalUsageOutbox: calls.outbox }));
vi.mock("../../src/proxy/app", () => ({ buildProxy: calls.build }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("../../src/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { start } from "../../src/proxy/index";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CQ_COMMERCIAL", "true");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54329");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "synthetic-test-credential");
  vi.stubEnv("PORT", "4189");
  vi.stubEnv("VERCEL", "");
  calls.build.mockReturnValue({ listen: calls.listen, close: vi.fn() });
  vi.spyOn(process, "on").mockReturnValue(process);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("REQ-5/9 actual start admission ordering", () => {
  test("pending admission prevents providers, outbox and listener", async () => {
    let release: () => void = () => undefined;
    calls.admission.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const running = start();
    await Promise.resolve();
    try {
      expect(calls.admission).toHaveBeenCalledOnce();
      expect(calls.provider).not.toHaveBeenCalled();
      expect(calls.outbox).not.toHaveBeenCalled();
      expect(calls.listen).not.toHaveBeenCalled();
    } finally {
      release();
      await running;
    }
    expect(calls.listen).toHaveBeenCalledOnce();
  });

  test("failed generation admission prevents every startup side effect", async () => {
    calls.admission.mockRejectedValue(new Error("erasure generation unavailable"));
    await expect(start()).rejects.toThrow("erasure generation unavailable");
    expect(calls.provider).not.toHaveBeenCalled();
    expect(calls.outbox).not.toHaveBeenCalled();
    expect(calls.build).not.toHaveBeenCalled();
    expect(calls.listen).not.toHaveBeenCalled();
  });

  test("accepted admission precedes production providers and outbox", async () => {
    calls.admission.mockResolvedValue(undefined);
    await start();
    expect(calls.admission).toHaveBeenCalledOnce();
    expect(calls.admission.mock.invocationCallOrder[0]).toBeLessThan(calls.provider.mock.invocationCallOrder[0]!);
    expect(calls.admission.mock.invocationCallOrder[0]).toBeLessThan(calls.outbox.mock.invocationCallOrder[0]!);
    expect(calls.listen).toHaveBeenCalledOnce();
  });
});
