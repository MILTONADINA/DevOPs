/** Real loopback proxy/listener and local database smoke check for root setup. */
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../src/proxy/app";
import { buildStartOptions } from "../src/proxy/index";
import { createDefaultMessagesDeps } from "../src/proxy/default-deps";

async function main(): Promise<void> {
  if (process.env["SUPABASE_URL"] !== "http://127.0.0.1:54321" || !process.env["SUPABASE_SERVICE_KEY"]) {
    throw new Error("run through npm run db:with-env from stratum/");
  }
  // The local-only address lets the real proxy boot without implying a model is installed.
  process.env["CQ_LOCAL_BASE_URL"] ??= "http://127.0.0.1:1/v1";
  const app = buildProxy(
    buildStartOptions(
      {
        CQ_COMMERCIAL: "true",
        SUPABASE_URL: process.env["SUPABASE_URL"],
        SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"],
      },
      { messages: createDefaultMessagesDeps() },
      createClient,
    ),
  );
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await response.json()) as { status?: string; dependencies?: { database?: string } };
    if (response.status !== 200 || body.status !== "ok" || body.dependencies?.database !== "ok") {
      throw new Error("proxy health or local database check failed");
    }
    process.stdout.write("Proxy listener and local database health: ok\n");
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`setup smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
