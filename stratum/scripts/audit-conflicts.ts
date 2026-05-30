/**
 * Historical-Drift alert surface (v0.6.x audit engine) — FREE (Supabase, no LLM).
 *
 * The audit spec is "CONFLICT ⇒ suppress + ALERT" (docs/AUDIT_ENGINE.md). `persistConflicts`
 * (src/audit/audit-engine.ts) writes the suppress half to `audit_conflicts`; this command is
 * the alert half — it lists the UNACKNOWLEDGED conflict queue (the table's partial index
 * `WHERE acknowledged = FALSE` is built for exactly this) and lets an operator acknowledge one.
 * Pairs with `npm run audit:repo -- --facts <json> --persist` (the writer).
 *
 *   npm run audit:conflicts                              # unacknowledged conflicts (all orgs)
 *   npm run audit:conflicts -- --org-id <uuid> --limit 20
 *   npm run audit:conflicts -- --all                     # include already-acknowledged
 *   npm run audit:conflicts -- --ack <conflict-id> [--by <developer-uuid>]
 *
 * Gated only on Supabase creds (skips cleanly without them); NO Anthropic API.
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface Args {
  orgId?: string;
  limit: number;
  all: boolean;
  ackId?: string;
  by?: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 50, all: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--org-id":
        out.orgId = val();
        break;
      case "--limit":
        out.limit = Math.max(1, Number.parseInt(val(), 10) || 50);
        break;
      case "--all":
        out.all = true;
        break;
      case "--ack":
        out.ackId = val();
        break;
      case "--by":
        out.by = val();
        break;
      default:
        break;
    }
  }
  return out;
}

/** A row from `audit_conflicts` (the columns this command reads). */
export interface ConflictRow {
  id: string;
  detected_at: string;
  fact_table: string;
  fact_id: string;
  claimed_state: string;
  actual_state: string;
  conflict_commit: string | null;
  acknowledged: boolean;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Render one conflict as a two-line alert block (pure; testable). */
export function renderConflictRow(r: ConflictRow): string {
  const commit = r.conflict_commit ? ` @${r.conflict_commit.slice(0, 10)}` : "";
  const ack = r.acknowledged ? " [acknowledged]" : "";
  return `  ${r.detected_at}  ${r.fact_table}/${r.fact_id.slice(0, 8)}${commit}${ack}\n      claimed: ${truncate(r.claimed_state, 90)}\n      actual:  ${truncate(r.actual_state, 90)}`;
}

/** Acknowledge a conflict by id (org-scoped when --org-id is given). Returns rows affected. */
async function acknowledge(client: SupabaseClient, args: Args, nowIso: string): Promise<number> {
  let q = client
    .from("audit_conflicts")
    .update({ acknowledged: true, acknowledged_at: nowIso, ...(args.by !== undefined ? { acknowledged_by: args.by } : {}) })
    .eq("id", args.ackId as string);
  if (args.orgId !== undefined) q = q.eq("org_id", args.orgId); // scope safety: don't ack across orgs
  const { data, error } = await q.select("id");
  if (error) throw new Error(`acknowledge failed: ${error.message}`);
  return (data ?? []).length;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("Tier-3 alert surface SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY to read audit_conflicts. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  if (args.ackId !== undefined) {
    const n = await acknowledge(client, args, new Date().toISOString());
    out(n > 0 ? `Acknowledged conflict ${args.ackId}.` : `No matching conflict to acknowledge (id ${args.ackId}${args.orgId ? `, org ${args.orgId}` : ""}).`);
    return n > 0 ? 0 : 1;
  }

  let q = client
    .from("audit_conflicts")
    .select("id, detected_at, fact_table, fact_id, claimed_state, actual_state, conflict_commit, acknowledged")
    .order("detected_at", { ascending: false })
    .limit(args.limit);
  if (args.orgId !== undefined) q = q.eq("org_id", args.orgId);
  if (!args.all) q = q.eq("acknowledged", false);

  const { data, error } = await q;
  if (error) throw new Error(`query audit_conflicts failed: ${error.message}`);
  const rows = (data ?? []) as ConflictRow[];

  out(`Historical-Drift alerts — ${args.all ? "all" : "unacknowledged"} conflicts${args.orgId ? ` (org ${args.orgId.slice(0, 8)}…)` : ""}`);
  out("=".repeat(60));
  if (rows.length === 0) {
    out(args.all ? "No conflicts recorded." : "No unacknowledged conflicts — memory is clean (or none audited yet).");
    return 0;
  }
  for (const r of rows) {
    out(renderConflictRow(r));
    out(`      id: ${r.id}  (acknowledge with: npm run audit:conflicts -- --ack ${r.id})`);
  }
  out("");
  out(`${rows.length} conflict(s)${args.limit === rows.length ? ` (capped at --limit ${args.limit}; more may exist)` : ""}.`);
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("audit-conflicts.ts") || entryPath.endsWith("audit-conflicts.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`audit-conflicts failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
