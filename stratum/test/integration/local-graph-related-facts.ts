// Active Tier-2 facts must match an indexed File in the key's own organization.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const own = randomUUID();
const foreign = randomUUID();
const ownSession = randomUUID();
const foreignSession = randomUUID();
const raw = `cq_test_${randomUUID()}`;
const activeChange = randomUUID();
const activeDecision = randomUUID();
const suppressedChange = randomUUID();
const suppressedDecision = randomUUID();
const genericDecision = randomUUID();
const missingFileChange = randomUUID();
const foreignChange = randomUUID();
const foreignDecision = randomUUID();

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  checked(
    await db.from("organizations").insert([
      { id: own, name: "Related A" },
      { id: foreign, name: "Related B" },
    ]),
    "insert orgs",
  );
  checked(
    await db.from("sessions").insert([
      { id: ownSession, org_id: own, model: "local-check" },
      { id: foreignSession, org_id: foreign, model: "local-check" },
    ]),
    "insert sessions",
  );
  checked(await db.from("api_keys").insert({ org_id: own, key_hash: hashApiKey(raw), name: "related-facts" }), "insert key");
  checked(
    await db.from("knowledge_entities").insert([
      { org_id: own, scope_verified: true, kind: "File", name: "src/auth.ts", file_path: "src/auth.ts" },
      { org_id: foreign, scope_verified: true, kind: "File", name: "src/auth.ts", file_path: "src/auth.ts" },
    ]),
    "insert File nodes",
  );
  checked(
    await db.from("function_changes").insert([
      { id: activeChange, org_id: own, session_id: ownSession, confidence: 0.9, old_name: "verify", change_type: "deprecated", file_path: "src/auth.ts", is_suppressed: false },
      { id: suppressedChange, org_id: own, session_id: ownSession, confidence: 0.9, old_name: "hidden", change_type: "deprecated", file_path: "src/auth.ts", is_suppressed: true },
      { id: missingFileChange, org_id: own, session_id: ownSession, confidence: 0.9, old_name: "unknown", change_type: "deprecated", file_path: "src/missing.ts", is_suppressed: false },
      { id: foreignChange, org_id: foreign, session_id: foreignSession, confidence: 0.9, old_name: "foreign", change_type: "deprecated", file_path: "src/auth.ts", is_suppressed: false },
    ]),
    "insert FunctionChange facts",
  );
  checked(
    await db.from("tech_decisions").insert([
      { id: activeDecision, org_id: own, session_id: ownSession, confidence: 0.9, decision_text: "Use local verification", domain: "src/auth.ts", is_suppressed: false },
      { id: suppressedDecision, org_id: own, session_id: ownSession, confidence: 0.9, decision_text: "Hidden decision", domain: "src/auth.ts", is_suppressed: true },
      { id: genericDecision, org_id: own, session_id: ownSession, confidence: 0.9, decision_text: "Generic auth decision", domain: "auth", is_suppressed: false },
      { id: foreignDecision, org_id: foreign, session_id: foreignSession, confidence: 0.9, decision_text: "Foreign decision", domain: "src/auth.ts", is_suppressed: false },
    ]),
    "insert TechDecision facts",
  );
  app = buildProxy(
    buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }, { cors: false, rateLimit: false }, (clientUrl, clientKey) =>
      createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
    ),
  );
  const get = (path: string) => app!.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${raw}` } });
  const response = await get(`/v1/memory/graph/related-facts?org-id=${foreign}&file=src%2Fauth.ts`);
  const facts = response.json().facts;
  const ids = facts?.map((fact: { id: string }) => fact.id).sort();
  if (
    response.statusCode !== 200 ||
    ids?.join(",") !== [activeChange, activeDecision].sort().join(",") ||
    facts.find((fact: { id: string }) => fact.id === activeChange)?.summary !== "verify (deprecated)"
  ) {
    throw new Error(`related facts were not active, exact, and own-organization: ${response.statusCode} ${ids}`);
  }
  const missing = await get("/v1/memory/graph/related-facts?file=src%2Fmissing.ts");
  const noKey = await app.inject({ method: "GET", url: "/v1/memory/graph/related-facts?file=src%2Fauth.ts" });
  if (missing.statusCode !== 404 || noKey.statusCode !== 401) throw new Error("missing File or missing key was accepted");

  const links = async () => checked(await db.from("source_fact_links").select("id,file_entity_id,function_change_id,tech_decision_id").eq("org_id", own), "read durable source fact links");
  const initialLinks = await links();
  if (initialLinks.length !== 2 || !initialLinks.some((link) => link.function_change_id === activeChange) || !initialLinks.some((link) => link.tech_decision_id === activeDecision)) {
    throw new Error("initial links did not match only active exact-path facts");
  }
  const stableIds = initialLinks
    .map((link) => link.id)
    .sort()
    .join(",");
  checked(await db.from("function_changes").update({ file_path: "src/auth.ts" }).eq("id", activeChange), "retry same path");
  if (
    (await links())
      .map((link) => link.id)
      .sort()
      .join(",") !== stableIds
  )
    throw new Error("same-path retry changed or duplicated links");

  checked(await db.from("function_changes").update({ is_suppressed: true }).eq("id", activeChange), "suppress linked change");
  if (
    (await links()).some((link) => link.function_change_id === activeChange) ||
    (await get("/v1/memory/graph/related-facts?file=src%2Fauth.ts")).json().facts.some((fact: { id: string }) => fact.id === activeChange)
  ) {
    throw new Error("suppressed change retained a link or API result");
  }
  checked(await db.from("function_changes").update({ is_suppressed: false }).eq("id", activeChange), "restore linked change");
  if (!(await links()).some((link) => link.function_change_id === activeChange)) throw new Error("restored change did not relink");

  checked(await db.from("function_changes").update({ file_path: "src/missing.ts" }).eq("id", activeChange), "move linked change");
  if ((await links()).some((link) => link.function_change_id === activeChange)) throw new Error("moved change kept old link");
  checked(await db.from("function_changes").update({ file_path: "src/auth.ts" }).eq("id", activeChange), "move linked change back");
  if (!(await links()).some((link) => link.function_change_id === activeChange)) throw new Error("moved-back change did not relink");

  checked(await db.from("tech_decisions").update({ is_suppressed: true }).eq("id", activeDecision), "suppress linked decision");
  if ((await links()).some((link) => link.tech_decision_id === activeDecision)) throw new Error("suppressed decision retained a link");
  checked(await db.from("tech_decisions").update({ is_suppressed: false }).eq("id", activeDecision), "restore linked decision");
  if (!(await links()).some((link) => link.tech_decision_id === activeDecision)) throw new Error("restored decision did not relink");
  checked(await db.from("tech_decisions").update({ domain: "auth" }).eq("id", activeDecision), "move decision to generic domain");
  if ((await links()).some((link) => link.tech_decision_id === activeDecision)) throw new Error("generic decision retained a link");
  checked(await db.from("tech_decisions").update({ domain: "src/auth.ts" }).eq("id", activeDecision), "restore decision path");
  if (!(await links()).some((link) => link.tech_decision_id === activeDecision)) throw new Error("restored decision path did not relink");

  checked(await db.from("knowledge_entities").update({ name: "src/renamed.ts", file_path: "src/renamed.ts" }).eq("org_id", own).eq("kind", "File").eq("name", "src/auth.ts"), "rename indexed File");
  if ((await links()).length !== 0) throw new Error("renamed File retained old-path links");
  checked(await db.from("knowledge_entities").update({ name: "src/auth.ts", file_path: "src/auth.ts" }).eq("org_id", own).eq("kind", "File").eq("name", "src/renamed.ts"), "restore indexed File path");
  if ((await links()).length !== 2) throw new Error("restored File path did not relink active facts");

  checked(await db.from("knowledge_entities").insert({ org_id: own, scope_verified: true, kind: "File", name: "src/missing.ts", file_path: "src/missing.ts" }), "insert File after facts");
  if (!(await links()).some((link) => link.function_change_id === missingFileChange)) throw new Error("File-after-fact insert did not backfill its link");
  checked(await db.from("knowledge_entities").delete().eq("org_id", own).eq("kind", "File").eq("name", "src/missing.ts"), "delete indexed File");
  if ((await links()).some((link) => link.function_change_id === missingFileChange)) throw new Error("deleted File retained its link");

  const ownFile = checked(await db.from("knowledge_entities").select("id").eq("org_id", own).eq("kind", "File").eq("name", "src/auth.ts").single(), "read own File").id;
  const foreignFile = checked(await db.from("knowledge_entities").select("id").eq("org_id", foreign).eq("kind", "File").eq("name", "src/auth.ts").single(), "read foreign File").id;
  const nonFile = checked(
    await db.from("knowledge_entities").insert({ org_id: own, scope_verified: true, kind: "Function", name: "src/auth.ts#verify", file_path: "src/auth.ts" }).select("id").single(),
    "insert non-File node",
  ).id;
  for (const row of [
    { org_id: own, file_entity_id: foreignFile, function_change_id: activeChange },
    { org_id: own, file_entity_id: ownFile },
    { org_id: own, file_entity_id: ownFile, function_change_id: activeChange, tech_decision_id: activeDecision },
    { org_id: own, file_entity_id: nonFile, function_change_id: activeChange },
    { org_id: own, file_entity_id: ownFile, function_change_id: missingFileChange },
  ]) {
    if (!(await db.from("source_fact_links").insert(row)).error) throw new Error("invalid source fact link was accepted");
  }

  checked(await db.from("tech_decisions").delete().eq("id", activeDecision), "delete linked decision");
  if ((await links()).some((link) => link.tech_decision_id === activeDecision)) throw new Error("deleted decision retained a link");
  process.stdout.write("local source-fact links and API stayed scoped through suppression, path changes, and deletion\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  for (const table of ["function_changes", "tech_decisions", "knowledge_entities", "api_keys", "sessions"]) {
    for (const org of [own, foreign]) {
      try {
        checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  }
  for (const org of [own, foreign]) {
    try {
      checked(await db.from("organizations").delete().eq("id", org), "delete org");
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
