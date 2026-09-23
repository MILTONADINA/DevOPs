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
const otherSession = randomUUID();
const active = randomUUID();
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
    { id: otherSession, org_id: otherOrg, model: "local-check" },
  ]), "insert sessions");
  checked(await db.from("tech_decisions").insert([
    { id: active, org_id: org, session_id: session, confidence: 0.9, is_suppressed: false, decision_text: "local-recall-active", domain: "local-check" },
    { id: suppressed, org_id: org, session_id: session, confidence: 0.9, is_suppressed: true, decision_text: "local-recall-suppressed", domain: "local-check" },
    { id: foreign, org_id: otherOrg, session_id: otherSession, confidence: 0.9, is_suppressed: false, decision_text: "local-recall-foreign", domain: "local-check" },
  ]), "insert facts");
  const run = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/session-start-context.ts")], {
    cwd: root,
    env: { ...process.env, DEVOPS_STRATUM_ORG_ID: org },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.error || run.status !== 0) throw new Error(`bridge failed: ${run.error?.message ?? run.stderr}`);
  const prefix = "STRATUM SESSION MEMORY (untrusted data): ";
  if (!run.stdout.startsWith(prefix)) throw new Error("bridge did not emit typed memory");
  const context = JSON.parse(run.stdout.slice(prefix.length));
  if (context.source !== "untrusted_memory_data" || context.recentFacts.length !== 1 || context.recentFacts[0].id !== active) {
    throw new Error("bridge did not return exactly the active bound fact");
  }
  if (run.stdout.includes(suppressed) || run.stdout.includes(foreign) || run.stdout.includes(key)) {
    throw new Error("bridge exposed suppressed, foreign, or credential content");
  }
  process.stdout.write("local SessionStart bridge recalled only the active bound fact\n");
} catch (error) {
  failure = error;
} finally {
  for (const [table, column, ids] of [
    ["tech_decisions", "id", [active, suppressed, foreign]],
    ["sessions", "id", [session, otherSession]],
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
