// Shared in-memory fake Supabase client for Tier-2/3 memory tests (no creds, no
// network). NOT a test suite itself (filename is not *.test.ts). Faithfully models
// the supabase-js surface the adapters use:
//   query:   from(t).select(c).eq(k,v)[.eq][.lt(k,v)][.order(k,{ascending})].limit(n) -> {data,error}
//   insert:  await from(t).insert(rowOrRows)            -> {data: inserted[], error}
//   insert:  from(t).insert(row).select(c).single()     -> {data:{id}, error}
//   upsert:  await from(t).upsert(rows, {onConflict})    -> {data, error}  (dedup/replace by id)
//   update:  await from(t).update(patch).eq(k,v)[.eq]    -> {data:null, error}
//   delete:  await from(t).delete().eq(k,v)              -> {data:null, error}
//   rpc:     await client.rpc(fn, args)                  -> {data, error}
// Fidelity notes (fixed after the Session-17 review): order() actually sorts;
// insert/upsert return a real Promise (chainable) whose data is the written rows;
// update returns {data,error} and supports chained .eq(); upsert dedups on id so a
// retry is idempotent. Faults inject per-table select/write errors.

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

  const matchesEq = (row: Row, filters: Row): boolean => Object.entries(filters).every(([c, v]) => row[c] === v);
  const matchesLt = (row: Row, lts: Row): boolean =>
    Object.entries(lts).every(([c, v]) => {
      const rv = row[c];
      return rv !== undefined && rv !== null && (rv as string | number) < (v as string | number);
    });

  function writeRows(table: string, rowOrRows: Row | Row[], upsert: boolean): Row[] {
    const arr = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const rows = rowsOf(table);
    const written: Row[] = [];
    for (const row of arr) {
      const withId: Row = row["id"] !== undefined ? { ...row } : { id: nextId(), ...row };
      if (upsert) {
        const idx = rows.findIndex((r) => r["id"] === withId["id"]);
        if (idx >= 0) rows[idx] = withId; // on-conflict: replace (idempotent)
        else rows.push(withId);
      } else {
        rows.push(withId);
      }
      written.push(withId);
    }
    return written;
  }

  // insert/upsert: a real Promise (awaitable + chainable) with .select().single().
  function makeWrite(table: string, rowOrRows: Row | Row[], upsert: boolean): unknown {
    const error = faults.insertError?.has(table) ? { message: `${upsert ? "upsert" : "insert"} failed: ${table}` } : null;
    const written = error ? [] : writeRows(table, rowOrRows, upsert);
    const result = { data: error ? null : written, error };
    return Object.assign(Promise.resolve(result), {
      select(_cols: string) {
        return {
          single() {
            if (error) return Promise.resolve({ data: null, error });
            const first = written[0];
            return Promise.resolve({ data: first ? { id: first["id"] } : null, error: null });
          },
        };
      },
    });
  }

  function makeQuery(table: string): unknown {
    const eqFilters: Row = {};
    const ltFilters: Row = {};
    let sortCol: string | null = null;
    let sortAsc = true;
    const builder = {
      eq(col: string, val: unknown) {
        eqFilters[col] = val;
        return builder;
      },
      lt(col: string, val: unknown) {
        ltFilters[col] = val;
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        sortCol = col;
        sortAsc = !(opts && opts.ascending === false);
        return builder;
      },
      limit(n: number) {
        if (faults.selectError?.has(table)) return Promise.resolve({ data: null, error: { message: `select failed: ${table}` } });
        let r = rowsOf(table).filter((row) => matchesEq(row, eqFilters) && matchesLt(row, ltFilters));
        if (sortCol !== null) {
          const c = sortCol;
          r = [...r].sort((a, b) => {
            const av = a[c] as string | number;
            const bv = b[c] as string | number;
            if (av < bv) return sortAsc ? -1 : 1;
            if (av > bv) return sortAsc ? 1 : -1;
            return 0;
          });
        }
        return Promise.resolve({ data: r.slice(0, n), error: null });
      },
    };
    return builder;
  }

  function makeUpdate(table: string, patch: Row): unknown {
    const filters: Row = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      then(onFulfilled: (v: { data: null; error: null }) => void): void {
        for (const row of rowsOf(table)) if (matchesEq(row, filters)) Object.assign(row, patch);
        onFulfilled({ data: null, error: null });
      },
    };
    return builder;
  }

  function makeDelete(table: string): unknown {
    // Mirror makeUpdate: accumulate filters via chained .eq(); apply on await (then).
    const filters: Row = {};
    const builder = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      then(onFulfilled: (v: { data: null; error: null }) => void): void {
        store[table] = rowsOf(table).filter((row) => !matchesEq(row, filters));
        onFulfilled({ data: null, error: null });
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
          return makeWrite(table, rowOrRows, false);
        },
        upsert(rowOrRows: Row | Row[], _opts?: { onConflict?: string }) {
          return makeWrite(table, rowOrRows, true);
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
