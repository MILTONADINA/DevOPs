// Unit test for the create-org arg parser (the live insert is exercised by the onboarding round-trip).

import { describe, test, expect } from "vitest";
import { parseArgs } from "../../scripts/create-org";

describe("create-org parseArgs", () => {
  test("defaults: no name, starter plan, no key, live env", () => {
    expect(parseArgs([])).toEqual({ plan: "starter", withKey: false, env: "live" });
  });
  test("--name + --plan", () => {
    expect(parseArgs(["--name", "Acme", "--plan", "growth"])).toMatchObject({ name: "Acme", plan: "growth" });
  });
  test("an unknown plan falls back to starter (the safe default)", () => {
    expect(parseArgs(["--name", "X", "--plan", "platinum"]).plan).toBe("starter");
  });
  test("--with-key + --env test", () => {
    expect(parseArgs(["--name", "X", "--with-key", "--env", "test"])).toMatchObject({ withKey: true, env: "test" });
  });
});
