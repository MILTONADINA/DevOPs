import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportOrg } from "../../scripts/backup-org";

const ORG = "11111111-1111-1111-1111-111111111111";
const ids = (count: number, kind: string): { id: string; org_id: string; session_id?: string }[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${kind}-${String(index).padStart(4, "0")}`, org_id: ORG }));

function cappedClient(opts: { stallAt?: number; omitCount?: boolean; withLogs?: boolean } = {}): SupabaseClient {
  const sessions = opts.withLogs ? ids(1_001, "session") : [];
  const logs = sessions.map((session, index) => ({ id: `log-${String(index).padStart(4, "0")}`, session_id: session.id }));
  const tables: Record<string, Record<string, unknown>[]> = {
    organizations: [{ id: ORG }], developers: ids(1_001, "developer"), sessions, pruning_logs: logs,
  };
  return {
    from(table: string) {
      let filter: (row: Record<string, unknown>) => boolean = () => true;
      let ordered: string[] = [];
      const page = (start: number, end: number) => {
        const all = (tables[table] ?? []).filter(filter).sort((a, b) => {
          for (const column of ordered) {
            const cmp = String(a[column]).localeCompare(String(b[column]));
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        return Promise.resolve({
          data: opts.stallAt !== undefined && start >= opts.stallAt ? [] : all.slice(start, Math.min(end + 1, start + 500)),
          count: opts.omitCount ? null : all.length,
          error: null,
        });
      };
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filter = (row) => row[column] === value; return query; },
        in(column: string, values: unknown[]) { filter = (row) => values.includes(row[column]); return query; },
        order(column: string) { ordered.push(column); return query; },
        range(start: number, end: number) { return page(start, end); },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) { return page(0, 999).then(resolve, reject); },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

test("backup pages through a server row cap for scoped tables and pruning logs", async () => {
  const backup = await exportOrg(cappedClient({ withLogs: true }), ORG, "2026-09-23T00:00:00Z");
  expect(backup.tables.developers).toHaveLength(1_001);
  expect(backup.tables.sessions).toHaveLength(1_001);
  expect(backup.tables.pruning_logs).toHaveLength(1_001);
});

test("backup fails instead of writing a partial export when paging stalls or count is absent", async () => {
  await expect(exportOrg(cappedClient({ stallAt: 500 }), ORG, "2026-09-23T00:00:00Z")).rejects.toThrow(/page|count/i);
  await expect(exportOrg(cappedClient({ omitCount: true }), ORG, "2026-09-23T00:00:00Z")).rejects.toThrow(/count/i);
});
