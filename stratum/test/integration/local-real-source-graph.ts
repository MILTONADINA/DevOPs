/** Real local text model -> source ingestor -> scoped PostgreSQL graph. */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
const endpoint = process.env["CQ_LOCAL_BASE_URL"];
const model = process.env["CQ_SOURCE_SUMMARY_MODEL"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root || !endpoint || !model) {
  throw new Error("run through db:with-env from stratum/ with a real loopback source model");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const foreignOrg = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
const foreignFile = "foreign-secret-file.ts";
const chrome = process.env["CHROME_BIN"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`Chrome not found: ${chrome}`);
const proofDir = join(root, ".workflow", "proofs");
mkdirSync(proofDir, { recursive: true });
const profile = mkdtempSync(join(proofDir, "real-summary-chrome-"));
const source = "stratum/test/fixtures/source-graph";
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

interface CdpResult {
  result?: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
  data?: string;
}
function openSocket(url: string): Promise<{ send: (method: string, params?: object) => Promise<CdpResult>; close: () => void }> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const pending = new Map<number, { resolve: (value: CdpResult) => void; reject: (error: Error) => void }>();
    let nextId = 0;
    socket.addEventListener("open", () =>
      resolveSocket({
        send(method, params = {}) {
          return new Promise((resolveResult, rejectResult) => {
            const id = ++nextId;
            pending.set(id, { resolve: resolveResult, reject: rejectResult });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => socket.close(),
      }),
    );
    socket.addEventListener("error", () => rejectSocket(new Error("Chrome DevTools socket failed")));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: CdpResult; error?: { message: string } };
      if (message.id === undefined) return;
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result ?? {});
    });
  });
}

let failure: unknown;
let app: ReturnType<typeof buildProxy> | undefined;
let browser: ReturnType<typeof spawn> | undefined;
let cdp: Awaited<ReturnType<typeof openSocket>> | undefined;
try {
  checked(
    await db.from("organizations").insert([
      { id: org, name: "DevOPs real source summary check" },
      { id: foreignOrg, name: "DevOPs foreign graph check" },
    ]),
    "insert orgs",
  );
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/ingest-source-graph.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, INGEST_ORG_ID: org, SOURCE_SUBDIR: source },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (child.error || child.status !== 0 || !child.stdout.includes("Indexed 2 source files, 4 entities, 3 edges")) {
    throw new Error(`real source ingest failed: ${child.error?.message ?? (child.stderr || child.stdout)}`);
  }
  const entities = checked(await db.from("knowledge_entities").select("id,kind,name,summary").eq("org_id", org), "read entities");
  const vectors = checked(await db.from("memory_vectors").select("source_ref,embedding").eq("org_id", org).eq("source_type", "entity"), "read vectors");
  const entry = entities.find((entity) => entity.kind === "File" && entity.name === `${source}/entry.ts`);
  const helper = entities.find((entity) => entity.kind === "File" && entity.name === `${source}/helper.ts`);
  const convert = entities.find((entity) => entity.kind === "Function" && entity.name === `${source}/entry.ts#convert`);
  if (
    entities.length !== 4 ||
    vectors.length !== 4 ||
    !entry?.summary ||
    !/convert|helper/i.test(entry.summary) ||
    entry.summary.startsWith("Source file ") ||
    !helper?.summary ||
    !/helper|unchanged/i.test(helper.summary) ||
    helper.summary.startsWith("Source file ") ||
    convert?.summary !== "Convert a sample value using the helper." ||
    vectors.some((vector) => !entities.some((entity) => entity.id === vector.source_ref) || typeof vector.embedding !== "string")
  ) {
    throw new Error("real model File summaries, Function summary, or embeddings did not persist");
  }
  checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(rawKey), name: "real-summary-browser" }), "insert key");
  checked(
    await db.from("knowledge_entities").insert({ id: randomUUID(), org_id: foreignOrg, kind: "File", name: foreignFile, file_path: foreignFile, summary: "FOREIGN-SUMMARY-NO-READ" }),
    "insert foreign File",
  );
  app = buildProxy(
    buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }, { cors: false, rateLimit: false, dashboard: { readSessions: async () => [] } }, (clientUrl, clientKey) =>
      createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
    ),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const debugUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error("Chrome did not open DevTools within 15 seconds")), 15_000);
    browser!.stderr!.on("data", (chunk: Buffer) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]!);
      }
    });
    browser!.on("exit", (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`Chrome exited ${code}`));
    });
  });
  const port = new URL(debugUrl).port;
  const target = (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${address}/dashboard/graph?org-id=${foreignOrg}`)}`, { method: "PUT" }).then((response) => response.json())) as {
    webSocketDebuggerUrl: string;
  };
  cdp = await openSocket(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value as T;
  };
  const until = (condition: string) =>
    evaluate(
      `new Promise((resolve,reject) => { const done = () => { if (${condition}) { observer.disconnect(); clearTimeout(timer); resolve(true); } }; const observer = new MutationObserver(done); observer.observe(document, { subtree: true, childList: true, characterData: true }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('browser condition timed out')); }, 8000); done(); })`,
    );
  await until("document.getElementById('status')?.textContent.includes('Invalid or missing CQ API key')");
  await evaluate(`document.getElementById('key').value = ${JSON.stringify(rawKey)}; document.getElementById('load').click()`);
  await until("document.getElementById('status')?.textContent.includes('4 nodes')");
  if (await evaluate<boolean>(`document.body.textContent.includes(${JSON.stringify(foreignFile)})`)) throw new Error("foreign File appeared under the authenticated key");
  await evaluate(`document.querySelector('#viewport g[aria-label=${JSON.stringify(`${source}/entry.ts`)}]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const shown = await evaluate<{ title: string; summary: string; foreign: boolean; keyLeaked: boolean }>(
    `({ title: document.querySelector('#details h2').textContent, summary: document.querySelectorAll('#details p')[2].textContent,
      foreign: document.body.textContent.includes(${JSON.stringify(foreignFile)}), keyLeaked: document.body.textContent.includes(${JSON.stringify(rawKey)}) })`,
  );
  if (shown.title !== `${source}/entry.ts` || shown.summary !== entry.summary || shown.foreign || shown.keyLeaked) {
    throw new Error("real model File summary was missing, altered, or cross-organization data appeared in Chrome");
  }
  await evaluate("document.getElementById('tour-start').click()");
  await until("document.getElementById('status')?.textContent.startsWith('Tour 1/2')");
  const firstTour = await evaluate<string>("document.getElementById('tour-narration').textContent");
  await evaluate("document.getElementById('tour-next').click()");
  const secondTour = await evaluate<string>("document.getElementById('tour-narration').textContent");
  if (!firstTour.includes(helper.summary.slice(0, 60)) || !secondTour.includes(entry.summary.slice(0, 60)) || firstTour.includes(foreignFile) || secondTour.includes(foreignFile)) {
    throw new Error("real model summaries were absent or out of dependency order in the graph tour");
  }
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!shot.data) throw new Error("Chrome returned no real-summary screenshot data");
  writeFileSync(join(proofDir, "graph-browser-real-summary.png"), Buffer.from(shot.data, "base64"));
  process.stdout.write("Real local model persisted 2 File summaries and 4 embeddings; Chrome rendered scoped sidebar and dependency-order tour summaries\n");
} catch (error) {
  failure = error;
} finally {
  cdp?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    browser.kill("SIGTERM");
    try {
      await once(browser, "exit");
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (error) {
    if (!failure) failure = error;
  }
  for (const tenant of [org, foreignOrg]) {
    for (const table of ["knowledge_edges", "knowledge_entities", "api_keys"]) {
      try {
        checked(await db.from(table).delete().eq("org_id", tenant), `delete ${table}`);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
    try {
      checked(await db.from("organizations").delete().eq("id", tenant), "delete org");
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
for (const tenant of [org, foreignOrg]) {
  const remaining = checked(await db.from("organizations").select("id").eq("id", tenant), "verify org cleanup");
  const remainingEntities = checked(await db.from("knowledge_entities").select("id").eq("org_id", tenant), "verify graph cleanup");
  const remainingVectors = checked(await db.from("memory_vectors").select("id").eq("org_id", tenant), "verify vector cleanup");
  if (remaining.length || remainingEntities.length || remainingVectors.length) throw new Error("real source fixture cleanup left organization, graph, or vector rows");
}
