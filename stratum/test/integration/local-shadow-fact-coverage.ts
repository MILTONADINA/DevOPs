// Disposable service-RPC → adapter → shadow-observer fact-coverage proof.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { BiEncoder } from "../../src/pruner/encoder";
import { createFactExchangeCoverageLookup } from "../../src/memory/warm/exchange-function-entities";
import { createQueryFactCandidateLookup } from "../../src/memory/warm/query-fact-exchanges";
import { createShadowObserver, type ShadowMetric } from "../../src/proxy/shadow-observer";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const apiKey = randomUUID();
const session = randomUUID();
const oldExchange = randomUUID();
const newExchange = randomUUID();
let failure: unknown;

function checked(result: { error: { message: string } | null }, step: string): void {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Shadow fact coverage fixture" }), "insert org");
  checked(await db.from("api_keys").insert({ id: apiKey, org_id: org, project_scope: "orion", key_hash: "d".repeat(64), name: "fixture" }), "insert key");
  checked(await db.from("sessions").insert({ id: session, org_id: org, project_scope: "orion", model: "local/check", kind: "conversation", conversation_key_id: apiKey }), "insert session");
  checked(
    await db.from("function_changes").insert([
      { org_id: org, session_id: session, project_scope: "orion", source_exchange_id: oldExchange, confidence: 0.9, old_name: "oldFn", change_type: "deprecated" },
      { org_id: org, session_id: session, project_scope: "orion", source_exchange_id: newExchange, confidence: 0.9, old_name: "newFn", change_type: "deprecated" },
    ]),
    "insert function facts",
  );
  checked(
    await db
      .from("tech_decisions")
      .insert({ org_id: org, session_id: session, project_scope: "orion", source_exchange_id: oldExchange, confidence: 0.9, decision_text: "Keep old context", domain: "fixture" }),
    "insert second old fact",
  );
  checked(
    await db.from("operational_references").insert([
      { org_id: org, session_id: session, project_scope: "orion", source_exchange_id: oldExchange, confidence: 0.9, subject: "old command", reference: "verify-old" },
      { org_id: org, session_id: session, project_scope: "orion", source_exchange_id: newExchange, confidence: 0.9, subject: "new command", reference: "verify-new" },
    ]),
    "insert operational references",
  );
  const { data: coverageRows, error: coverageError } = await db.rpc("find_active_fact_exchanges", {
    match_org: org,
    match_session: session,
    match_project_scope: "orion",
    exchange_ids: [oldExchange, newExchange],
  });
  checked({ error: coverageError }, "read active fact exchange counts");
  assert(coverageRows?.find((row: { exchange_id: string }) => row.exchange_id === oldExchange)?.fact_count === 3, "old exchange did not report all active fact rows");
  assert(coverageRows?.find((row: { exchange_id: string }) => row.exchange_id === newExchange)?.fact_count === 2, "operational reference did not count as a fact in its exchange");
  const { data: candidates, error: candidateError } = await db.rpc("find_exchange_function_entities", {
    match_org: org,
    match_session: session,
    match_project_scope: "orion",
    exchange_ids: [newExchange],
  });
  checked({ error: candidateError }, "read exclusive Function candidates");
  assert(candidates?.length === 0, "mixed Function/reference exchange was treated as exclusive");

  const metrics: ShadowMetric[] = [];
  const encoder: BiEncoder = { dimension: 2, encode: async (texts) => texts.map((text) => (text === "old" ? Float32Array.from([0, 1]) : Float32Array.from([1, 0]))) };
  const observe = createShadowObserver(encoder, (metric) => metrics.push(metric), {
    now: () => 100_000_000,
    factCoverage: createFactExchangeCoverageLookup(db),
    queryFactCandidates: createQueryFactCandidateLookup(db),
  });
  const event = { conversationId: session, orgId: org, keyId: apiKey, projectScopeId: `${org}/orion` };
  await observe({ ...event, exchangeId: oldExchange, query: "old", assistant: "old" });
  await observe({ ...event, exchangeId: newExchange, query: "new", assistant: "new" });
  await observe({ ...event, exchangeId: randomUUID(), query: "old command", assistant: "pending" });
  const coverage = metrics.at(-1)?.factCoverage;
  assert(coverage?.activeExchangeCount === 2 && coverage.selectedExchangeCount === 1 && coverage.droppedExchangeCount === 1, `unexpected live shadow fact coverage: ${JSON.stringify(coverage)}`);
  assert(coverage.activeFactCount === 5 && coverage.selectedFactCount === 2 && coverage.droppedFactCount === 3, `unexpected fact-row coverage: ${JSON.stringify(coverage)}`);
  const rescue = metrics.at(-1)?.queryFactRescue;
  assert(
    rescue?.rescuedExchangeCount === 1 && rescue.rescuedFactCount >= 1 && rescue.addedTurnCount === 2 && rescue.candidateSelectedCount === 4,
    `query candidate failed to rescue the matching old exchange: ${JSON.stringify(rescue)}`,
  );
  process.stdout.write("local scoped exchange, fact-row, and query-rescue coverage passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    checked(await db.from("operational_references").delete().eq("session_id", session), "delete references");
    checked(await db.from("tech_decisions").delete().eq("session_id", session), "delete decisions");
    checked(await db.from("function_changes").delete().eq("session_id", session), "delete functions");
    checked(await db.from("sessions").delete().eq("id", session), "delete session");
    checked(await db.from("api_keys").delete().eq("id", apiKey), "delete key");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
