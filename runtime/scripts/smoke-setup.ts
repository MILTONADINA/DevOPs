/** Real loopback proxy/listener and local database smoke check for root setup. */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildProxy, type BuildProxyOptions } from "../src/proxy/app";
import { buildStartOptions } from "../src/proxy/index";
import { createDefaultMessagesDeps } from "../src/proxy/default-deps";

async function main(): Promise<void> {
  const port = process.env["DEVOPS_LOCAL_PORT"] ?? "54321";
  if (process.env["SUPABASE_URL"] !== `http://127.0.0.1:${port}` || !process.env["SUPABASE_SERVICE_KEY"]) {
    throw new Error("run through npm run db:with-env from runtime/");
  }
  // The local-only address lets the real proxy boot without implying a model is installed.
  process.env["CQ_LOCAL_BASE_URL"] ??= "http://127.0.0.1:1/v1";
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const outboxDir = mkdtempSync(join(process.cwd(), "data", "setup-smoke-"));
  let options: BuildProxyOptions | undefined;
  let app: ReturnType<typeof buildProxy> | undefined;
  try {
    options = buildStartOptions(
      {
        CQ_COMMERCIAL: "true",
        SUPABASE_URL: process.env["SUPABASE_URL"],
        SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"],
        CQ_USAGE_OUTBOX_DIR: outboxDir,
      },
      { messages: createDefaultMessagesDeps() },
      createClient,
    );
    app = buildProxy(options);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await response.json()) as { status?: string; dependencies?: { database?: string } };
    if (response.status !== 200 || body.status !== "ok" || body.dependencies?.database !== "ok") {
      throw new Error("proxy health or local database check failed");
    }
    process.stdout.write("Proxy listener and local database health: ok\n");
  } finally {
    await app?.close();
    await options?.messages?.usageOutbox?.close();
    rmSync(outboxDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`setup smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
