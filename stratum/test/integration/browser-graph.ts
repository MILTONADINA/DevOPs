/** Real Chrome check of the served graph dashboard and its local API. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProxy } from "../../src/proxy/app";
import type { GraphSnapshot, MemoryDeps } from "../../src/proxy/routes/memory";

const root = resolve(process.cwd(), "..");
if (resolve(process.cwd()) !== join(root, "stratum")) throw new Error("run from stratum/");
const proofDir = join(root, ".workflow", "proofs");
const chrome = process.env["CHROME_BIN"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`Chrome not found: ${chrome}`);
mkdirSync(proofDir, { recursive: true });
const profile = mkdtempSync(join(proofDir, "graph-chrome-"));
const hostile = '<img src=x onerror="alert(1)">';

const files: GraphSnapshot["entities"] = [
  { id: "00000000-0000-4000-8000-000000000001", kind: "File", name: "src/importer.ts", file_path: "src/importer.ts", summary: "Imports the dependency", session_id: null },
  { id: "00000000-0000-4000-8000-000000000002", kind: "File", name: "src/dependency.ts", file_path: "src/dependency.ts", summary: "Dependency first " + hostile, session_id: null },
];
const dependency: GraphSnapshot["edges"][number] = { id: "00000000-0000-4000-8000-000000000003", edge_type: "DEPENDS_ON", from_entity: files[0]!.id, to_entity: files[1]!.id };
function scoped(orgId: string): void {
  if (orgId !== "browser-check") throw new Error(`unexpected graph organization ${orgId}`);
}
const memory: MemoryDeps = {
  listFacts: async () => [],
  suppressFact: async () => false,
  listConflicts: async () => [],
  listAuditStatuses: async () => [],
  listGraph: async (orgId) => {
    scoped(orgId);
    return { entities: files, edges: [dependency] };
  },
  searchGraph: async (orgId) => {
    scoped(orgId);
    return { entities: files, edges: [dependency], matches: [files[1]!.id] };
  },
  listGraphFiles: async (orgId) => {
    scoped(orgId);
    return { files, next: null };
  },
  listGraphDependencies: async (orgId) => {
    scoped(orgId);
    return { edges: [dependency], next: null };
  },
  listRelatedFacts: async (orgId, file) => {
    scoped(orgId);
    return file === "src/dependency.ts" ? [{ id: "fact", kind: "TechDecision", summary: hostile, created_at: "2026-09-23T00:00:00Z" }] : [];
  },
};

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
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
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

async function main(): Promise<void> {
  const app = buildProxy({ cors: false, rateLimit: false, dashboard: { readSessions: async () => [] }, memory });
  let child: ReturnType<typeof spawn> | undefined;
  let cdp: Awaited<ReturnType<typeof openSocket>> | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    child = spawn(
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
      const timeout = setTimeout(() => rejectUrl(new Error("Chrome did not open DevTools within 15 seconds")), 15_000);
      child!.stderr!.on("data", (chunk: Buffer) => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          resolveUrl(match[1]!);
        }
      });
      child!.on("exit", (code) => {
        clearTimeout(timeout);
        rejectUrl(new Error(`Chrome exited ${code}`));
      });
    });
    const port = new URL(debugUrl).port;
    const target = (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${address}/dashboard/graph?org-id=browser-check`)}`, { method: "PUT" }).then((response) =>
      response.json(),
    )) as { webSocketDebuggerUrl: string };
    cdp = await openSocket(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value as T;
    };
    const until = (condition: string) =>
      evaluate(
        `new Promise((resolve,reject) => { const done = () => { if (${condition}) { observer.disconnect(); clearTimeout(timer); resolve(true); } }; const observer = new MutationObserver(done); observer.observe(document, { subtree: true, childList: true, characterData: true }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('browser condition timed out')); }, 5000); done(); })`,
      );
    await until("document.getElementById('status')?.textContent.includes('2 nodes')");
    await evaluate(`document.querySelector('#viewport g[aria-label="src/dependency.ts"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await until("document.querySelector('#details section li')?.textContent.includes('TechDecision')");
    const selected = await evaluate<{ path: string; imageCount: number }>(
      "({ path: document.querySelector('#details').textContent, imageCount: document.querySelectorAll('#details img,#viewport img').length })",
    );
    if (!selected.path.includes("src/dependency.ts") || !selected.path.includes(hostile) || selected.imageCount !== 0) throw new Error("File selection or literal fact rendering failed");
    await until("document.querySelector('#viewport g[aria-label^=\"TechDecision:\"]')");
    const factCanvas = await evaluate<{ nodes: number; lines: number }>(
      "({ nodes: document.querySelectorAll('#viewport g[aria-label^=\"TechDecision:\"]').length, lines: document.querySelectorAll('#viewport line').length })",
    );
    if (factCanvas.nodes !== 1 || factCanvas.lines !== 2) throw new Error("File-to-fact canvas node or edge was missing");
    const factShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!factShot.data) throw new Error("Chrome returned no fact-node screenshot data");
    writeFileSync(join(proofDir, "graph-browser-fact-node.png"), Buffer.from(factShot.data, "base64"));
    await evaluate("document.querySelector('#viewport g[aria-label^=\"TechDecision:\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    if ((await evaluate<string>("document.querySelector('#details h2').textContent")) !== "TechDecision: " + hostile) throw new Error("fact node selection failed");
    await evaluate("document.querySelector('#relations button').click()");
    if ((await evaluate<string>("document.querySelector('#details h2').textContent")) !== "src/dependency.ts") throw new Error("fact-to-File relationship navigation failed");
    await evaluate("document.getElementById('zoom-in').click(); document.getElementById('search-query').value = 'dependency'; document.getElementById('search').click()");
    await until("document.getElementById('status').textContent.includes('1 matching node')");
    await evaluate("document.getElementById('tour-start').click()");
    await until("document.getElementById('status').textContent.startsWith('Tour 1/2')");
    const first = await evaluate<string>("document.querySelector('#details h2').textContent");
    const firstNarration = await evaluate<string>("document.getElementById('tour-narration')?.textContent");
    await evaluate("document.getElementById('tour-next').click()");
    const second = await evaluate<string>("document.querySelector('#details h2').textContent");
    const secondNarration = await evaluate<string>("document.getElementById('tour-narration')?.textContent");
    const narratedImages = await evaluate<number>("document.querySelectorAll('#tour-narration img').length");
    if (
      first !== "src/dependency.ts" ||
      second !== "src/importer.ts" ||
      !firstNarration?.includes("used by src/importer.ts") ||
      !firstNarration.includes(hostile) ||
      !secondNarration?.includes("depends on src/dependency.ts") ||
      narratedImages !== 0
    ) {
      throw new Error(`Tour narration or order wrong: ${first}, ${second}`);
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (!shot.data) throw new Error("Chrome returned no screenshot data");
    writeFileSync(join(proofDir, "graph-browser.png"), Buffer.from(shot.data, "base64"));
    process.stdout.write(
      "Chrome graph load, in-canvas fact navigation, literal text, search, dependency-first tour, and narration passed; screenshots: .workflow/proofs/graph-browser-fact-node.png and graph-browser.png\n",
    );
  } finally {
    cdp?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`browser graph check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
