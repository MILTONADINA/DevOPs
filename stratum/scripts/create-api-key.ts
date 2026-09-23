/**
 * Create a multi-tenant API key (v1.0.0) — FREE (Supabase, no LLM).
 *
 * Generates a 256-bit key, stores ONLY its SHA-256 hash in api_keys (never the raw key), and
 * prints the raw key ONCE — it cannot be recovered later. Pairs with the proxy auth gate
 * (src/proxy/auth.ts). Gated on Supabase creds.
 *
 *   npm run create-api-key -- --org-id <uuid> --name "<label>" [--env test]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { generateApiKey } from "../src/proxy/auth";

interface Args {
  orgId?: string;
  name?: string;
  env: "live" | "test";
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { env: "live" };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--org-id":
        out.orgId = val();
        break;
      case "--name":
        out.name = val();
        break;
      case "--env":
        out.env = val() === "test" ? "test" : "live";
        break;
      default:
        break;
    }
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.orgId === undefined || args.orgId === "" || args.name === undefined || args.name === "") {
    out('usage: npm run create-api-key -- --org-id <uuid> --name "<label>" [--env test]');
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("create-api-key SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  // Verify the org exists (a clearer error than an FK violation).
  const { data: orgRows, error: orgErr } = await client.from("organizations").select("id").eq("id", args.orgId).limit(1);
  if (orgErr) throw new Error(`org lookup failed: ${orgErr.message}`);
  if (!orgRows || orgRows.length === 0) {
    out(`No organization found with id ${args.orgId}.`);
    return 1;
  }

  const { raw, hash } = generateApiKey(args.env);
  const { data, error } = await client.from("api_keys").insert({ org_id: args.orgId, key_hash: hash, name: args.name }).select("id").limit(1);
  if (error) throw new Error(`insert api key failed: ${error.message}`);
  const keyId = ((data ?? [])[0] as { id: string } | undefined)?.id ?? "?";

  out("API key created — copy it now; it is NOT stored and cannot be shown again:");
  out("");
  out(`  ${raw}`);
  out("");
  out(`  id:    ${keyId}`);
  out(`  org:   ${args.orgId}`);
  out(`  name:  ${args.name}`);
  out("Use it as:  Authorization: Bearer <key>   (or x-api-key: <key>)");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("create-api-key.ts") || entryPath.endsWith("create-api-key.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`create-api-key failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
