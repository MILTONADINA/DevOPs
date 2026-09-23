/**
 * Create an organization (v1.0.0 onboarding) — FREE (Supabase, no LLM).
 *
 * The first step of onboarding a design partner (COMMERCIAL_ONBOARDING.md): create the org + set its
 * plan (the plan drives the monthly-minimum invoice floor). Completes the operational tooling — there
 * was create-api-key (which NEEDS an org) but no create-org, so onboarding dropped to manual SQL.
 * With --with-key it also mints the first API key in one step. Gated on Supabase creds.
 *
 *   npm run create-org -- --name "<Org Name>" [--plan starter|growth|enterprise|custom] [--with-key [--env test]]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { generateApiKey } from "../src/proxy/auth";

const PLANS = ["starter", "growth", "enterprise", "custom"] as const;
type Plan = (typeof PLANS)[number];

interface Args {
  name?: string;
  plan: Plan;
  withKey: boolean;
  env: "live" | "test";
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { plan: "starter", withKey: false, env: "live" };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--name":
        out.name = val();
        break;
      case "--plan": {
        const p = val();
        // Reject an unknown plan (fail-closed) — silently keeping the 'starter' default would create an
        // org on the WRONG billing tier (e.g. a typo'd "enterprize" → a $0 floor instead of $499), and the
        // DB CHECK never catches it because the parser already substituted a valid default.
        if (!(PLANS as readonly string[]).includes(p)) throw new Error(`invalid --plan "${p}"; expected one of: ${PLANS.join(", ")}`);
        out.plan = p as Plan;
        break;
      }
      case "--with-key":
        out.withKey = true;
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
  if (args.name === undefined || args.name === "") {
    out('usage: npm run create-org -- --name "<Org Name>" [--plan starter|growth|enterprise|custom] [--with-key [--env test]]');
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("create-org SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  const { data, error } = await client.from("organizations").insert({ name: args.name, plan: args.plan }).select("id").limit(1);
  if (error) throw new Error(`insert org failed: ${error.message}`);
  const orgId = ((data ?? [])[0] as { id: string } | undefined)?.id ?? "?";

  out("Organization created:");
  out(`  id:    ${orgId}`);
  out(`  name:  ${args.name}`);
  out(`  plan:  ${args.plan}`);

  if (args.withKey) {
    const { raw, hash } = generateApiKey(args.env);
    const { data: kd, error: ke } = await client.from("api_keys").insert({ org_id: orgId, key_hash: hash, name: `${args.name} key` }).select("id").limit(1);
    if (ke) throw new Error(`insert api key failed: ${ke.message}`);
    const keyId = ((kd ?? [])[0] as { id: string } | undefined)?.id ?? "?";
    out("");
    out("API key — copy it now; it is NOT stored and cannot be shown again:");
    out(`  ${raw}`);
    out(`  key id: ${keyId}`);
    out("Use it as:  Authorization: Bearer <key>");
  } else {
    out(`Next: npm run create-api-key -- --org-id ${orgId} --name "<label>"`);
  }
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("create-org.ts") || entryPath.endsWith("create-org.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`create-org failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
