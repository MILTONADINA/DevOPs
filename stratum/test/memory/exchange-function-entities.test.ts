import { describe, expect, test } from "vitest";
import {
  createExchangeFunctionLookup,
  createFactExchangeCoverageLookup,
  createFreshFunctionSupersessionLookup,
  createProjectFunctionSupersessionLookup,
} from "../../src/memory/warm/exchange-function-entities";
import { createQueryFactCandidateLookup } from "../../src/memory/warm/query-fact-exchanges";
import { makeFakeSupabase } from "./fake-supabase";

describe("trusted exchange function lookup", () => {
  test("bounds query matches to current facts from exact trusted exchanges", async () => {
    const calls: Record<string, unknown>[] = [];
    const valid = (id: string, exchange: string) => ({
      fact_table: "operational_references",
      lexical_score: 0.5,
      fact: { id, org_id: "org", session_id: "session", project_scope: "orion", source_exchange_id: exchange, is_suppressed: false },
    });
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        search_project_warm_facts: (args) => {
          calls.push(args);
          return [
            valid("fact-1", "old"),
            valid("fact-1", "old"),
            valid("fact-2", "new"),
            { ...valid("foreign", "old"), fact: { ...valid("foreign", "old").fact, session_id: "other" } },
            { ...valid("suppressed", "old"), fact: { ...valid("suppressed", "old").fact, is_suppressed: true } },
            valid("unexpected", "not-requested"),
            { ...valid("negative", "old"), lexical_score: -1 },
            { ...valid("wrong-table", "old"), fact_table: "secrets" },
          ];
        },
      },
    );
    const lookup = createQueryFactCandidateLookup(client);
    expect(await lookup("org", "session", "orion", ["old", "new"], "Which runbook?")).toEqual(
      new Map([
        ["old", 1],
        ["new", 1],
      ]),
    );
    expect(calls).toEqual([{ match_org: "org", match_project_scope: "orion", search_text: "Which runbook?", result_limit: 20 }]);
    await expect(lookup("org", "session", "ORION", ["old"], "runbook")).rejects.toThrow(/project scope/i);
    await expect(lookup("org", "session", "orion", Array(129).fill("old"), "runbook")).rejects.toThrow(/bound/i);
    expect(calls).toHaveLength(1);
  });

  test("ignores results beyond the bounded lexical page", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      fact_table: "tech_decisions",
      lexical_score: 0.5,
      fact: { id: `fact-${index}`, org_id: "org", session_id: "session", project_scope: "orion", source_exchange_id: "old", is_suppressed: false },
    }));
    const { client } = makeFakeSupabase({}, {}, { search_project_warm_facts: () => rows });
    expect(await createQueryFactCandidateLookup(client)("org", "session", "orion", ["old"], "database")).toEqual(new Map([["old", 20]]));
  });

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

  test("counts active facts per exact conversation exchange and rejects invalid scope", async () => {
    const calls: Record<string, unknown>[] = [];
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        find_active_fact_exchanges: (args) => {
          calls.push(args);
          return [
            { exchange_id: "old", fact_count: 2 },
            { exchange_id: "new", fact_count: 1 },
          ];
        },
      },
    );
    const lookup = createFactExchangeCoverageLookup(client);
    expect(await lookup("org", "session", "orion", ["old", "new"])).toEqual(
      new Map([
        ["old", 2],
        ["new", 1],
      ]),
    );
    expect(calls).toEqual([{ match_org: "org", match_session: "session", match_project_scope: "orion", exchange_ids: ["old", "new"] }]);
    expect(await lookup("org", "session", null, [])).toEqual(new Map());
    await expect(lookup("org", "session", "ORION", ["old"])).rejects.toThrow(/project scope/i);
    await expect(createFactExchangeCoverageLookup(makeFakeSupabase().client)("org", "session", "orion", ["old"])).rejects.toThrow(/find_active_fact_exchanges/);
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
