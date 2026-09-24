// Composite graph FKs reject cross-organization endpoints and sessions.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const a = randomUUID();
const b = randomUUID();
const sessionA = randomUUID();
const sessionB = randomUUID();
const nodeA = randomUUID();
const nodeA2 = randomUUID();
const nodeB = randomUUID();
let failure: unknown;

function checked(result: { error: { message: string } | null }, step: string): void {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}
function rejected(result: { error: { code?: string; message: string } | null }, step: string): void {
  if (result.error?.code !== "23503" && !(result.error?.code === "P0001" && /graph .* (missing|mismatch)/.test(result.error.message))) {
    throw new Error(`${step} accepted a foreign graph reference or failed for an unrelated reason: ${result.error?.message ?? "no error"}`);
  }
}

try {
  checked(await db.from("organizations").insert([{ id: a, name: "Graph integrity A" }, { id: b, name: "Graph integrity B" }]), "insert orgs");
  checked(await db.from("sessions").insert([{ id: sessionA, org_id: a, model: "check" }, { id: sessionB, org_id: b, model: "check" }]), "insert sessions");
  checked(await db.from("knowledge_entities").insert([
    { id: nodeA, org_id: a, session_id: sessionA, kind: "Function", name: "integrityA" },
    { id: nodeA2, org_id: a, session_id: sessionA, kind: "Function", name: "integrityA2" },
    { id: nodeB, org_id: b, session_id: sessionB, kind: "Function", name: "integrityB" },
  ]), "insert same-org entities");
  rejected(await db.from("knowledge_entities").insert({ org_id: a, session_id: sessionB, kind: "Function", name: "foreignSession" }), "entity session");
  rejected(await db.from("knowledge_edges").insert({ org_id: a, from_entity: nodeB, to_entity: nodeA, edge_type: "REFERENCED_IN" }), "source endpoint");
  rejected(await db.from("knowledge_edges").insert({ org_id: a, from_entity: nodeA, to_entity: nodeB, edge_type: "REFERENCED_IN" }), "target endpoint");
  rejected(await db.from("knowledge_edges").insert({ org_id: a, session_id: sessionB, from_entity: nodeA, to_entity: nodeA2, edge_type: "REFERENCED_IN" }), "edge session");
  const edgeId = randomUUID();
  checked(await db.from("knowledge_edges").insert({ id: edgeId, org_id: a, session_id: sessionA, from_entity: nodeA, to_entity: nodeA2, edge_type: "REFERENCED_IN" }), "insert same-org edge");
  rejected(await db.from("knowledge_edges").update({ to_entity: nodeB }).eq("id", edgeId), "edge update");
  process.stdout.write("local graph composite FKs rejected foreign endpoints and sessions\n");
} catch (error) {
  failure = error;
} finally {
  for (const table of ["knowledge_edges", "knowledge_entities", "sessions"]) {
    for (const org of [a, b]) {
      try { checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`); }
      catch (error) { if (!failure) failure = error; }
    }
  }
  for (const org of [a, b]) {
    try { checked(await db.from("organizations").delete().eq("id", org), "delete org"); }
    catch (error) { if (!failure) failure = error; }
  }
}
if (failure) throw failure;
