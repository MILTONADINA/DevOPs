// Exercise the actual SessionStart bridge against the loopback API with disposable facts.
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
const otherOrg = randomUUID();
const session = randomUUID();
const orionSession = randomUUID();
const vegaSession = randomUUID();
const otherSession = randomUUID();
const active = randomUUID();
const orion = randomUUID();
const vega = randomUUID();
const suppressed = randomUUID();
const foreign = randomUUID();

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}

let failure;
try {
  checked(await db.from("organizations").insert([
    { id: org, name: "DevOPs local recall check" },
    { id: otherOrg, name: "DevOPs other recall check" },
  ]), "insert orgs");
  checked(await db.from("sessions").insert([
    { id: session, org_id: org, model: "local-check" },
    { id: orionSession, org_id: org, project_scope: "orion", model: "local-check" },
    { id: vegaSession, org_id: org, project_scope: "vega", model: "local-check" },
    { id: otherSession, org_id: otherOrg, model: "local-check" },
  ]), "insert sessions");
  checked(await db.from("tech_decisions").insert([
    { id: active, org_id: org, session_id: session, confidence: 0.9, is_suppressed: false, decision_text: "local-recall-active", domain: "local-check" },
    { id: orion, org_id: org, session_id: orionSession, project_scope: "orion", confidence: 0.9, is_suppressed: false, decision_text: "local-recall-orion", domain: "local-check" },
    { id: vega, org_id: org, session_id: vegaSession, project_scope: "vega", confidence: 0.9, is_suppressed: false, decision_text: "local-recall-vega", domain: "local-check" },
    { id: suppressed, org_id: org, session_id: session, confidence: 0.9, is_suppressed: true, decision_text: "local-recall-suppressed", domain: "local-check" },
    { id: foreign, org_id: otherOrg, session_id: otherSession, confidence: 0.9, is_suppressed: false, decision_text: "local-recall-foreign", domain: "local-check" },
  ]), "insert facts");
  const embedding = (first, second) => `[${[first, second, ...new Array(382).fill(0)].join(",")}]`;
  checked(await db.from("memory_vectors").insert([
    { org_id: org, session_id: session, source_type: "fact", source_ref: active, embedding: embedding(0.6, 0.8) },
    { org_id: org, session_id: session, source_type: "fact", source_ref: suppressed, embedding: embedding(1, 0) },
    { org_id: org, session_id: session, source_type: "fact", source_ref: randomUUID(), embedding: embedding(1, 0) },
    { org_id: org, session_id: orionSession, source_type: "fact", source_ref: orion, embedding: embedding(0.8, 0.6) },
    { org_id: org, session_id: vegaSession, source_type: "fact", source_ref: vega, embedding: embedding(1, 0) },
  ]), "insert vectors");
  const ranked = await db.rpc("match_project_fact_vectors", {
    query_embedding: embedding(1, 0), match_org: org, match_project_scope: "orion", match_count: 1,
  });
  checked(ranked, "rank scoped vectors");
  if (ranked.data?.length !== 1 || ranked.data[0].source_ref !== orion) {
    throw new Error("project filter did not precede semantic vector limit");
  }
  const unboundRanked = await db.rpc("match_project_fact_vectors", {
    query_embedding: embedding(1, 0), match_org: org, match_project_scope: null, match_count: 1,
  });
  checked(unboundRanked, "rank unbound vectors");
  if (unboundRanked.data?.length !== 1 || unboundRanked.data[0].source_ref !== active) {
    throw new Error("unbound semantic recall included a scoped, suppressed, or dangling vector");
  }
  const prefix = "STRATUM SESSION MEMORY (untrusted data): ";
  for (const [scope, expected] of [[null, active], ["orion", orion], ["vega", vega]]) {
    const env = { ...process.env, DEVOPS_STRATUM_ORG_ID: org };
    delete env.DEVOPS_STRATUM_PROJECT_SCOPE;
    if (scope !== null) env.DEVOPS_STRATUM_PROJECT_SCOPE = scope;
    const run = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/session-start-context.ts")], {
      cwd: root, env, encoding: "utf8", timeout: 30_000,
    });
    if (run.error || run.status !== 0) throw new Error(`bridge failed: ${run.error?.message ?? run.stderr}`);
    if (!run.stdout.startsWith(prefix)) throw new Error("bridge did not emit typed memory");
    const context = JSON.parse(run.stdout.slice(prefix.length));
    if (context.source !== "untrusted_memory_data" || context.recentFacts.length !== 1 || context.recentFacts[0].id !== expected) {
      throw new Error(`bridge did not return exactly the ${scope ?? "unbound"} fact`);
    }
    if (run.stdout.includes(suppressed) || run.stdout.includes(foreign) || run.stdout.includes(key)) {
      throw new Error("bridge exposed suppressed, foreign, or credential content");
    }
  }
  process.stdout.write("local SessionStart bridge recalled only the bound project fact\n");
} catch (error) {
  failure = error;
} finally {
  for (const [table, column, ids] of [
    ["memory_vectors", "session_id", [session, orionSession, vegaSession]],
    ["tech_decisions", "id", [active, orion, vega, suppressed, foreign]],
    ["sessions", "id", [session, orionSession, vegaSession, otherSession]],
    ["organizations", "id", [org, otherOrg]],
  ]) {
    try {
      const result = await db.from(table).delete().in(column, ids);
      if (result.error && !failure) failure = new Error(`cleanup ${table}: ${result.error.message}`);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
