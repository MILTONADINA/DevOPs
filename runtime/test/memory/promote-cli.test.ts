import { expect, test, vi } from "vitest";

vi.mock("@huggingface/transformers", () => ({ env: { allowRemoteModels: true } }));

test("promotion disables remote model access before it can encode facts", async () => {
  const transformers = await import("@huggingface/transformers");
  await import("../../scripts/promote-tier2-to-tier3");
  expect(transformers.env.allowRemoteModels).toBe(false);
});
