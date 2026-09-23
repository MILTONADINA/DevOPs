// Local-only promotion and bound graph query with a disposable organization.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (url !== "http://127.0.0.1:54321" || !key || process.env.DEVOPS_STRATUM_PROJECT_ROOT !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const session = randomUUID();
const active = randomUUID();
const suppressed = randomUUID();
const oldName = `old_${active.slice(0, 8)}`;
const newName = `new_${active.slice(0, 8)}`;

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

function run(script, args, env = {}) {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve(script), ...args], {
    cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", timeout: 90_000,
  });
  if (child.error || child.status !== 0) throw new Error(`${script} failed: ${child.error?.message ?? child.stderr ?? child.stdout}`);
  return child.stdout;
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs local promotion check" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check" }), "insert session");
  checked(await db.from("function_changes").insert([
    { id: active, org_id: org, session_id: session, confidence: 0.9, is_suppressed: false, old_name: oldName, new_name: newName, change_type: "renamed" },
    { id: suppressed, org_id: org, session_id: session, confidence: 0.9, is_suppressed: true, old_name: "hidden_old", new_name: "hidden_new", change_type: "renamed" },
  ]), "insert facts");

  const noCache = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/promote-tier2-to-tier3.ts")], {
    cwd: resolve("test/integration"),
    env: { ...process.env, PROMOTE_ORG_ID: org, PROMOTE_OLDER_THAN_DAYS: "0", PROMOTE_LIMIT: "5" },
    encoding: "utf8", timeout: 30_000,
  });
  if (noCache.error || noCache.status === 0) throw new Error("promotion did not fail with an absent project-local model cache");
  if (!/local|offline|cache/i.test(noCache.stderr)) throw new Error(`promotion failed for an unrelated reason: ${noCache.stderr}`);
  const before = checked(await db.from("function_changes").select("promoted_to_t3").eq("id", active).single(), "read pre-promotion flag");
  if (before.promoted_to_t3) throw new Error("missing model cache marked a fact promoted");

  const promotion = run("scripts/promote-tier2-to-tier3.ts", [], {
    PROMOTE_ORG_ID: org, PROMOTE_OLDER_THAN_DAYS: "0", PROMOTE_LIMIT: "5",
  });
  if (!promotion.includes("Promoted 1 fact(s)")) throw new Error("promotion did not select exactly one active fact");
  const facts = checked(await db.from("function_changes").select("id,promoted_to_t3").eq("org_id", org), "read facts");
  if (facts.find((fact) => fact.id === active)?.promoted_to_t3 !== true || facts.find((fact) => fact.id === suppressed)?.promoted_to_t3 !== false) {
    throw new Error("promotion flags do not match active/suppressed facts");
  }
  const vectors = checked(await db.from("memory_vectors").select("source_ref").eq("org_id", org), "read vectors");
  if (vectors.length !== 1 || vectors[0].source_ref !== active) throw new Error("promotion did not write only the active fact vector");

  const report = run("scripts/understand-codebase-bound.ts", ["--entity", oldName], { DEVOPS_STRATUM_ORG_ID: org });
  if (!report.includes(`Entity: ${oldName}`) || !report.includes("Status: SUPERSEDED") || !report.includes(`Superseded by: ${newName}`)) {
    throw new Error("bound graph query did not report the promoted supersession");
  }
  process.stdout.write("local active fact promoted to graph/vector and bound entity status resolved\n");
} catch (error) {
  failure = error;
} finally {
  for (const table of ["memory_vectors", "knowledge_edges", "knowledge_entities", "function_changes", "sessions", "organizations"]) {
    try {
      const result = await db.from(table).delete().eq(table === "organizations" ? "id" : "org_id", org);
      if (result.error && !failure) failure = new Error(`cleanup ${table}: ${result.error.message}`);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
