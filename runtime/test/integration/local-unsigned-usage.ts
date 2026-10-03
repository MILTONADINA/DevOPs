// specs/ops/payment-removal.md#AC-4, #AC-5, #AC-6: actual entry point and M1 replay proof.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashApiKey } from "../../src/proxy/auth";
import { recordUsage, type UsageInput } from "../../src/usage/recorder";
import { createSupabaseUsageRecorder } from "../../src/usage/usage-recorder";

const runtimeRoot = process.cwd();
const root = resolve(runtimeRoot, "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root ||
    runtimeRoot !== join(root, "runtime") || process.platform === "win32") {
  throw new Error("run through npm run db:verify-unsigned-usage from runtime/ with the local stack and M1 applied");
}
const db = createClient(url, key, { auth: { persistSession: false }, global: {
  fetch: (input, init) => fetch(input, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]),
  }),
} });
const org = randomUUID();
const otherOrg = randomUUID();
const estimateSession = randomUUID();
const pruningLog = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
mkdirSync(join(runtimeRoot, "data/sessions"), { recursive: true });
const scratch = mkdtempSync(join(runtimeRoot, "data/sessions/local-unsigned-usage-"));
const outboxDir = join(scratch, "outbox");
const captureDir = join(scratch, "captures");
for (const dir of [outboxDir, captureDir, join(scratch, "tmp")]) mkdirSync(dir, { mode: 0o700 });

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function read<T>(result: { data: T; error: { message: string } | null }, step: string): NonNullable<T> {
  const data = checked(result, step);
  assert(data !== null && data !== undefined, `${step}: query returned no data`);
  return data;
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string", "loopback server did not bind");
  return address.port;
}
async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

let modelCalls = 0;
const model = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions" || request.headers.authorization) {
    response.writeHead(400).end(); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const sent = JSON.parse(body) as { model?: string; stream?: boolean };
  if (sent.model !== "c2-check" || sent.stream) { response.writeHead(400).end(); return; }
  modelCalls++;
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "c2-local", object: "chat.completion", created: 1, model: "c2-check",
    choices: [{ index: 0, message: { role: "assistant", content: "local usage recorded" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 },
  }));
});

type RunningProxy = { child: ChildProcess; exited: Promise<void>; log: string; stopped: boolean; spawnError?: Error };
const processes: RunningProxy[] = [];
function alive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function stop(proxy: RunningProxy): Promise<void> {
  if (proxy.stopped) return;
  const pid = proxy.child.pid;
  if (pid !== undefined && alive(pid)) {
    process.kill(-pid, "SIGTERM");
    const deadline = Date.now() + 20_000;
    while (alive(pid) && Date.now() < deadline) await delay(100);
    if (alive(pid)) {
      process.kill(-pid, "SIGKILL");
      await proxy.exited;
      throw new Error("proxy did not finish its graceful shutdown; fixture retained");
    }
  }
  await proxy.exited;
  proxy.stopped = true;
  assert(!proxy.spawnError && readFileSync(proxy.log, "utf8").includes("CQ Proxy shut down cleanly"), "proxy did not record a clean shutdown");
}
function start(port: number, modelPort: number): RunningProxy {
  const log = join(scratch, `proxy-${processes.length + 1}.log`);
  // Allowlist the child environment: no inherited provider keys, signing secret,
  // extraction/audit/shadow settings, dotenv, proxy variables or operator journals.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"], NODE_ENV: "test", LANG: "C", LOG_LEVEL: "info",
    TMPDIR: join(scratch, "tmp"), npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "absent-user-npmrc"), npm_config_globalconfig: join(scratch, "absent-global-npmrc"),
    npm_config_update_notifier: "false", DOTENV_CONFIG_PATH: join(scratch, "absent-dotenv"),
    SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, DEVOPS_STRATUM_PROJECT_ROOT: root,
    CQ_COMMERCIAL: "true", DEVOPS_PROXY_HOST: "127.0.0.1", PORT: String(port),
    CQ_LOCAL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, CQ_INPUT_PRICE_PER_TOKEN: "0.000007",
    CQ_USAGE_OUTBOX_DIR: outboxDir, CQ_CAPTURE_DIR: captureDir, STRATUM_TELEMETRY_OPT_OUT: "true",
  };
  assert(!("CQ_BILLING_SIGNING_SECRET" in env), "signing secret must be absent");
  const fd = openSync(log, "wx", 0o600);
  let child: ChildProcess;
  try { child = spawn("npm", ["run", "dev"], { cwd: runtimeRoot, env, detached: true, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  const proxy: RunningProxy = { child, exited: Promise.resolve(), log, stopped: false };
  proxy.exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => { proxy.spawnError = error; resolve(); });
  });
  processes.push(proxy);
  return proxy;
}
async function ready(proxy: RunningProxy, base: string): Promise<void> {
  await until(async () => {
    assert(!proxy.spawnError && proxy.child.exitCode === null && proxy.child.signalCode === null, "proxy exited before readiness");
    let response: Response;
    try { response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); }
    catch { return false; }
    const health = await response.json() as { status?: string; dependencies?: { database?: string } };
    return response.status === 200 && health.status === "ok" && health.dependencies?.database === "ok";
  }, "team entry point did not become database-ready");
}
const headers = { authorization: `Bearer ${rawKey}`, "content-type": "application/json" };
let failure: unknown;
try {
  // This precondition refuses the pre-M1 database before writing a fixture row.
  for (const column of ["signed_hash", "cq_fee_usd"]) {
    const result = await db.from("billing_records").select(column).eq("org_id", org).limit(1);
    assert(result.error?.code === "42703", `M1 prerequisite failed: ${column} is not confirmed absent`);
  }
  checked(await db.from("organizations").insert([{ id: org, name: "C2 unsigned usage check" }, { id: otherOrg, name: "C2 replay mismatch check" }]), "insert fixture orgs");
  checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(rawKey), name: "c2-local-check" }), "insert hashed fixture key");
  checked(await db.from("sessions").insert({ id: estimateSession, org_id: org, kind: "explicit", model: "local/c2-estimate" }), "insert estimate session");
  checked(await db.from("pruning_logs").insert({ id: pruningLog, session_id: estimateSession, turns_total: 1,
    lambda_used: 0.1, gain_shift_used: 0.1, theta_used: 0.1 }), "insert pruning fixture");
  const modelPort = await listen(model);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const base = `http://127.0.0.1:${port}`;
  const first = start(port, modelPort);
  await ready(first, base);
  for (const path of ["/v1/billing/summary", "/v1/billing/records"]) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    assert(response.status === 401, `${path} is not protected`); await response.arrayBuffer();
  }
  for (const path of ["/billing", "/v1/billing/invoice", "/v1/billing/audit.csv", "/v1/billing/invoices", "/stripe/webhook"]) {
    const response = await fetch(`${base}${path}`, { method: path === "/stripe/webhook" ? "POST" : "GET",
      headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(5000) });
    assert(response.status === 404, `${path} was not removed`); await response.arrayBuffer();
  }
  const answer = await fetch(`${base}/v1/messages`, {
    method: "POST", headers, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ model: "local/c2-check", messages: [{ role: "user", content: "local unsigned usage check" }], max_tokens: 32 }),
  });
  const answerBody = await answer.json() as { usage?: { input_tokens?: number; output_tokens?: number } };
  assert(answer.status === 200 && answerBody.usage?.input_tokens === 23 && answerBody.usage.output_tokens === 7 && modelCalls === 1, "real entry point did not preserve loopback upstream usage");
  await until(async () => read(await db.from("billing_records").select("id").eq("org_id", org), "await message usage").length === 1, "message usage was not persisted");
  const row = read(await db.from("billing_records").select("*").eq("org_id", org).single(), "read message usage");
  const bucket = read(await db.from("sessions").select("id,org_id,kind,model,project_scope").eq("id", row.session_id).eq("org_id", org).single(), "read message usage bucket");
  assert(bucket.kind === "usage" && bucket.model === "local/c2-check" && bucket.project_scope === null &&
    bucket.id !== answer.headers.get("x-cq-conversation-id") && row.original_tokens === 23 && row.quarantined_tokens === 23 &&
    /^[0-9a-f-]{36}$/i.test(row.usage_event_id) && Number(row.api_price_per_token) === 0.000007 && row.token_delta === 0 &&
    Number(row.cost_delta_usd) === 0 && !("signed_hash" in row) && !("cq_fee_usd" in row), "unsigned message row or separate usage bucket is wrong");
  const input: UsageInput = { orgId: org, sessionId: row.session_id, usageEventId: row.usage_event_id,
    originalTokens: 23, quarantinedTokens: 23, apiPricePerToken: 0.000007 };
  assert((await recordUsage({ client: db }, input)).id === row.id, "duplicate message event changed its persisted id");
  for (const [field, change] of Object.entries({ orgId: otherOrg, sessionId: estimateSession, originalTokens: 24,
    quarantinedTokens: 22, apiPricePerToken: 0.000008, pruningLogId: pruningLog })) {
    let rejected = false;
    try { await recordUsage({ client: db }, { ...input, [field]: change }); }
    catch (error) { rejected = error instanceof Error && error.message === "usage event replay mismatch"; }
    assert(rejected, `replayed ${field} mismatch was not refused by the writer`);
  }
  assert(read(await db.from("billing_records").select("id").eq("usage_event_id", input.usageEventId!), "count replay").length === 1, "duplicate or mismatched replay added a row");

  // A synthetic pruned fixture proves retained generated estimates without inventing savings for the message.
  const estimate = await recordUsage({ client: db }, { orgId: org, sessionId: estimateSession, usageEventId: randomUUID(),
    originalTokens: 100_000, quarantinedTokens: 50_000, apiPricePerToken: 0.000003 });
  const updated = read(await db.from("billing_records").update({ quarantined_tokens: 40_000 }).eq("id", estimate.id).eq("org_id", org)
    .select("token_delta,cost_delta_usd").single(), "update scoped usage fixture");
  assert(updated.token_delta === 60_000 && Number(updated.cost_delta_usd) === 0.18, "M1 did not permit UPDATE or retain generated estimates");
  const statsResponse = await fetch(`${base}/v1/sessions/${estimateSession}/stats`, { headers, signal: AbortSignal.timeout(5000) });
  const stats = await statsResponse.json() as { originalTokens?: number; quarantinedTokens?: number; savingsUsd?: number };
  assert(statsResponse.status === 200 && stats.originalTokens === 100_000 && stats.quarantinedTokens === 40_000 && stats.savingsUsd === 0.18, "session statistics lost token counts or USD estimates");
  const summaryResponse = await fetch(`${base}/v1/billing/summary`, { headers, signal: AbortSignal.timeout(5000) });
  const summary = await summaryResponse.json() as Record<string, unknown>;
  assert(summaryResponse.status === 200 && summary["total_original_tokens"] === 100_023 && summary["total_quarantined_tokens"] === 40_023 &&
    summary["total_cost_delta_usd"] === 0.18 && !["cq_fee_usd", "fee_usd", "amount_due_usd", "plan_minimum_usd"].some((field) => field in summary), "usage summary lost estimates or regained payment fields");
  await stop(first);
  assert(readdirSync(outboxDir).length === 0, "first proxy did not drain its outbox");
  const captures = readdirSync(captureDir).filter((name) => name.startsWith("session-") && name.endsWith(".json"));
  assert(captures.length === 1, "entry point did not write one isolated capture");
  const capture = JSON.parse(readFileSync(join(captureDir, captures[0]!), "utf8"));
  assert(capture.requests?.[0]?.token_counts?.token_count_method === "estimated" && capture.requests?.[0]?.response?.usage?.input_tokens === 23,
    "capture confused estimated preflight counts with upstream-confirmed usage");

  // Regression: this decimal tie is missed by binary floating-point rounding.
  const precisionInput = { orgId: org, sessionId: estimateSession, usageEventId: randomUUID(),
    originalTokens: 4, quarantinedTokens: 4, apiPricePerToken: 0.000001005 };
  const precise = await recordUsage({ client: db }, precisionInput);
  assert((await recordUsage({ client: db }, precisionInput)).id === precise.id, "numeric rounding rejected an acknowledged replay");
  const preciseRow = read(await db.from("billing_records").select("api_price_per_token").eq("id", precise.id).eq("org_id", org).single(), "read decimal tie price");
  assert(Number(preciseRow.api_price_per_token) === 0.00000101, "PostgreSQL decimal tie did not retain the expected price");

  // Pre-C2 journals already contain unsigned event inputs. Replay the original bytes,
  // including an ambiguous event whose INSERT committed before journal deletion.
  const committedEvent = { orgId: org, projectScopeId: `${org}/orion`, model: "local/c2-legacy", eventId: randomUUID(),
    occurredAt: "2026-08-15T11:12:13.000Z", inputTokens: 13, outputTokens: 2, apiPricePerToken: 0.000001235 };
  const pendingEvent = { ...committedEvent, eventId: randomUUID(), inputTokens: 17 };
  await createSupabaseUsageRecorder({ client: db }).recordUsage(committedEvent);
  const committed = read(await db.from("billing_records").select("id").eq("usage_event_id", committedEvent.eventId).eq("org_id", org).single(), "read committed legacy event");
  for (const event of [committedEvent, pendingEvent]) writeFileSync(join(outboxDir, `${event.eventId}.json`), JSON.stringify(event), { flag: "wx", mode: 0o600 });
  const second = start(port, modelPort);
  await ready(second, base);
  await until(async () => readdirSync(outboxDir).length === 0, "pre-C2 pending or already-committed event did not replay");
  await stop(second);
  const legacyRows = read(await db.from("billing_records").select("id,session_id,usage_event_id,original_tokens,quarantined_tokens,api_price_per_token,cost_delta_usd")
    .eq("org_id", org).in("usage_event_id", [committedEvent.eventId, pendingEvent.eventId]), "read replayed legacy events");
  assert(legacyRows.length === 2 && legacyRows.find((item) => item.usage_event_id === committedEvent.eventId)?.id === committed.id &&
    new Set(legacyRows.map((item) => item.session_id)).size === 1 && legacyRows.every((item) =>
      item.original_tokens === (item.usage_event_id === committedEvent.eventId ? 13 : 17) && item.quarantined_tokens === item.original_tokens &&
      Number(item.api_price_per_token) === 0.00000124 && Number(item.cost_delta_usd) === 0), "legacy replay duplicated an event or changed its counts/pinned price");
  const legacyBucket = read(await db.from("sessions").select("kind,model,project_scope,created_at").eq("org_id", org).eq("id", legacyRows[0]!.session_id).single(), "read legacy usage bucket");
  assert(legacyBucket.kind === "usage" && legacyBucket.model === "local/c2-legacy" && legacyBucket.project_scope === "orion" &&
    new Date(legacyBucket.created_at).toISOString() === committedEvent.occurredAt && modelCalls === 1, "legacy replay changed its project/day or called the model");
  assert(read(await db.from("billing_records").select("id").eq("org_id", org), "count final usage").length === 5, "unexpected final usage rows");
  writeFileSync(join(scratch, "proof.json"), JSON.stringify({ checks: ["actual npm run dev without signing secret", "database-ready health", "401/404 guards",
    "upstream 23 input / 7 output tokens", "same-id replay and six mismatch refusals", "retired columns absent", "scoped UPDATE and generated USD estimate",
    "usage summary and explicit session statistics", "0.000001005 to 0.00000101 price round-trip and same-id replay",
    "pre-C2 pending/committed journal replay", "original day/project and rounded pinned price preserved"],
    org, otherOrg, modelCalls, usageRowsBeforeCleanup: 5, logs: processes.map((proxy) => proxy.log) }, null, 2), { mode: 0o600 });
} catch (error) {
  failure = error;
} finally {
  for (const proxy of processes) {
    try { await stop(proxy); } catch (error) { if (!failure) failure = error; }
  }
  try { await close(model); } catch (error) { if (!failure) failure = error; }
  // Failed proofs retain their outbox, logs and FK targets for diagnosis/replay.
  if (!failure) {
    try {
      assert(readdirSync(outboxDir).length === 0, "cleanup refused a nonempty outbox");
      for (const fixtureOrg of [org, otherOrg]) {
        checked(await db.from("billing_records").delete().eq("org_id", fixtureOrg), "delete fixture usage");
        if (fixtureOrg === org) checked(await db.from("pruning_logs").delete().eq("id", pruningLog).eq("session_id", estimateSession), "delete pruning fixture");
        for (const [table, column] of [["sessions", "org_id"], ["api_keys", "org_id"], ["organizations", "id"]]) {
          checked(await db.from(table!).delete().eq(column!, fixtureOrg), `delete fixture ${table}`);
        }
        assert(read(await db.from("organizations").select("id").eq("id", fixtureOrg), "confirm fixture cleanup").length === 0, "fixture org remains after cleanup");
      }
    } catch (error) { failure = error; }
  }
}
if (failure) {
  process.stderr.write(`unsigned usage fixture retained: ${scratch}; organizations ${org}, ${otherOrg}\n`);
  throw failure;
}
process.stdout.write(`unsigned usage entrypoint, M1 replay and estimated USD checks passed; fixture rows cleaned; proof: ${join(scratch, "proof.json")}\n`);
