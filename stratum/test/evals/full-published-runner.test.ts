import { afterEach, expect, test, vi } from "vitest";
import { main } from "../../evals/harness/runner";
import { main as runLocomo } from "../../scripts/eval-locomo";
import { main as runLongMemEval } from "../../scripts/eval-longmemeval";

const devState = vi.hoisted(() => ({ empty: false }));
vi.mock("../../evals/harness/dev-suite", async () => {
  const { gateScenario } = await import("../../evals/harness/compare");
  const { DEFAULT_THRESHOLDS } = await import("../../evals/harness/types");
  return {
    runDevSuite: vi.fn(async () => ({
      suite: {
        scenarios: devState.empty
          ? []
          : [gateScenario({ tier: "B", name: "inline", pruned: { faithfulness: 1, answerRelevancy: 1 }, baseline: { faithfulness: 1, answerRelevancy: 1 } }, DEFAULT_THRESHOLDS)],
        golden: [],
      },
      verdict: { passed: true, failures: [], criticalGoldenFailures: 0, goldenPassed: 0, goldenTotal: 0 },
      outcomes: [],
    })),
  };
});
vi.mock("../../scripts/eval-locomo", () => ({ main: vi.fn(async () => 0) }));
vi.mock("../../scripts/eval-longmemeval", () => ({ main: vi.fn(async () => 0) }));

afterEach(() => {
  vi.restoreAllMocks();
  devState.empty = false;
  vi.unstubAllEnvs();
  vi.mocked(runLocomo).mockClear();
  vi.mocked(runLongMemEval).mockClear();
});

function localProvider(): void {
  vi.stubEnv("EVAL_LOCAL_BASE_URL", "http://127.0.0.1:1234/v1");
  vi.stubEnv("EVAL_LOCAL_MODEL", "local/fake");
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
}

test("default main eval runs both published gates after green Tier-C and Tier-B", async () => {
  localProvider();
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const seen: string[] = [];
  vi.mocked(runLocomo).mockImplementationOnce(async () => {
    seen.push(`locomo:${process.env["EVAL_FULL_PUBLISHED"]}`);
    return 0;
  });
  vi.mocked(runLongMemEval).mockImplementationOnce(async () => {
    seen.push(`longmem:${process.env["EVAL_FULL_PUBLISHED"]}`);
    return 0;
  });
  expect(await main([], async () => 0)).toBe(1); // local judgment is exploratory
  expect(seen).toEqual(["locomo:1", "longmem:1"]);
  expect(process.env["EVAL_FULL_PUBLISHED"]).toBeUndefined();
  expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Exploratory full eval completed; release gate remains open.");
  output.mockRestore();
});

test("fast main eval skips published gates", async () => {
  localProvider();
  expect(await main(["--fast"], async () => 0)).toBe(1); // local judgment is exploratory
  expect(runLocomo).not.toHaveBeenCalled();
  expect(runLongMemEval).not.toHaveBeenCalled();
});

test("a failed LoCoMo gate prevents LongMemEval from being reported as passed", async () => {
  localProvider();
  vi.mocked(runLocomo).mockResolvedValueOnce(1);
  expect(await main([], async () => 0)).toBe(1);
  expect(runLocomo).toHaveBeenCalledOnce();
  expect(runLongMemEval).not.toHaveBeenCalled();
});

test("a thrown LoCoMo gate names the failed benchmark and restores full mode", async () => {
  localProvider();
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(runLocomo).mockRejectedValueOnce(new Error("partial corpus"));
  expect(await main([], async () => 0)).toBe(1);
  expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("LoCoMo Tier-A gate errored: partial corpus");
  expect(process.env["EVAL_FULL_PUBLISHED"]).toBeUndefined();
  expect(runLongMemEval).not.toHaveBeenCalled();
  output.mockRestore();
});

test("a thrown LongMemEval gate names the failed benchmark and restores full mode", async () => {
  localProvider();
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(runLongMemEval).mockRejectedValueOnce(new Error("partial corpus"));
  expect(await main([], async () => 0)).toBe(1);
  expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("LongMemEval Tier-A gate errored: partial corpus");
  expect(process.env["EVAL_FULL_PUBLISHED"]).toBeUndefined();
  expect(runLocomo).toHaveBeenCalledOnce();
  output.mockRestore();
});

test("main eval rejects an empty Tier-B scored result before published gates", async () => {
  devState.empty = true;
  vi.stubEnv("EVAL_LOCAL_BASE_URL", "");
  vi.stubEnv("EVAL_LOCAL_MODEL", "");
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  expect(await main([], async () => 0)).toBe(1);
  expect(runLocomo).not.toHaveBeenCalled();
  expect(runLongMemEval).not.toHaveBeenCalled();
});
