import { afterEach, expect, test, vi } from "vitest";
import { main } from "../../evals/harness/runner";

afterEach(() => vi.unstubAllEnvs());

test("main eval runs Tier-C and fails when the judged provider is absent", async () => {
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("EVAL_LOCAL_BASE_URL", "");
  vi.stubEnv("EVAL_LOCAL_MODEL", "");
  let calls = 0;
  const tierC = async (): Promise<number> => {
    calls++;
    return 0;
  };
  expect(await main(["--fast"], tierC)).toBe(1);
  expect(calls).toBe(1);
});

test("main eval fails immediately on a red Tier-C gate", async () => {
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  let calls = 0;
  expect(
    await main([], async () => {
      calls++;
      return 1;
    }),
  ).toBe(1);
  expect(calls).toBe(1);
});

test("unsupported eval flags fail before any gate runs", async () => {
  let calls = 0;
  expect(
    await main(["--compare-lambda", "0.97", "0.90"], async () => {
      calls++;
      return 0;
    }),
  ).toBe(1);
  expect(calls).toBe(0);
});
