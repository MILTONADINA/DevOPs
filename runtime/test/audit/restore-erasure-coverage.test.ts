import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ORG_SCOPED_TABLES, type BackupFile } from "../../scripts/backup-org";
import { main, restoreErasureIdentities } from "../../scripts/restore-org";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const SESSION = id(2);
const FACT_TABLES = ["function_changes", "tech_decisions", "policy_updates", "todos", "variable_changes", "operational_references"];
const emptyBackup = (): BackupFile => ({
  orgId: ORG,
  exportedAt: "2026-10-03T12:00:00Z",
  tables: Object.fromEntries([["organizations", [{ id: ORG, name: "synthetic import" }]], ...ORG_SCOPED_TABLES.map((table) => [table, []]), ["pruning_logs", []]]),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(createClient).mockReset();
});

describe("restore identity admission inputs", () => {
  test("covers all identity/reference families without including protected content or retired rows", () => {
    const backup = emptyBackup();
    backup.tables.sessions = [{ id: SESSION, org_id: ORG }];
    for (const [i, table] of FACT_TABLES.entries()) backup.tables[table] = [{ id: id(10 + i), session_id: id(30 + i), decision_text: "private fact content" }];
    backup.tables.tech_decisions![0] = { ...(backup.tables.tech_decisions![0] as object), supersedes_id: id(16) };
    backup.tables.billing_records = [{ session_id: id(36) }];
    backup.tables.pruning_logs = [{ session_id: id(37) }];
    backup.tables.knowledge_entities = [{ id: id(50), session_id: id(38), name: "private entity" }];
    backup.tables.knowledge_edges = [{ id: id(70), from_entity: id(51), to_entity: id(52), session_id: id(39) }];
    backup.tables.knowledge_entity_sessions = [{ entity_id: id(53), session_id: id(40) }];
    backup.tables.knowledge_edge_sessions = [{ edge_id: id(70), session_id: id(41) }];
    backup.tables.source_fact_links = [
      { file_entity_id: id(54), function_change_id: id(17) },
      { file_entity_id: id(54), tech_decision_id: id(18) },
    ];
    backup.tables.audit_conflicts = [{ fact_id: id(19), session_id: id(42), claimed_state: "private claimed state" }];
    backup.tables.audit_statuses = [{ fact_id: id(20) }];
    backup.tables.memory_vectors = [
      { source_type: "fact", source_ref: id(21), session_id: id(43), embedding: "private embedding" },
      { source_type: "entity", source_ref: id(55) },
      { source_type: "fact", source_ref: "unrelated-legacy-orphan" },
      { source_type: "turn", source_ref: `{${id(22).toUpperCase()}}` },
    ];
    backup.tables.invoices = [{ id: id(80), session_id: id(81), org_id: ORG }];
    backup.tables.invoice_send_claims = [{ fact_id: id(82), org_id: ORG }];
    const before = structuredClone(backup);
    const inputs = restoreErasureIdentities(backup);
    expect(inputs.p_org_id).toBe(ORG);
    expect(new Set(inputs.p_session_ids)).toEqual(new Set([SESSION, ...Array.from({ length: 14 }, (_, i) => id(30 + i))]));
    expect(new Set(inputs.p_fact_ids)).toEqual(new Set(Array.from({ length: 13 }, (_, i) => id(10 + i))));
    expect(new Set(inputs.p_entity_ids)).toEqual(new Set([id(22), ...Array.from({ length: 6 }, (_, i) => id(50 + i))]));
    expect(JSON.stringify(inputs)).not.toContain("private");
    expect(JSON.stringify(inputs)).not.toContain(id(80));
    expect(backup).toEqual(before);
  });

  test("deduplicates PostgreSQL UUID aliases, including generic source references", () => {
    const backup = emptyBackup();
    const alias = `{${SESSION.toUpperCase()}}`;
    backup.tables.sessions = [{ id: alias }];
    backup.tables.pruning_logs = [{ session_id: SESSION.replaceAll("-", "") }];
    backup.tables.function_changes = [{ id: id(10).toUpperCase(), session_id: SESSION }];
    backup.tables.knowledge_entities = [{ id: id(50) }];
    backup.tables.memory_vectors = [
      { source_type: "fact", source_ref: `{${id(10).replaceAll("-", "").toUpperCase()}}` },
      { source_type: "entity", source_ref: id(50).replaceAll("-", "").match(/.{4}/g)!.join("-") },
      { source_type: "fact", source_ref: "legacy-text-reference" },
    ];
    expect(restoreErasureIdentities(backup)).toEqual({ p_org_id: ORG, p_session_ids: [SESSION], p_fact_ids: [id(10)], p_entity_ids: [id(50)] });
  });
});

async function withBackup(run: (file: string, backup: BackupFile) => Promise<void>) {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
  const fixtureRoot = join(process.cwd(), "../.workflow/state");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "restore-admission-"));
  const file = join(directory, "synthetic.backup.json");
  const backup = emptyBackup();
  backup.tables.sessions = [{ id: SESSION, org_id: ORG, model: "restore-fixture" }];
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "fixture-service-key");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    writeFileSync(file, JSON.stringify(backup));
    await run(file, backup);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function fakeClient() {
  const operations: unknown[][] = [];
  const rpc = vi.fn(async (_name: string, _input: unknown): Promise<{ data: unknown; error: unknown }> => ({ data: true, error: null }));
  const from = vi.fn((table: string) => ({
    insert: vi.fn(async (rows: unknown[]) => {
      operations.push(["insert", table, rows]);
      return { error: null };
    }),
    delete: vi.fn(() => ({
      eq: vi.fn(async (column: string, value: unknown) => {
        operations.push(["delete", table, column, value]);
        return { error: null };
      }),
    })),
  }));
  vi.mocked(createClient).mockReturnValue({ rpc, from } as unknown as ReturnType<typeof createClient>);
  return { rpc, from, operations };
}

describe("restore admission before active inserts", () => {
  test.each(["false", "null", "object", "missing-error", "error", "throw"])("fails closed on %s acknowledgement with zero active writes", async (failure) => {
    await withBackup(async (file) => {
      const { rpc, from } = fakeClient();
      if (failure === "throw") rpc.mockRejectedValueOnce(new Error("private tombstone detail"));
      else
        rpc.mockResolvedValueOnce({
          data: failure === "false" ? false : failure === "null" ? null : failure === "object" ? { accepted: true } : true,
          error: failure === "error" ? { message: "private tombstone detail" } : failure === "missing-error" ? undefined : null,
        });
      await expect(main(["--file", file])).rejects.toThrow("restore erasure admission failed; no rows inserted");
      expect(rpc).toHaveBeenCalledExactlyOnceWith("prepare_erasure_restore", { p_org_id: ORG, p_session_ids: [SESSION], p_fact_ids: [], p_entity_ids: [] });
      expect(from).not.toHaveBeenCalled();
      const output = vi.mocked(process.stdout.write).mock.calls.flat().join(" ");
      expect(output).not.toContain("private tombstone detail");
      expect(output).not.toContain("Restored ");
    });
  });

  test("awaits admission then preserves the clean-target active insert order", async () => {
    await withBackup(async (file, backup) => {
      const { rpc, from, operations } = fakeClient();
      let release!: (result: { data: unknown; error: unknown }) => void;
      rpc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const operation = main(["--file", file]);
      void operation.catch(() => undefined);
      try {
        expect(rpc).toHaveBeenCalledExactlyOnceWith("prepare_erasure_restore", { p_org_id: ORG, p_session_ids: [SESSION], p_fact_ids: [], p_entity_ids: [] });
        expect(from).not.toHaveBeenCalled();
      } finally {
        release?.({ data: true, error: null });
      }
      expect(await operation).toBe(0);
      expect(operations).toEqual([
        ["insert", "organizations", backup.tables.organizations],
        ["insert", "sessions", backup.tables.sessions],
        ["delete", "source_fact_links", "org_id", ORG],
      ]);
    });
  });

  test("known erased identity rejection does not attempt an insert, fallback, or retry", async () => {
    await withBackup(async (file) => {
      const { rpc, from } = fakeClient();
      rpc.mockResolvedValueOnce({ data: null, error: { code: "55000", message: "known erased UUID" } });
      await expect(main(["--file", file])).rejects.toThrow("restore erasure admission failed; no rows inserted");
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(from).not.toHaveBeenCalled();
    });
  });

  test("dry-run validates the historical shape without database admission", async () => {
    await withBackup(async (file) => {
      expect(await main(["--file", file, "--dry-run"])).toBe(0);
      expect(createClient).not.toHaveBeenCalled();
      expect(vi.mocked(process.stdout.write).mock.calls.flat().join(" ")).toContain("Nothing written.");
    });
  });
});
