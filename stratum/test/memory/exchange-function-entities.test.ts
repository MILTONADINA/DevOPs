import { describe, expect, test } from "vitest";
import { createExchangeFunctionLookup, createFreshFunctionSupersessionLookup, createProjectFunctionSupersessionLookup } from "../../src/memory/warm/exchange-function-entities";
import { makeFakeSupabase } from "./fake-supabase";

describe("trusted exchange function lookup", () => {
  test("binds organization, conversation, project and selected exchange IDs", async () => {
    const calls: Record<string, unknown>[] = [];
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        find_exchange_function_entities: (args) => {
          calls.push(args);
          return [{ exchange_id: "e1", entity_name: "newFn" }];
        },
      },
    );
    const lookup = createExchangeFunctionLookup(client);
    expect(await lookup("org", "session", "orion", ["e1", "e2"])).toEqual(new Map([["e1", "newFn"]]));
    expect(calls).toEqual([{ match_org: "org", match_session: "session", match_project_scope: "orion", exchange_ids: ["e1", "e2"] }]);
    expect(await lookup("org", "session", null, [])).toEqual(new Map());
    expect(calls).toHaveLength(1);
    await expect(lookup("org", "session", "ORION", ["e1"])).rejects.toThrow(/project scope/i);
    expect(calls).toHaveLength(1);
  });

  test("fails closed on database errors", async () => {
    const lookup = createExchangeFunctionLookup(makeFakeSupabase().client);
    await expect(lookup("org", "session", "orion", ["e1"])).rejects.toThrow(/find_exchange_function_entities/);
  });

  test("uses the function-kind project relation for names with graph collisions", async () => {
    const calls: Record<string, unknown>[] = [];
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        find_project_function_superseded: (args) => {
          calls.push(args);
          return [{ superseded: "oldFn", superseded_by: "newFn" }];
        },
      },
    );
    const lookup = createProjectFunctionSupersessionLookup(client);
    expect(await lookup("org", "orion", ["oldFn", "newFn"])).toEqual([{ superseded: "oldFn", supersededBy: "newFn" }]);
    expect(calls).toEqual([{ match_org: "org", match_project_scope: "orion", names: ["oldFn", "newFn"] }]);
    expect(await lookup("org", null, [])).toEqual([]);
    await expect(lookup("org", "ORION", ["oldFn"])).rejects.toThrow(/project scope/i);
  });

  test("binds fresh rename lookup to the selected conversation exchanges", async () => {
    const calls: Record<string, unknown>[] = [];
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        find_fresh_exchange_function_superseded: (args) => {
          calls.push(args);
          return [{ superseded: "oldFn", superseded_by: "newFn" }];
        },
      },
    );
    const lookup = createFreshFunctionSupersessionLookup(client);
    expect(await lookup("org", "session", "orion", ["old", "new"])).toEqual([{ superseded: "oldFn", supersededBy: "newFn" }]);
    expect(calls).toEqual([{ match_org: "org", match_session: "session", match_project_scope: "orion", exchange_ids: ["old", "new"] }]);
    expect(await lookup("org", "session", null, [])).toEqual([]);
    await expect(lookup("org", "session", "ORION", ["new"])).rejects.toThrow(/project scope/i);
    await expect(createFreshFunctionSupersessionLookup(makeFakeSupabase().client)("org", "session", "orion", ["new"])).rejects.toThrow(/find_fresh_exchange_function_superseded/);
  });
});
