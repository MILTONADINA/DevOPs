// Disposable local check of the project-scoped usage bucket index. No billing rows are written.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
let failure: unknown;

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Project usage bucket check" }), "insert org");
  const before = await db.from("billing_records").select("id", { count: "exact", head: true }).eq("org_id", org);
  checked(before, "billing before");
  assert(before.count === 0, "disposable organization already has billing rows");
  const model = "local/usage-check";
  const insert = (project_scope: string | null) => db.from("sessions").insert({ org_id: org, model, kind: "usage", project_scope }).select("id, project_scope").single();
  for (const scope of ["orion", "vega", null]) {
    const row = checked(await insert(scope), `insert ${scope ?? "unbound"} bucket`);
    assert(row?.project_scope === scope, `${scope ?? "unbound"} scope did not persist`);
  }
  for (const scope of ["orion", null]) {
    const duplicate = await insert(scope);
    assert(duplicate.error?.code === "23505", `${scope ?? "unbound"} duplicate bucket was accepted`);
  }
  const orion = checked(await db.from("sessions").select("id").eq("org_id", org).eq("project_scope", "orion").single(), "read orion bucket");
  const rewrite = await db.from("sessions").update({ project_scope: "vega" }).eq("id", orion.id);
  assert(rewrite.error !== null, "usage bucket project scope was mutable");
  const rows = checked(await db.from("sessions").select("project_scope").eq("org_id", org).eq("kind", "usage"), "read buckets");
  assert(rows.length === 3 && rows.some((row) => row.project_scope === null), "unbound bucket was changed");
  const after = await db.from("billing_records").select("id", { count: "exact", head: true }).eq("org_id", org);
  checked(after, "billing after");
  assert(after.count === 0, "fixture changed billing rows");
  process.stdout.write("local project usage bucket uniqueness and immutability passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
