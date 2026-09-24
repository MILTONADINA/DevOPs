// Disposable local Compose proof for pre-promotion warm fact relevance.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createOnnxEncoder } from "../../src/pruner/encoder";
import { retrieveSessionContext } from "../../scripts/session-start-context";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const encoder = createOnnxEncoder({ cacheDir: resolve("models"), localOnly: true });
const org = randomUUID();
const session = randomUUID();
const vegaSession = randomUUID();
const answer = randomUUID();
const foreign = randomUUID();
const suppressed = randomUUID();
const noise = [randomUUID(), randomUUID(), randomUUID()];
let failure: unknown;

function checked(result: { error: { message: string } | null }, step: string): void {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Warm relevance fixture" }), "insert org");
  checked(
    await db.from("sessions").insert([
      { id: session, org_id: org, project_scope: "orion", model: "local/check", kind: "memory" },
      { id: vegaSession, org_id: org, project_scope: "vega", model: "local/check", kind: "memory" },
    ]),
    "insert sessions",
  );
  const fact = (id: string, sessionId: string, scope: string, decision: string, day: number, isSuppressed = false) => ({
    id,
    org_id: org,
    session_id: sessionId,
    project_scope: scope,
    confidence: 0.9,
    decision_text: decision,
    domain: "operations",
    is_suppressed: isSuppressed,
    created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
  });
  checked(
    await db
      .from("tech_decisions")
      .insert([
        fact(answer, session, "orion", "Production recovery follows RUNBOOK_RECOVERY.md.", 10),
        fact(noise[0]!, session, "orion", "The logo was aligned on mobile.", 20),
        fact(noise[1]!, session, "orion", "The changelog spelling was corrected.", 21),
        fact(noise[2]!, session, "orion", "The footer color was adjusted.", 22),
        fact(foreign, vegaSession, "vega", "Production recovery follows VEGA_RECOVERY.md.", 23),
        fact(suppressed, session, "orion", "Production recovery follows SUPPRESSED_RECOVERY.md.", 24, true),
      ]),
    "insert facts",
  );

  const output = await retrieveSessionContext(
    {
      projectRoot: root,
      boundRoot: root,
      orgId: org,
      projectScope: "orion",
      supabaseUrl: url,
      serviceKey: key,
      allowlistText: "127.0.0.1",
      task: "Which document describes production recovery?",
    },
    {
      makeClient: () => db,
      encode: async (query) => Array.from((await encoder.encode([query]))[0]!),
      encodeMany: async (texts) => (await encoder.encode(texts)).map((vector) => Array.from(vector)),
    },
  );
  const result = JSON.parse(output ?? "null") as { recentFacts: { id: string }[]; relevantFacts: { id: string }[]; semanticStatus: string } | null;
  if (
    !result ||
    result.recentFacts.some((fact) => fact.id === answer) ||
    !result.relevantFacts.some((fact) => fact.id === answer) ||
    output?.includes(foreign) ||
    output?.includes(suppressed) ||
    output?.includes(key)
  ) {
    throw new Error(
      `warm relevance failed: ${JSON.stringify({ recent: result?.recentFacts.map((fact) => fact.id), relevant: result?.relevantFacts.map((fact) => fact.id), status: result?.semanticStatus })}`,
    );
  }
  process.stdout.write(`local warm relevance passed; status=${result.semanticStatus}\n`);
} catch (error) {
  failure = error;
} finally {
  try {
    checked(await db.from("tech_decisions").delete().eq("org_id", org), "delete facts");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
