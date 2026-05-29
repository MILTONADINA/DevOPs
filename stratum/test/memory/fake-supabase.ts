// Shared in-memory fake Supabase client for Tier-2 memory tests (no creds, no
// network). NOT a test suite itself (filename is not *.test.ts, so vitest's
// include glob skips it). Supports exactly the chains the warm-tier adapter +
// session resolver use:
//   query:   from(t).select(c).eq(k,v)[.eq(k,v)][.order(k,o)].limit(n) -> {data,error}
//   insert:  await from(t).insert(rowOrRows)                            -> {data,error}   (persist batch)
//   insert:  from(t).insert(row).select(c).single()                    -> {data,error}   (resolver)
//   update:  await from(t).update(patch).eq(k,v)                        -> {error}
//   delete:  await from(t).delete().eq(k,v)                             -> {error}
// Inserts preserve a provided `id` (facts mint their own uuid) and mint one when absent
// (org/session rows). Faults inject per-table select/insert errors.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeFaults {
  selectError?: Set<string>;
  insertError?: Set<string>;
}

export interface FakeDb {
  client: SupabaseClient;
  store: Record<string, Record<string, unknown>[]>;
}

type Row = Record<string, unknown>;

export function makeFakeSupabase(
  seed: Record<string, Row[]> = {},
  faults: FakeFaults = {},
  rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {},
): FakeDb {
  const store: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));
  let idSeq = 0;
  const nextId = (): string => `id-${++idSeq}`;

  const rowsOf = (table: string): Row[] => {
    const existing = store[table];
    if (existing) return existing;
    const fresh: Row[] = [];
    store[table] = fresh;
    return fresh;
  };

  const matches = (row: Row, filters: Row): boolean => Object.entries(filters).every(([c, v]) => row[c] === v);

  function makeQuery(table: string): unknown {
    const filters: Row = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      order(_c: string, _o: unknown) {
        return builder;
      },
      limit(n: number) {
        if (faults.selectError?.has(table)) return Promise.resolve({ data: null, error: { message: `select failed: ${table}` } });
        const r = rowsOf(table).filter((row) => matches(row, filters));
        return Promise.resolve({ data: r.slice(0, n), error: null });
      },
    };
    return builder;
  }

  function makeInsert(table: string, rowOrRows: Row | Row[]): unknown {
    const arr = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const error = faults.insertError?.has(table) ? { message: `insert failed: ${table}` } : null;
    const inserted: Row[] = [];
    if (!error) {
      for (const row of arr) {
        const withId: Row = row["id"] !== undefined ? { ...row } : { id: nextId(), ...row };
        rowsOf(table).push(withId);
        inserted.push(withId);
      }
    }
    // Dual-purpose: awaitable ({data,error}) for the persist batch AND
    // .select().single() for the resolver's create paths.
    return {
      then(onFulfilled: (v: { data: null; error: { message: string } | null }) => void): void {
        onFulfilled({ data: null, error });
      },
      select(_cols: string) {
        return {
          single() {
            if (error) return Promise.resolve({ data: null, error });
            const first = inserted[0];
            return Promise.resolve({ data: first ? { id: first["id"] } : null, error: null });
          },
        };
      },
    };
  }

  function makeUpdate(table: string, patch: Row): unknown {
    const filters: Row = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        for (const row of rowsOf(table)) if (matches(row, filters)) Object.assign(row, patch);
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  }

  function makeDelete(table: string): unknown {
    const filters: Row = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        store[table] = rowsOf(table).filter((row) => !matches(row, filters));
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return makeQuery(table);
        },
        insert(rowOrRows: Row | Row[]) {
          return makeInsert(table, rowOrRows);
        },
        update(patch: Row) {
          return makeUpdate(table, patch);
        },
        delete() {
          return makeDelete(table);
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      const handler = rpcHandlers[fn];
      if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc handler: ${fn}` } });
      return Promise.resolve({ data: handler(args), error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, store };
}
