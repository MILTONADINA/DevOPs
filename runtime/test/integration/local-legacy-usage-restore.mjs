// specs/ops/payment-removal.md#REQ-9: a synthetic legacy backup restores after
// M1/M2, stripping retired columns and skipping retired tables without reading them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const localPort = process.env["DEVOPS_LOCAL_PORT"] ?? "54321";
if (!/^[1-9]\d{3,4}$/.test(localPort) || Number(localPort) < 1024 || Number(localPort) > 65535 ||
    url !== `http://127.0.0.1:${localPort}` || !key || process.env.DEVOPS_STRATUM_PROJECT_ROOT !== root) {
  throw new Error("run through npm run db:with-env from runtime/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const session = randomUUID();
const usage = randomUUID();
const event = randomUUID();
const pruning = randomUUID();
const invoice = randomUUID();
const createdAt = "2026-09-25T12:00:00Z";
const dir = mkdtempSync(join(root, ".workflow/state/c4-legacy-restore-"));
const file = join(dir, "synthetic.backup.json");
const retiredSignature = `synthetic-retired-${randomUUID()}`;
const retiredFee = "synthetic-retired-fee";

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

function run(script, args) {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve(script), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_CONFIG_PATH: join(dir, "absent-dotenv") },
    encoding: "utf8", timeout: 30_000,
  });
  if (child.error || child.status !== 0) throw new Error(`${script} failed: ${child.error?.message ?? child.stderr ?? child.stdout}`);
  return child.stdout;
}

function checkReport(output) {
  assert.match(output, /skipped retired table invoices \(1 row\(s\)\)/);
  assert.match(output, /skipped retired table invoice_send_claims \(1 row\(s\)\)/);
  assert.match(output, /stripped retired column billing_records\.cq_fee_usd from 1 row\(s\)/);
  assert.match(output, /stripped retired column billing_records\.signed_hash from 1 row\(s\)/);
  assert.ok(!output.includes(retiredSignature) && !output.includes(retiredFee), "retired column values must not be reported");
  assert.ok(!output.includes(invoice) && !output.includes(`synthetic-${org}`) && !output.includes("private-claim-value"), "retired table content must not be reported");
  assert.ok(!output.includes("retired column billing_records.token_delta") && !output.includes("retired column billing_records.cost_delta_usd"));
}

async function clearRows() {
  for (const [table, column, value] of [
    ["billing_records", "org_id", org], ["pruning_logs", "session_id", session],
    ["sessions", "id", session], ["organizations", "id", org],
  ]) checked(await db.from(table).delete().eq(column, value), `delete fixture ${table}`);
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: org, name: "C4 synthetic legacy usage restore" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check", kind: "usage", project_scope: "c2-restore", created_at: createdAt }), "insert session");
  checked(await db.from("pruning_logs").insert({ id: pruning, session_id: session, turns_total: 1, lambda_used: 0.97, gain_shift_used: 0, theta_used: 1 }), "insert pruning log");
  checked(await db.from("billing_records").insert({ id: usage, org_id: org, session_id: session, pruning_log_id: pruning, usage_event_id: event, original_tokens: 1000, quarantined_tokens: 600, api_price_per_token: 0.00001, created_at: createdAt }), "insert unsigned usage");
  run("scripts/backup-org.ts", ["--org-id", org, "--out", file]);
  const backup = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(backup.orgId, org);
  assert.equal(backup.tables.billing_records.length, 1);
  assert.ok(!Object.hasOwn(backup.tables, "invoices") && !Object.hasOwn(backup.tables, "invoice_send_claims"), "current export must omit retired tables");
  // Construct historical rows only in this private synthetic file. M2 has
  // removed both tables; this harness never selects, inserts or deletes them.
  backup.tables.invoices = [{ id: invoice, org_id: org, stripe_invoice_id: `synthetic-${org}`, amount_cents: 24, status: "paid" }];
  backup.tables.invoice_send_claims = [{ org_id: org, period_start: "2026-08-01T00:00:00Z", period_end: "2026-09-01T00:00:00Z", legacy_note: "private-claim-value" }];
  const row = backup.tables.billing_records[0];
  assert.ok(!Object.hasOwn(row, "signed_hash") && !Object.hasOwn(row, "cq_fee_usd"), "M1 must be applied before restore proof");
  // Deliberately stale generated values must also be recomputed from the
  // preserved token counts and pinned price, rather than restored verbatim.
  Object.assign(row, { signed_hash: retiredSignature, cq_fee_usd: retiredFee, token_delta: 999, cost_delta_usd: 999 });
  writeFileSync(file, JSON.stringify(backup));
  const dryRun = run("scripts/restore-org.ts", ["--file", file, "--dry-run"]);
  checkReport(dryRun);
  assert.match(dryRun, /DRY RUN — would insert 4 row\(s\) across 4 tables/);
  assert.equal(checked(await db.from("billing_records").select("original_tokens").eq("id", usage).single(), "unchanged after dry run").original_tokens, 1000);

  await clearRows();
  assert.deepEqual(checked(await db.from("organizations").select("id").eq("id", org), "check clean target"), []);
  const restoredReport = run("scripts/restore-org.ts", ["--file", file]);
  checkReport(restoredReport);
  assert.match(restoredReport, /Restored 4 row\(s\) across 4 tables/);
  const restored = checked(await db.from("billing_records").select("*").eq("org_id", org).single(), "read restored usage");
  assert.equal(restored.id, usage);
  assert.equal(restored.session_id, session);
  assert.equal(restored.pruning_log_id, pruning);
  assert.equal(restored.usage_event_id, event);
  assert.equal(restored.original_tokens, 1000);
  assert.equal(restored.quarantined_tokens, 600);
  assert.equal(Number(restored.api_price_per_token), 0.00001);
  assert.equal(restored.token_delta, 400);
  assert.equal(Number(restored.cost_delta_usd), 0.004);
  assert.equal(Date.parse(restored.created_at), Date.parse(createdAt));
  assert.ok(!Object.hasOwn(restored, "signed_hash") && !Object.hasOwn(restored, "cq_fee_usd"));
  assert.equal(checked(await db.from("sessions").select("project_scope").eq("id", session).single(), "read usage provenance").project_scope, "c2-restore");
  const inventory = checked(await db.rpc("inspect_session_erasure", { p_org_id: org, p_session_id: session }), "read restored usage inventory");
  assert.equal(inventory.counts.billing_records, 1);
  assert.equal(inventory.counts.pruning_logs, 1);
  assert.deepEqual(inventory.org_only_classes, ["api_keys", "developers", "org_config", "organizations"]);
} catch (error) {
  failure = error;
} finally {
  try {
    await clearRows();
    assert.deepEqual(checked(await db.from("organizations").select("id").eq("id", org), "verify fixture cleanup"), []);
  } catch (error) { if (!failure) failure = error; }
  // Keep only this synthetic fixture when a failure needs investigation.
  if (!failure) rmSync(dir, { recursive: true, force: true });
}
if (failure) throw failure;
process.stdout.write("C4 synthetic legacy restore passed: retired tables skipped and columns stripped without values; usage identity, estimates and provenance retained; fixture cleaned\n");
