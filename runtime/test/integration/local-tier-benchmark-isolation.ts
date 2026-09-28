// A benchmark must never reuse and clean up an operator's same-named organization.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) throw new Error("use db:with-env");
const db = createClient(url, key, { auth: { persistSession: false } });
const noCredentials = { ...process.env, DOTENV_CONFIG_PATH: resolve("../.workflow/proofs/empty-benchmark-config.txt") };
delete noCredentials.SUPABASE_URL;
delete noCredentials.SUPABASE_SERVICE_KEY;
const missing = spawnSync(resolve("node_modules/.bin/tsx"), ["scripts/bench-tiers.ts"], {
  cwd: process.cwd(),
  env: noCredentials,
  encoding: "utf8",
  timeout: 30_000,
});
if (missing.status !== 1 || !missing.stderr.includes("no tiers measured") || missing.stdout.includes("RESULT: PASS")) throw new Error("benchmark accepted missing database credentials");
const org = randomUUID();
const marker = randomUUID();
function checked(result: { error: { message: string } | null }, step: string): void {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}
let failure: unknown;
try {
  checked(await db.from("organizations").insert({ id: org, name: "Bench Tiers Org" }), "insert pre-existing organization");
  checked(await db.from("knowledge_entities").insert({ id: marker, org_id: org, kind: "File", name: `operator-marker-${marker}`, file_path: `operator-marker-${marker}` }), "insert operator marker");
  const child = spawnSync(resolve("node_modules/.bin/tsx"), ["scripts/bench-tiers.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_CONFIG_PATH: resolve("../.workflow/proofs/empty-benchmark-config.txt") },
    encoding: "utf8",
    timeout: 90_000,
  });
  if (child.error || ![0, 1].includes(child.status ?? -1)) throw new Error(`benchmark did not finish: ${child.error?.message ?? child.stderr}`);
  if (!(child.stdout.includes("Tier-2 warm fact query") && child.stdout.includes("Tier-3 vector search"))) throw new Error(`benchmark skipped database tiers: ${child.stdout.slice(-600)}`);
  if (!child.stdout.includes("warm query returned 20 facts")) throw new Error("benchmark did not verify a populated warm-memory read");
  const organization = await db.from("organizations").select("id").eq("id", org);
  const entity = await db.from("knowledge_entities").select("id").eq("id", marker);
  checked(organization, "read operator organization");
  checked(entity, "read operator marker");
  if (organization.data?.length !== 1 || entity.data?.length !== 1) throw new Error("benchmark deleted or altered pre-existing organization data");
  const residual = await db.from("organizations").select("id").like("name", "Bench Tiers Org %");
  checked(residual, "read benchmark residue");
  if (residual.data?.length) throw new Error("benchmark left a disposable organization");
  process.stdout.write(child.stdout);
  process.stdout.write("benchmark preserved the pre-existing organization and cleaned its own rows\n");
} catch (error) {
  failure = error;
} finally {
  try {
    checked(await db.from("knowledge_entities").delete().eq("id", marker), "cleanup marker");
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    checked(await db.from("organizations").delete().eq("id", org), "cleanup organization");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
