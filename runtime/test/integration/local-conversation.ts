import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseConversationResolver, ConversationError } from "../../src/proxy/conversation";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run with db:with-env against the project-local stack");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const resolve = createSupabaseConversationResolver(db);
const orgId = randomUUID();
const keyOne = randomUUID();
const keyTwo = randomUUID();
const model = "local/conversation-fixture";
let failure: unknown;

function check(error: { message: string } | null, step: string): void {
  if (error) throw new Error(`${step}: ${error.message}`);
}
async function rejected(action: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ConversationError && error.status === status) return;
    throw error;
  }
  throw new Error(`expected conversation rejection ${status}`);
}

try {
  check((await db.from("organizations").insert({ id: orgId, name: "conversation acceptance fixture" })).error, "org insert");
  check(
    (
      await db.from("api_keys").insert([
        { id: keyOne, org_id: orgId, key_hash: randomUUID().replaceAll("-", ""), name: "one", project_scope: "orion" },
        { id: keyTwo, org_id: orgId, key_hash: randomUUID().replaceAll("-", ""), name: "two", project_scope: "vega" },
      ])
    ).error,
    "key insert",
  );
  const id = await resolve({ orgId, keyId: keyOne, projectScopeId: `${orgId}/orion`, model });
  if ((await resolve({ orgId, keyId: keyOne, projectScopeId: `${orgId}/orion`, model, requestedId: id })) !== id) throw new Error("own continuation failed");
  await rejected(() => resolve({ orgId, keyId: keyTwo, projectScopeId: `${orgId}/vega`, model, requestedId: id }), 404);
  await rejected(() => resolve({ orgId, keyId: keyOne, model, requestedId: id }), 404);
  await rejected(() => resolve({ orgId, keyId: keyOne, model, requestedId: "client-chosen" }), 400);
  const { data, error } = await db.from("sessions").select("id,kind,project_scope,conversation_key_id").eq("id", id).single();
  check(error, "stored conversation");
  if (data?.kind !== "conversation" || data.project_scope !== "orion" || data.conversation_key_id !== keyOne) throw new Error("stored binding differs");
  const explicit = await db.from("sessions").select("id").eq("org_id", orgId).eq("kind", "explicit");
  check(explicit.error, "explicit query");
  if (explicit.data?.length) throw new Error("conversation appeared as explicit session");
  process.stdout.write("local trusted conversation adapter passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    check((await db.from("sessions").delete().eq("org_id", orgId)).error, "delete sessions");
    check((await db.from("api_keys").delete().eq("org_id", orgId)).error, "delete keys");
    check((await db.from("organizations").delete().eq("id", orgId)).error, "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
