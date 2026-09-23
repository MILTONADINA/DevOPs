/**
 * API key management (v1.0.0) — list + revoke (the lifecycle complement to create-api-key).
 *
 * The auth gate already rejects inactive keys (resolveApiKeyVia filters is_active=true); this is the
 * operator side to LIST an org's keys and REVOKE a compromised one (is_active=false). Never prints
 * the key or its hash. FREE (Supabase, no LLM); gated on Supabase creds.
 *
 *   npm run api-keys -- --org-id <uuid> --list
 *   npm run api-keys -- --org-id <uuid> --revoke <key-id>
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

interface Args {
  orgId?: string;
  list: boolean;
  revoke?: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--org-id") out.orgId = argv[++i] ?? "";
    else if (tok === "--list") out.list = true;
    else if (tok === "--revoke") out.revoke = argv[++i] ?? "";
  }
  return out;
}

interface KeyRow {
  id: string;
  name: string;
  created_at: string;
  last_used: string | null;
  is_active: boolean;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.orgId === undefined || args.orgId === "" || (!args.list && (args.revoke === undefined || args.revoke === ""))) {
    out("usage: npm run api-keys -- --org-id <uuid> (--list | --revoke <key-id>)");
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("api-keys SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  if (args.revoke !== undefined && args.revoke !== "") {
    // Org-scoped so a key id from another org is a clean no-op, never a cross-tenant revoke.
    const { data, error } = await client.from("api_keys").update({ is_active: false }).eq("id", args.revoke).eq("org_id", args.orgId).select("id");
    if (error) throw new Error(`revoke failed: ${error.message}`);
    const n = (data ?? []).length;
    out(n > 0 ? `Revoked key ${args.revoke} (is_active=false).` : `No matching active/inactive key ${args.revoke} in org ${args.orgId}.`);
    return n > 0 ? 0 : 1;
  }

  // --list (never selects key_hash).
  const { data, error } = await client.from("api_keys").select("id, name, created_at, last_used, is_active").eq("org_id", args.orgId).order("created_at", { ascending: false });
  if (error) throw new Error(`list failed: ${error.message}`);
  const rows = (data ?? []) as KeyRow[];
  out(`API keys for org ${args.orgId}`);
  out("=".repeat(50));
  if (rows.length === 0) {
    out("(no keys — mint one with: npm run create-api-key)");
    return 0;
  }
  for (const r of rows) {
    out(`  ${r.is_active ? "●" : "○"} ${r.id}  ${r.name}  (created ${r.created_at}${r.last_used ? `, last used ${r.last_used}` : ""})${r.is_active ? "" : "  [revoked]"}`);
  }
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("api-keys.ts") || entryPath.endsWith("api-keys.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`api-keys failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
