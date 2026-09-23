// Unit tests for the ADR-0011 supersession suppression (pure; default-off).
// Includes a tb-negation-shaped case: the documented over-retention where the
// pruner keeps a superseded "AWS Lambda" turn beside the correct "Cloudflare
// Workers" decision — supersession drops the stale one (orthogonal to λ).

import { describe, test, expect } from "vitest";
import { suppressSuperseded, type SupersedableTurn, type SupersessionPair } from "../../src/pruner/supersession";

describe("suppressSuperseded (ADR-0011)", () => {
  test("tb-negation: drops the superseded turn when the superseding entity is present", () => {
    // The contiguous span kept both; turn 0 = stale AWS Lambda, turn 1 = correct CF Workers.
    const turns: SupersedableTurn[] = [
      { index: 0, entity: "deploy on AWS Lambda" },
      { index: 1, entity: "deploy on Cloudflare Workers" },
    ];
    const supersessions: SupersessionPair[] = [{ superseded: "deploy on AWS Lambda", supersededBy: "deploy on Cloudflare Workers" }];
    expect(suppressSuperseded(turns, supersessions)).toEqual([1]); // AWS Lambda dropped, CF Workers kept
  });

  test("keeps the superseding (winner) entity itself — never dropped", () => {
    const turns: SupersedableTurn[] = [{ index: 5, entity: "deploy on Cloudflare Workers" }];
    const supersessions: SupersessionPair[] = [{ superseded: "deploy on AWS Lambda", supersededBy: "deploy on Cloudflare Workers" }];
    expect(suppressSuperseded(turns, supersessions)).toEqual([5]);
  });

  test("does NOT drop when the superseding entity is ABSENT from the selection", () => {
    // Only the (would-be) superseded entity is present → no basis to suppress it.
    const turns: SupersedableTurn[] = [{ index: 0, entity: "deploy on AWS Lambda" }];
    const supersessions: SupersessionPair[] = [{ superseded: "deploy on AWS Lambda", supersededBy: "deploy on Cloudflare Workers" }];
    expect(suppressSuperseded(turns, supersessions)).toEqual([0]);
  });

  test("turns without an entity are always kept", () => {
    const turns: SupersedableTurn[] = [
      { index: 0 },
      { index: 1, entity: "deploy on AWS Lambda" },
      { index: 2, entity: "deploy on Cloudflare Workers" },
    ];
    const supersessions: SupersessionPair[] = [{ superseded: "deploy on AWS Lambda", supersededBy: "deploy on Cloudflare Workers" }];
    expect(suppressSuperseded(turns, supersessions)).toEqual([0, 2]);
  });

  test("no supersessions → all turns kept (identity)", () => {
    const turns: SupersedableTurn[] = [
      { index: 0, entity: "a" },
      { index: 1, entity: "b" },
    ];
    expect(suppressSuperseded(turns, [])).toEqual([0, 1]);
  });

  test("handles multiple independent supersessions", () => {
    const turns: SupersedableTurn[] = [
      { index: 0, entity: "old-A" },
      { index: 1, entity: "new-A" },
      { index: 2, entity: "old-B" },
      { index: 3, entity: "new-B" },
      { index: 4, entity: "unrelated" },
    ];
    const supersessions: SupersessionPair[] = [
      { superseded: "old-A", supersededBy: "new-A" },
      { superseded: "old-B", supersededBy: "new-B" },
    ];
    expect(suppressSuperseded(turns, supersessions)).toEqual([1, 3, 4]);
  });

  test("preserves input order of survivors", () => {
    const turns: SupersedableTurn[] = [
      { index: 9, entity: "new" },
      { index: 3, entity: "old" },
      { index: 7 },
    ];
    const supersessions: SupersessionPair[] = [{ superseded: "old", supersededBy: "new" }];
    expect(suppressSuperseded(turns, supersessions)).toEqual([9, 7]);
  });
});
