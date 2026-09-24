// Disposable local proof that commercial audit reads follow typed-fact project provenance.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const scopes = ["orion", "vega", "legacy"] as const;
const fixture = Object.fromEntries(
  scopes.map((scope) => [
    scope,
    {
      session: randomUUID(),
      fact: randomUUID(),
      conflict: randomUUID(),
      rawKey: `cq_test_${randomUUID()}`,
    },
  ]),
) as Record<(typeof scopes)[number], { session: string; fact: string; conflict: string; rawKey: string }>;
const orphanFact = randomUUID();
const orphanConflict = randomUUID();
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Project audit read check" }), "insert org");
  for (const [index, scope] of scopes.entries()) {
    const row = fixture[scope];
    const projectScope = scope === "legacy" ? null : scope;
    checked(await db.from("sessions").insert({ id: row.session, org_id: org, project_scope: projectScope, model: "local/check" }), `insert ${scope} session`);
    checked(await db.from("api_keys").insert({ org_id: org, project_scope: projectScope, key_hash: hashApiKey(row.rawKey), name: scope }), `insert ${scope} key`);
    checked(await db.from("todos").insert({ id: row.fact, org_id: org, session_id: row.session, project_scope: projectScope, confidence: 0.9, description: scope }), `insert ${scope} fact`);
    const at = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    checked(await db.from("audit_statuses").insert({ org_id: org, fact_table: "todos", fact_id: row.fact, status: "UNVERIFIED", audited_at: at }), `insert ${scope} status`);
    checked(
      await db
        .from("audit_conflicts")
        .insert({ id: row.conflict, org_id: org, session_id: row.session, fact_table: "todos", fact_id: row.fact, claimed_state: scope, actual_state: "changed", detected_at: at }),
      `insert ${scope} conflict`,
    );
  }
  // Both orphan rows sort newer than every real row. Project filtering must
  // discard them before the one-row limit.
  const newer = "2026-01-10T00:00:00.000Z";
  checked(await db.from("audit_statuses").insert({ org_id: org, fact_table: "todos", fact_id: orphanFact, status: "UNVERIFIED", audited_at: newer }), "insert orphan status");
  checked(
    await db
      .from("audit_conflicts")
      .insert({ id: orphanConflict, org_id: org, session_id: fixture.legacy.session, fact_table: "todos", fact_id: orphanFact, claimed_state: "orphan", actual_state: "missing", detected_at: newer }),
    "insert orphan conflict",
  );

  app = buildProxy(
    buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }, { cors: false, rateLimit: false }, (clientUrl, clientKey) =>
      createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
    ),
  );
  for (const scope of scopes) {
    const headers = { authorization: `Bearer ${fixture[scope].rawKey}`, "x-project-scope": "vega" };
    for (const [path, field, expectedId] of [
      ["conflicts", "conflicts", fixture[scope].conflict],
      ["audit-statuses", "statuses", fixture[scope].fact],
    ] as const) {
      const response = await app.inject({ method: "GET", url: `/v1/memory/${path}?project-scope=vega&limit=1`, headers });
      const rows = response.json()[field] as Array<Record<string, unknown>>;
      assert(response.statusCode === 200 && rows.length === 1 && rows[0]?.[path === "conflicts" ? "id" : "fact_id"] === expectedId, `${scope} key received a foreign or orphan ${path} row`);
    }
  }
  process.stdout.write("local project-scoped conflict and audit-status reads passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    checked(await db.from("audit_statuses").delete().eq("org_id", org), "delete statuses");
    checked(await db.from("audit_conflicts").delete().eq("org_id", org), "delete conflicts");
    checked(await db.from("todos").delete().eq("org_id", org), "delete facts");
    checked(await db.from("api_keys").delete().eq("org_id", org), "delete keys");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
