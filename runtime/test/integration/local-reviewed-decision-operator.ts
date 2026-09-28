// Disposable real-DB operator review -> SessionStart current-decision check.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { retrieveSessionContext } from "../../scripts/session-start-context";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
const root = process.env["DEVOPS_STRATUM_PROJECT_ROOT"];
if (!url?.startsWith("http://127.0.0.1:") || !key || !root) throw new Error("run through db:with-env");
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const session = randomUUID();
const oldId = randomUUID();
const newId = randomUUID();
let failure: unknown;

function checked(result: { error: { message: string } | null }, step: string): void {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}
async function recall(): Promise<{ recentFacts: { id: string }[] }> {
  const text = await retrieveSessionContext(
    {
      projectRoot: root!,
      boundRoot: root!,
      orgId: org,
      projectScope: "orion",
      supabaseUrl: url!,
      serviceKey: key!,
      allowlistText: "127.0.0.1",
      task: "",
    },
    {
      makeClient: () => db,
      encode: async () => {
        throw new Error("no task to encode");
      },
    },
  );
  if (!text) throw new Error("bound SessionStart recall unavailable");
  return JSON.parse(text) as { recentFacts: { id: string }[] };
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Disposable review fixture" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, project_scope: "orion", model: "local/check", kind: "memory" }), "insert session");
  checked(
    await db.from("tech_decisions").insert([
      { id: oldId, org_id: org, session_id: session, project_scope: "orion", created_at: "2026-09-20T00:00:00Z", decision_text: "Use MongoDB for new services", domain: "database", confidence: 0.9 },
      {
        id: newId,
        org_id: org,
        session_id: session,
        project_scope: "orion",
        created_at: "2026-09-24T00:00:00Z",
        decision_text: "Use PostgreSQL for new services",
        domain: "database",
        confidence: 0.9,
      },
    ]),
    "insert decisions",
  );
  const before = await recall();
  if (!before.recentFacts.some((fact) => fact.id === oldId) || !before.recentFacts.some((fact) => fact.id === newId)) throw new Error("pre-review recall did not include both decisions");

  const argv = ["--org-id", org, "--project-scope", "orion", "--older-id", oldId, "--newer-id", newId];
  const preview = spawnSync("node", ["--import", "tsx", "scripts/review-decision.ts", ...argv], { encoding: "utf8", env: process.env });
  if (preview.status !== 0 || !preview.stdout.includes("preview only")) throw new Error("operator preview failed");
  const evidence = "Reviewed current migration record: PostgreSQL replaced MongoDB for new services.";
  const applied = spawnSync("node", ["--import", "tsx", "scripts/review-decision.ts", ...argv, "--apply", "--reviewer", "fixture-operator"], { input: evidence, encoding: "utf8", env: process.env });
  if (applied.status !== 0 || !applied.stdout.includes("reviewedAt") || applied.stdout.includes(evidence) || applied.stdout.includes(key)) throw new Error("operator apply failed or leaked input");
  const after = await recall();
  if (after.recentFacts.some((fact) => fact.id === oldId) || !after.recentFacts.some((fact) => fact.id === newId)) throw new Error("reviewed supersession did not filter the old decision");
  const repeated = spawnSync("node", ["--import", "tsx", "scripts/review-decision.ts", ...argv, "--apply", "--reviewer", "fixture-operator"], { input: evidence, encoding: "utf8", env: process.env });
  if (repeated.status === 0) throw new Error("immutable review was accepted twice");
  process.stdout.write("local operator preview, stdin review, immutable link, and bound SessionStart recall passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    checked(await db.from("tech_decisions").delete().eq("id", newId), "delete newer decision");
    checked(await db.from("tech_decisions").delete().eq("id", oldId), "delete older decision");
    checked(await db.from("sessions").delete().eq("id", session), "delete session");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
