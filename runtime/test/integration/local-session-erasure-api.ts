// AC-B1/B2/B7–B13: actual authenticated HTTP, normal writers and an independent
// operator connection. Run only via the reserved, frozen erasure-launch api-proof.
// No provider request is expected; no operator data, backup or credentials logged.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { verifyErasureArtifact, assertArtifactDeployment } from "../../src/lib/erasure-generation";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { createKnowledgeGraph } from "../../src/memory/cold/graph";
import { populateErasureApiFixture, EXPECTED_DELETED, EXPECTED_RETAINED, type ErasureApiFixture } from "./erasure-api-fixture";

const source = fileURLToPath(import.meta.url);
const runtimeRoot = resolve(dirname(source), "../..");
const root = resolve(runtimeRoot, "..");
const instance = process.env["DEVOPS_LOCAL_INSTANCE"] ?? "";
const activation = process.env["CQ_ERASURE_ACTIVATION_ID"] ?? "";
const manifest = process.env["CQ_ERASURE_MANIFEST"] ?? "";
const url = process.env["SUPABASE_URL"] ?? "";
const key = process.env["SUPABASE_SERVICE_KEY"] ?? "";
const port = process.env["PORT"] ?? "";
const tmp = process.env["TMPDIR"] ?? "";
const capture = process.env["CQ_CAPTURE_DIR"] ?? "";
const outbox = process.env["CQ_USAGE_OUTBOX_DIR"] ?? "";
const providerUrl = new URL(process.env["CQ_LOCAL_BASE_URL"] ?? "http://invalid/");
const safeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (
  !/^erasure-[a-z0-9-]{1,12}$/.test(instance) ||
  !safeUuid.test(activation) ||
  !manifest ||
  !key ||
  process.env["CQ_COMMERCIAL"] !== "true" ||
  !process.env["DEVOPS_STRATUM_PROJECT_ROOT"] ||
  realpathSync(process.cwd()) !== runtimeRoot ||
  url !== `http://127.0.0.1:${process.env["DEVOPS_LOCAL_PORT"]}` ||
  !/^[1-9]\d{3,4}$/.test(port) ||
  providerUrl.hostname !== "127.0.0.1" ||
  providerUrl.protocol !== "http:" ||
  !tmp.startsWith(`${root}/`) ||
  !capture.startsWith(`${root}/`) ||
  !outbox.startsWith(`${root}/`) ||
  process.platform === "win32"
) {
  throw new Error("requires the frozen reserved-instance api-proof launcher");
}
const artifact = verifyErasureArtifact(manifest, process.env["DEVOPS_STRATUM_PROJECT_ROOT"]);
assert.equal(artifact.root, root, "proof code is outside the bound artifact");
const loader = join(runtimeRoot, "node_modules/tsx/dist/cli.mjs");
for (const dir of [tmp, capture, outbox]) assert.equal(lstatSync(dir).isSymbolicLink(), false, "unsafe proof store path");
assert.deepEqual(readdirSync(capture), [], "capture directory must start empty");
assert.deepEqual(readdirSync(outbox), [], "outbox directory must start empty");

const container = `devops-stratum-isolated-${instance}-db`;
const run = randomUUID();
const injectionName = `api_fail_${run.replaceAll("-", "")}`;
const journalPath = join(tmp, `erasure-api-${run}.json`);
const proxyLog = join(tmp, `erasure-api-${run}-proxy.log`);
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const orgs: string[] = [];
const steps: string[] = [];
const journal: Record<string, unknown> = {
  run,
  container,
  activation,
  scope: "managed_explicit_session_v1",
  status: "prepared",
  orgs,
  steps,
  source_sha256: hash(readFileSync(source)),
  fixture_sha256: hash(readFileSync(join(dirname(source), "erasure-api-fixture.ts"))),
  manifest_sha256: artifact.digest,
  privileged_verifier: "scoped synthetic SQL inspection and fault injection; privileged snapshots are excluded",
};
const save = () => writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
const step = (name: string) => {
  steps.push(name);
  save();
};

/** Each invocation is a separate connection, never the API's transaction. */
function sql(statement: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres"], {
      input: `SET statement_timeout='10s'; SET lock_timeout='8s'; ${statement}\n`,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"], LANG: "C" },
    }).trim();
  } catch {
    throw new Error("scoped erasure API operator statement failed");
  }
}
function cli(script: "create-org" | "create-api-key", args: string[]): string {
  try {
    return execFileSync(process.execPath, [loader, join(runtimeRoot, `scripts/${script}.ts`), ...args], {
      cwd: runtimeRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`bound ${script} operation failed`);
  }
}
function createOrganization(name: string): { org: string; apiKey: string } {
  const output = cli("create-org", ["--name", name, "--plan", "growth", "--with-key", "--env", "test"]);
  const org = /\bid:\s+([0-9a-f-]{36})/.exec(output)?.[1];
  const apiKey = /\b(cq_test_[A-Za-z0-9_-]+)\b/.exec(output)?.[1];
  if (!org || !safeUuid.test(org) || !apiKey) throw new Error("normal organization/key output is invalid");
  orgs.push(org);
  save();
  return { org, apiKey };
}
const db = createClient(url, key, {
  auth: { persistSession: false },
  global: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(init?.signal ? [init.signal] : [])]) }),
  },
});
async function request(apiKey: string, method: string, path: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(12_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function session(apiKey: string): Promise<string> {
  const response = await request(apiKey, "POST", "/v1/sessions", { model: "local/erasure-fixture" });
  assert.equal(response.status, 201);
  assert.match(response.body.id, safeUuid);
  return response.body.id as string;
}
type Snapshot = Record<string, Array<Record<string, unknown>>>;
function rowIdentity(table: string, row: Record<string, unknown>): string {
  const columns = (
    {
      audit_statuses: ["org_id", "fact_table", "fact_id"],
      knowledge_entity_sessions: ["org_id", "entity_id", "session_id"],
      knowledge_edge_sessions: ["org_id", "edge_id", "session_id"],
    } as Record<string, string[]>
  )[table] ?? ["id"];
  const values = columns.map((column) => {
    assert.equal(typeof row[column], "string", `missing ${table} identity column ${column}`);
    return row[column];
  });
  return JSON.stringify(values);
}
function snapshot(org: string): Snapshot {
  const fields = Object.keys(EXPECTED_DELETED)
    .filter((table) => table !== "pruning_logs")
    .map((table) => `${q(table)},(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM public.${table} r WHERE org_id=${q(org)})`);
  fields.push(`'pruning_logs',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.pruning_logs r JOIN public.sessions s ON s.id=r.session_id WHERE s.org_id=${q(org)})`);
  return JSON.parse(sql(`SELECT jsonb_build_object(${fields.join(",")})::text;`)) as Snapshot;
}
function state(f: ErasureApiFixture): Record<string, unknown> {
  return JSON.parse(sql(`SELECT to_jsonb(s)::text FROM public.session_erasure_state s WHERE org_id=${q(f.org)} AND session_id=${q(f.target)};`)) as Record<string, unknown>;
}
function retainedRows(snapshot: Snapshot, f: ErasureApiFixture): Snapshot {
  const ids: Record<string, string[]> = {
    sessions: [f.survivor],
    function_changes: [f.survivorFact],
    knowledge_entities: [f.sharedFile, f.sharedFunction],
    knowledge_edges: [f.sharedEdge],
  };
  const result: Snapshot = {};
  for (const [table, keep] of Object.entries(ids)) result[table] = snapshot[table]!.filter((row) => keep.includes(row.id as string));
  result.knowledge_entity_sessions = snapshot.knowledge_entity_sessions!.filter((row) => row.session_id === f.survivor);
  result.knowledge_edge_sessions = snapshot.knowledge_edge_sessions!.filter((row) => row.session_id === f.survivor);
  result.source_fact_links = snapshot.source_fact_links!.filter((row) => row.file_entity_id === f.sharedFile);
  result.memory_vectors = snapshot.memory_vectors!.filter((row) => row.source_ref === f.sharedFile);
  return result;
}
function absence(before: Snapshot, after: Snapshot, f: ErasureApiFixture): void {
  const kept = retainedRows(before, f);
  for (const table of Object.keys(EXPECTED_DELETED)) {
    const keep = new Set((kept[table] ?? []).map((row) => rowIdentity(table, row)));
    const expectedGone = before[table]!.filter((row) => !keep.has(rowIdentity(table, row)));
    assert.equal(expectedGone.length, EXPECTED_DELETED[table as keyof typeof EXPECTED_DELETED], `unexpected baseline class ${table}`);
    const remaining = new Set(after[table]!.map((row) => rowIdentity(table, row)));
    for (const row of expectedGone) assert.equal(remaining.has(rowIdentity(table, row)), false, `captured private ${table} row survived`);
    assert.equal(after[table]!.length, keep.size, `unexpected remaining ${table} row`);
  }
  assert.deepEqual(retainedRows(after, f), kept, "shared content/provenance/evidence changed");
}

let calls = 0;
const sentinel = createServer((_request, response) => {
  calls++;
  response.writeHead(500).end("unexpected provider dispatch");
});
const listen = async (server: Server, selectedPort: number): Promise<void> => {
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(selectedPort, "127.0.0.1", done);
  });
};
const closeServer = async (server: Server): Promise<void> => {
  if (server.listening) await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
};
let child: ChildProcess | undefined;
let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let processOutput = "";
let drained: Promise<void> | undefined;
async function startProxy(): Promise<void> {
  writeFileSync(proxyLog, "", { mode: 0o600, flag: "wx" });
  child = spawn(process.execPath, [loader, join(runtimeRoot, "src/proxy/index.ts")], { cwd: runtimeRoot, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  exit = new Promise((done) => {
    child!.once("exit", (code, signal) => done({ code, signal }));
    child!.once("error", () => done({ code: -1, signal: null }));
  });
  const running = child;
  let resolveDrained!: () => void;
  drained = new Promise<void>((done) => {
    resolveDrained = done;
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("bound proxy did not reach ready state")), 45_000);
    const consume = (data: Buffer) => {
      const text = data.toString();
      processOutput += text;
      appendFileSync(proxyLog, text);
      if (processOutput.includes("CQ Proxy running")) {
        clearTimeout(timer);
        done();
      }
      if (processOutput.includes("CQ Proxy shut down cleanly")) resolveDrained();
    };
    running.stdout!.on("data", consume);
    running.stderr!.on("data", consume);
    void exit!.then(() => {
      clearTimeout(timer);
      fail(new Error("bound proxy exited before readiness"));
    });
  });
  journal.proxy_pid = child.pid;
  step("actual proxy entry ready through bound Node/tsx");
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function stopProxy(): Promise<void> {
  if (!child || !exit) return;
  const pid = child.pid;
  if (pid && groupAlive(pid)) process.kill(-pid, "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_done, fail) => {
    timer = setTimeout(() => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* terminal group */
        }
      }
      fail(new Error("proxy process group did not drain within deadline"));
    }, 15_000);
  });
  let terminal: Awaited<NonNullable<typeof exit>>;
  try {
    [terminal] = await Promise.race([Promise.all([exit, drained]), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  journal.proxy_exit = terminal;
  assert.ok(terminal.code === 0 || terminal.code === 143 || terminal.signal === "SIGTERM", "proxy launcher exited unexpectedly");
  assert.ok(processOutput.includes("CQ Proxy shut down cleanly"), "proxy did not drain cleanly");
  // The parent handle can exit before its interpreter child; require the entire
  // owned group to disappear before declaring consumers stopped.
  const deadline = Date.now() + 5_000;
  while (pid && groupAlive(pid) && Date.now() < deadline) await delay(50);
  if (pid && groupAlive(pid)) {
    process.kill(-pid, "SIGKILL");
    throw new Error("owned proxy group survived graceful drain");
  }
  child = undefined;
  exit = undefined;
  drained = undefined;
}

let injected = false;
let failure: unknown;
let relay: Server | undefined;
save();
try {
  const deployment = JSON.parse(sql("SELECT to_jsonb(d)::text FROM public.erasure_deployment d WHERE id;")) as Record<string, unknown>;
  assertArtifactDeployment(artifact, deployment);
  journal.deployment = deployment;
  save();
  await listen(sentinel, Number(providerUrl.port));
  const owner = createOrganization(`Erasure HTTP ${run}`);
  const foreign = createOrganization(`Erasure foreign ${run}`);
  const keyOutput = cli("create-api-key", ["--org-id", owner.org, "--name", "Erasure project scope", "--env", "test", "--project-scope", "orion"]);
  const projectKey = /\b(cq_test_[A-Za-z0-9_-]+)\b/.exec(keyOutput)?.[1];
  if (!projectKey) throw new Error("normal project key output is invalid");
  await startProxy();
  const target = await session(owner.apiKey);
  const survivor = await session(owner.apiKey);
  const foreignSession = await session(foreign.apiKey);
  journal.sessions = { target, survivor, foreignSession };
  save();
  const f = await populateErasureApiFixture(db, owner.org, target, survivor);
  journal.fixture = f;
  save();
  const foreignFact = {
    id: randomUUID(),
    created_at: "2026-01-01T00:00:00.000Z",
    session_id: foreignSession,
    confidence: 1,
    is_verified: false,
    is_suppressed: false,
    fact_type: "Todo" as const,
    description: "Foreign survivor",
    status: "open" as const,
  };
  assert.deepEqual(await createWarmMemory(db).persist([foreignFact], { orgId: foreign.org, sessionId: foreignSession, projectScope: null }), { persisted: 1, skipped: 0, errors: [] });
  const foreignBefore = snapshot(foreign.org);
  const endpoint = `/v1/sessions/${target}/erasure`;
  const preflight = `${endpoint}-preflight`;
  const beforeState = state(f);
  const beforeCoverage = sql(`SELECT to_jsonb(c)::text FROM public.erasure_org_coverage c WHERE org_id=${q(owner.org)};`);
  const inspect = await request(owner.apiKey, "GET", preflight);
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body.status, "ready");
  assert.deepEqual(inspect.body.reasons, []);
  assert.equal(inspect.body.inventory.counts.billing_records, 1);
  assert.equal(inspect.body.inventory.graph_ownership, "shared");
  assert.deepEqual(inspect.body.classifications, {
    scope: "managed_explicit_session_v1",
    deployment: "covered",
    enrollment: "covered",
    database: "covered",
    in_memory: "excluded",
    external_copies: "excluded",
    backups: "excluded",
  });
  assert.deepEqual(state(f), beforeState);
  assert.equal(sql(`SELECT to_jsonb(c)::text FROM public.erasure_org_coverage c WHERE org_id=${q(owner.org)};`), beforeCoverage);
  for (const [method, path] of [
    ["GET", preflight],
    ["POST", endpoint],
  ] as const) {
    assert.equal((await request(foreign.apiKey, method, path)).status, 404);
    assert.equal((await request(projectKey, method, path)).status, 403);
    assert.equal((await request(owner.apiKey, method, path.replace(target, randomUUID()))).status, 404);
  }
  assert.equal((await request(owner.apiKey, "POST", `${endpoint}?org-id=${foreign.org}`)).status, 400);
  assert.equal((await request(owner.apiKey, "POST", endpoint, { coverage: "ready" })).status, 400);
  for (const mode of ["normal", "body-stream", "accept-stream"]) {
    const rejected = await request(
      owner.apiKey,
      "POST",
      "/v1/messages",
      {
        model: "local/erasure-fixture",
        max_tokens: 20,
        messages: [{ role: "user", content: "Synthetic explicit-session input" }],
        ...(mode === "body-stream" ? { stream: true } : {}),
      },
      { "x-cq-conversation-id": target, ...(mode === "accept-stream" ? { accept: "text/event-stream" } : {}) },
    );
    assert.equal(rejected.status, 404);
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(capture), []);
  assert.deepEqual(readdirSync(outbox), []);
  const beforeEnd = snapshot(owner.org);
  assert.equal((await request(owner.apiKey, "DELETE", `/v1/sessions/${target}`)).status, 200);
  const before = snapshot(owner.org);
  for (const table of Object.keys(before)) if (table !== "sessions") assert.deepEqual(before[table], beforeEnd[table], "DELETE removed content");
  assert.equal(before.sessions!.length, 2);
  assert.ok(before.sessions!.find((row) => row.id === target)?.ended_at);
  assert.equal(state(f).state, "active");
  journal.before_digest = hash(JSON.stringify(before));
  journal.captured_ids = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.map((row) => rowIdentity(table, row))]));
  step("normal constructor/writers, read-only preflight, auth, explicit exclusion and end-only HTTP passed");

  // Unknown negative fixture uses generic organization creation, never enrollment.
  const unknown = randomUUID();
  orgs.push(unknown);
  save();
  assert.equal((await db.from("organizations").insert({ id: unknown, name: "Unknown erasure API fixture", plan: "growth" })).error, null);
  const unknownOutput = cli("create-api-key", ["--org-id", unknown, "--name", "Unknown erasure fixture", "--env", "test"]);
  const unknownKey = /\b(cq_test_[A-Za-z0-9_-]+)\b/.exec(unknownOutput)?.[1];
  if (!unknownKey) throw new Error("normal unknown-organization key output is invalid");
  const unknownSession = await session(unknownKey);
  const blocked = await request(unknownKey, "POST", `/v1/sessions/${unknownSession}/erasure`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.status, "blocked");
  assert.ok(blocked.body.reasons.includes("coverage_unknown"));
  assert.ok(blocked.body.reasons.includes("stores_not_inventoried"));
  step("unknown coverage HTTP409");

  injected = true;
  journal.injection = injectionName;
  save();
  sql(`CREATE FUNCTION public.${injectionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic intermediate delete failure'; END $$;
    REVOKE ALL ON FUNCTION public.${injectionName}() FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.${injectionName}() TO devops_erasure_executor;
    CREATE TRIGGER ${injectionName} BEFORE DELETE ON public.billing_records FOR EACH ROW WHEN(OLD.id=${q(f.usage)}::uuid) EXECUTE FUNCTION public.${injectionName}();`);
  const incomplete = await request(owner.apiKey, "POST", endpoint);
  assert.equal(incomplete.status, 503);
  assert.equal(incomplete.body.status, "incomplete");
  assert.equal(incomplete.body.retryable, true);
  assert.deepEqual(snapshot(owner.org), before, "intermediate failure partially deleted content/evidence");
  const fenced = state(f);
  assert.equal(fenced.state, "erasing");
  assert.equal(fenced.receipt, null);
  assert.match(String(fenced.request_id), safeUuid);
  assert.deepEqual(fenced.erased_fact_ids, []);
  assert.deepEqual(fenced.erased_entity_ids, []);
  journal.prepared_request_id = fenced.request_id;
  step("HTTP503 leaves committed fence and full content rollback");
  sql(`DROP TRIGGER ${injectionName} ON public.billing_records; DROP FUNCTION public.${injectionName}();`);
  injected = false;

  let consumedReceipt: Record<string, any> | undefined;
  let resolveRelay!: () => void;
  let rejectRelay!: (error: unknown) => void;
  let relayObserved = false;
  const relayed = new Promise<void>((done, fail) => {
    resolveRelay = done;
    rejectRelay = fail;
  });
  relayed.catch(() => undefined);
  relay = createServer((_incoming, outgoing) => {
    relayObserved = true;
    void request(owner.apiKey, "POST", endpoint)
      .then((result) => {
        assert.equal(result.status, 200);
        consumedReceipt = result.body;
        outgoing.destroy();
        resolveRelay();
      })
      .catch((error: unknown) => {
        outgoing.destroy();
        rejectRelay(error);
      });
  });
  await listen(relay, 0);
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/drop-completed-response`, { method: "POST", signal: AbortSignal.timeout(15_000) }));
  assert.equal(relayObserved, true, "request failed before reaching the response-dropping relay");
  let relayTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      relayed,
      new Promise<never>((_done, fail) => {
        relayTimer = setTimeout(() => fail(new Error("response-dropping relay did not finish")), 15_000);
      }),
    ]);
  } finally {
    if (relayTimer) clearTimeout(relayTimer);
  }
  const retry = await request(owner.apiKey, "POST", endpoint);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, consumedReceipt);
  assert.equal(retry.body.status, "complete");
  assert.equal(retry.body.org_id, owner.org);
  assert.equal(retry.body.session_id, target);
  assert.equal(retry.body.scope, "managed_explicit_session_v1");
  assert.equal(retry.body.request_id, fenced.request_id);
  assert.ok(Number.isFinite(Date.parse(retry.body.completed_at)));
  assert.deepEqual(retry.body.deleted, EXPECTED_DELETED);
  assert.deepEqual(retry.body.retained, EXPECTED_RETAINED);
  assert.deepEqual(retry.body.exclusions, ["client_held_responses", "privileged_host_database_snapshots", "physical_heap_os_remnants"]);
  assert.deepEqual((await request(owner.apiKey, "POST", endpoint)).body, retry.body);
  absence(before, snapshot(owner.org), f);
  assert.deepEqual(snapshot(foreign.org), foreignBefore);
  const graph = createKnowledgeGraph(db);
  assert.equal(await graph.ensureEntity({ orgId: owner.org, sessionId: survivor, projectScope: null, kind: "File", name: "shared.ts", filePath: "shared.ts" }), f.sharedFile);
  assert.equal(await graph.addEdge({ orgId: owner.org, sessionId: survivor, projectScope: null, fromEntity: f.sharedFile, toEntity: f.sharedFunction, edgeType: "DECLARES" }), f.sharedEdge);
  assert.deepEqual((await request(owner.apiKey, "POST", endpoint)).body, retry.body, "shared reuse changed completion receipt");
  assert.equal((await request(owner.apiKey, "GET", `/v1/sessions/${target}`)).status, 404);
  assert.equal((await request(foreign.apiKey, "POST", endpoint)).status, 404);
  const complete = state(f);
  assert.equal(complete.state, "complete");
  assert.deepEqual(complete.receipt, retry.body);
  assert.deepEqual((complete.erased_fact_ids as string[]).slice().sort(), Object.values(f.facts).flat().sort());
  assert.deepEqual((complete.erased_entity_ids as string[]).slice().sort(), [f.privateFile, f.privateFunction].sort());
  assert.equal((await db.from("sessions").insert({ id: target, org_id: unknown, model: "late reuse" })).error?.code, "55000");
  const retired = f.facts.function_changes![0]!;
  assert.equal((await db.from("todos").insert({ id: retired, org_id: unknown, session_id: unknownSession, confidence: 1, description: "late generic reuse" })).error?.code, "55000");
  const restored = await db.rpc("prepare_erasure_restore", { p_org_id: randomUUID(), p_session_ids: [target], p_fact_ids: [], p_entity_ids: [] });
  assert.equal(restored.error?.code, "55000");
  journal.receipt = retry.body;
  journal.remaining_ids = Object.fromEntries(Object.entries(snapshot(owner.org)).map(([table, rows]) => [table, rows.map((row) => rowIdentity(table, row))]));
  step("lost HTTP response, stable retry, independent captured-ID absence and shared/foreign survival passed");
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(outbox), []);
  await stopProxy();
  for (const name of readdirSync(capture)) {
    const empty = JSON.parse(readFileSync(join(capture, name), "utf8")) as { total_turns: number; requests: unknown[] };
    assert.equal(empty.total_turns, 0);
    assert.deepEqual(empty.requests, []);
  }
  journal.status = "passed";
} catch (error) {
  failure = error;
  journal.status = "failed";
  journal.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await stopProxy();
  } catch (error) {
    failure ??= error;
    journal.shutdown_error = error instanceof Error ? error.message : String(error);
  }
  for (const server of [relay, sentinel])
    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        failure ??= error;
        const errors = (journal.server_shutdown_errors ?? []) as string[];
        errors.push(error instanceof Error ? error.message : String(error));
        journal.server_shutdown_errors = errors;
      }
    }
  try {
    if (injected) sql(`DROP TRIGGER IF EXISTS ${injectionName} ON public.billing_records; DROP FUNCTION IF EXISTS public.${injectionName}();`);
  } catch (error) {
    failure ??= error;
    journal.injection_cleanup_error = error instanceof Error ? error.message : String(error);
  }
  try {
    assert.equal(sql(`UPDATE public.erasure_deployment SET enabled=false WHERE id AND activation_id=${q(activation)} RETURNING activation_id;`), activation);
    assert.equal(sql("SELECT NOT enabled FROM public.erasure_deployment WHERE id;"), "t");
    journal.cleanup = {
      generation: "matching activation disabled",
      consumers: journal.shutdown_error || journal.server_shutdown_errors ? "shutdown failed; see recorded error" : "owned consumers stopped",
      injection: journal.injection_cleanup_error ? "removal failed; see recorded error" : "own injection removed",
      fixture: "synthetic rows and receipts retained for evidence",
    };
  } catch (error) {
    failure ??= error;
    journal.cleanup_error = error instanceof Error ? error.message : String(error);
  }
  if (failure) journal.status = "failed";
  journal.provider_calls = calls;
  save();
}
if (failure) {
  process.stderr.write(`Erasure API proof failed; evidence ${journalPath}\n`);
  throw failure;
}
process.stdout.write(`Actual authenticated erasure API proof passed; evidence ${journalPath}\n`);
