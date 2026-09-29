// Tests for specs/security/stratum-local-network.md that need a REAL OS process: start() runs the startup checks, and only a spawn of the real entry point (src/proxy/index.ts) shows that a refusal
// exits non-zero with its message and that a permitted start reaches "CQ Proxy running". One describe block each for AC-4 (REQ-3: no unauthenticated remote bind), AC-5 (REQ-4: numeric settings fail
// closed) and AC-6 (REQ-5: upstream transport). Each block spawns the entry point once per refusal or behaviour class; the exhaustive per-value coverage is in start-options.test.ts, where the exported
// checks start() calls (assertRemoteBindAllowed, resolvePort, resolveRateLimitMax, assertUpstreamAllowed) are called directly, without a process per case (see each section's own header).
//
// Mechanics:
//   - The real entry point is spawned as `node <tsx's cli.mjs> src/proxy/index.ts`, not through node_modules/.bin/tsx's shebang shim, for determinism across platforms and sandboxes.
//   - `env` is built from scratch every time (PATH and HOME, plus the settings under test); process.env is never spread in, so no other setting of the machine that runs the tests reaches a spawn.
//     DOTENV_CONFIG_PATH points at a nonexistent path, the convention of test/scripts/operator-scripts-config.test.ts: nothing under src/ imports dotenv, so the entry point reads no .env file, and the
//     nonexistent path keeps a developer's runtime/.env out of a spawn even if a dotenv import were added to its import chain.
//   - CQ_LOCAL_BASE_URL=http://127.0.0.1:1/v1 (baseEnv) is load-bearing: start() calls createDefaultMessagesDeps() after the REQ-3, REQ-4 and REQ-5 checks, and that throws "no LLM provider configured"
//     when no provider is set. Without a provider no spawn could reach "CQ Proxy running", and a refusal test's exit-code assertion could hold for the wrong reason (a non-zero exit from the missing
//     provider, not from the check under test). Port 1 on loopback needs no real model server, because startup never connects to an upstream, and it is a valid upstream under REQ-5: loopback http is
//     allowed, and port 1 never equals a spawn's PORT, so it is no self-loop either.
//   - NODE_ENV and LOG_LEVEL are left unset: NODE_ENV=development would switch src/lib/logger.ts to a pino-pretty transport, an extra sink hop this file's assertions should not depend on.
//   - PORT comes from freePort(): each spawn asks the OS for a free loopback port (a throwaway net.Server bound to 127.0.0.1 port 0), releases it, and passes that number as PORT, so no test starts the
//     proxy on a fixed port. It is not the string "0" standing in for "any free port", because REQ-4 refuses PORT=0 and every test below would then fail for that reason; the AC-5 section passes "0" on
//     purpose, to prove the refusal.
//   - Assertions read combined stdout+stderr, not just the exit code, and accept either stream, so this file does not depend on which one carries the refusal message.
//   - Output is finalized from the child's `close` event, which only fires once Node has fully drained the child's stdio pipes; `exit` can fire before the last chunk has been delivered to this process.

import { describe, test, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { isLoopbackBindAddress } from "../../src/proxy/network-settings";

// vitest runs with cwd = runtime/ (package.json: "test": "vitest run").
const RUNTIME_ROOT = process.cwd();
const TSX_CLI = path.join(RUNTIME_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = "src/proxy/index.ts";

/** A free loopback port, asked from the OS (a throwaway listener on 127.0.0.1, port 0) and released again just before the proxy is started on it, so no test uses a fixed port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface EntryPointOutcome {
  /** True once "CQ Proxy running" appeared in the combined output (a real successful listen). */
  reachedRunning: boolean;
  /** The parsed fields of that running log line, when reachedRunning is true. */
  runningFields: { host?: unknown; port?: unknown } | undefined;
  /** The child's exit code once fully closed; null if it never closed within the cleanup budget. */
  exitCode: number | null;
  /** Combined stdout+stderr, arrival order, finalized at `close`. */
  output: string;
}

/**
 * Spawn the real proxy entry point with an explicit, from-scratch env, and observe whether it
 * refuses (exits) or starts (logs "CQ Proxy running") within `budgetMs`. Always cleans up: SIGTERM,
 * then SIGKILL if the child has not closed shortly after.
 */
async function runEntryPoint(env: Record<string, string>, budgetMs = 6_000): Promise<EntryPointOutcome> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [TSX_CLI, ENTRY], {
    cwd: RUNTIME_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let reachedRunning = false;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const onData = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (!reachedRunning && /"msg":"CQ Proxy running"/.test(output)) {
      reachedRunning = true;
      resolveReady?.();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });

  const budget = new Promise<void>((resolve) => setTimeout(resolve, budgetMs));
  await Promise.race([closed, ready, budget]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  const exitCode = await Promise.race([closed, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))]);

  let runningFields: { host?: unknown; port?: unknown } | undefined;
  const runningLine = output.split("\n").find((line) => line.includes(`"msg":"CQ Proxy running"`));
  if (runningLine) {
    try {
      runningFields = JSON.parse(runningLine) as { host?: unknown; port?: unknown };
    } catch {
      // leave runningFields undefined — the reachedRunning flag (a plain substring match) still holds
    }
  }

  return { reachedRunning, runningFields, exitCode, output };
}

const baseEnv = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  CQ_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", // load-bearing — see file header
  DOTENV_CONFIG_PATH: "/nonexistent/start-entrypoint-config.env",
  ...extra,
});

describe("REQ-3 startup refusal — spawned entry point (specs/security/stratum-local-network.md#AC-4)", () => {
  test("DEVOPS_PROXY_HOST=0.0.0.0 with no auth and no opt-in refuses to start — specs/security/stratum-local-network.md#AC-4", async () => {
    const port = await freePort();
    const outcome = await runEntryPoint(baseEnv({ DEVOPS_PROXY_HOST: "0.0.0.0", PORT: String(port) }));
    // A refusal exits on its own, before listen(), with a non-zero code; a null exit code means the child had not closed when the helper gave up.
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/loopback/i);
    expect(outcome.output).toMatch(/auth/i);
    expect(outcome.output).toMatch(/DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED/);
  }, 15_000);

  // The start via the opt-in has to reach a real listen(), and no test in this file binds a non-loopback address (the two refusal tests here name 0.0.0.0 but exit before listen()). So this test
  // binds "127.1": isLoopbackBindAddress rejects that spelling (it needs four octets), which makes the opt-in necessary, and the OS resolves "127.1" to 127.0.0.1, so the listener stays on loopback.
  test("DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 starts, logs the warning and exits 0 on SIGTERM, on an address the loopback check rejects but the OS resolves to 127.0.0.1 — specs/security/stratum-local-network.md#AC-4", async () => {
    // Premise: the gate treats this spelling as a remote bind, so only the opt-in lets it start.
    expect(isLoopbackBindAddress("127.1")).toBe(false);
    const port = await freePort();
    const outcome = await runEntryPoint(baseEnv({ DEVOPS_PROXY_HOST: "127.1", DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: "1", PORT: String(port) }));
    // Mutation: a gate that refuses although the opt-in is "1", so the process exits before it logs "CQ Proxy running".
    expect(outcome.reachedRunning).toBe(true);
    // The bind address the process took from DEVOPS_PROXY_HOST, and the port it was given.
    expect(outcome.runningFields?.host).toBe("127.1");
    expect(outcome.runningFields?.port).toBe(port);
    // It logged the warning: the output names the opt-in and the allow-list, and does not claim the proxy is reachable from other machines.
    expect(outcome.output).toMatch(/DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED/);
    expect(outcome.output).toMatch(/DEVOPS_PROXY_ALLOWED_HOSTS/);
    expect(outcome.output).not.toMatch(/reachable from other machines/i);
    // The helper's SIGTERM ends it through the graceful shutdown.
    expect(outcome.exitCode).toBe(0);
  }, 15_000);

  test("HOST=0.0.0.0 alone behaves like DEVOPS_PROXY_HOST and logs the deprecation warning — specs/security/stratum-local-network.md#AC-4", async () => {
    const port = await freePort();
    // DEVOPS_PROXY_HOST is absent on purpose: this test is about the HOST alias acting on its own. The precedence when both are set is covered by the resolveListenHost and usesDeprecatedHostAlias
    // tests in start-options.test.ts.
    const outcome = await runEntryPoint(baseEnv({ HOST: "0.0.0.0", PORT: String(port) }));
    // The alias is refused like DEVOPS_PROXY_HOST=0.0.0.0: no auth and no opt-in.
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/loopback/i);
    expect(outcome.output).toMatch(/auth/i);
    expect(outcome.output).toMatch(/DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED/);
    // The deprecation warning for HOST names DEVOPS_PROXY_HOST.
    expect(outcome.output).toMatch(/deprecat/i);
    expect(outcome.output).toMatch(/DEVOPS_PROXY_HOST/);
  }, 15_000);
});

// AC-4's bullet "the same [DEVOPS_PROXY_HOST=0.0.0.0] with auth configured starts" has no spawn. assertRemoteBindAllowed's "auth configured ... allows a non-loopback bind" unit test in start-options.test.ts
// proves it, and the opt-in spawn above shows once that an allowed bind reaches a real app.listen() through the real wiring. A commercial-mode spawn needs meaningfully more scaffolding than the three
// spawns above: assertCommercialStartup() requires CQ_BILLING_SIGNING_SECRET, and buildStartOptions() then creates the local usage outbox, whose construction reads CQ_USAGE_OUTBOX_DIR (default
// <cwd>/data/usage-outbox) and starts replaying any queued event files through the Supabase usage recorder (a real database call per file), before app.listen(). A hermetic spawn would need the billing
// secret and a fresh, empty outbox directory (never the default one, which can hold real queued files), for a fact that is a pure boolean decision and needs no process-level proof.

// ===== specs/security/stratum-local-network.md — AC-5 (REQ-4: numeric settings fail closed) =====
//
// AC-5 names five values: RATE_LIMIT_MAX=abc, RATE_LIMIT_MAX=0, PORT=0, PORT=70000 and PORT=x. Two are spawned, one per validated variable, because start() runs one check per variable (resolvePort and
// resolveRateLimitMax) and each spawn proves that check runs before the proxy listens. The rest are decision-logic facts about those two functions, proved without a process per case by their tests in
// start-options.test.ts, which also pin the exact rejected-value text.
//   - PORT=0 is a valid request at the socket layer (listen(0) binds any free port), so only start()'s own check can refuse it.
//   - RATE_LIMIT_MAX=abc is the spec's own example (its Problem section): a value that parses to NaN. Unvalidated, @fastify/rate-limit falls back to its own default of 1000 per window.
// PORT=70000 and PORT=x are not spawned: an out-of-range or NaN port also makes Node's own listen() fail, with a message that begins "options.port should be >= 0 and < 65536", so a spawn that asserted only
// a non-zero exit could not tell REQ-4's refusal from that failure. resolvePort's unit tests pin the message instead: the exact raw value, and the case-sensitive, word-bounded /\bPORT\b/ that the lowercase
// "options.port" does not match. RATE_LIMIT_MAX=0 is the same "positive integer" check as RATE_LIMIT_MAX=abc; its 0-versus-1 boundary is a pure decision-logic fact, proved by the unit tests.
describe("REQ-4 numeric settings refusal — spawned entry point (specs/security/stratum-local-network.md#AC-5)", () => {
  test("PORT=0 refuses to start, naming PORT and the rejected value 0 — specs/security/stratum-local-network.md#AC-5", async () => {
    // "0" is REQ-4's own named rejected value, so it is passed literally instead of coming from freePort(). The refusal happens before listen(), so no port is ever bound.
    const outcome = await runEntryPoint(baseEnv({ PORT: "0" }));
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    // Case-sensitive, and anchored to the same output line as the value: Node's own listen() failure names the lowercase "options.port", which a case-insensitive /PORT/i would match; a bare /\b0\b/
    // across the whole combined output could also match an unrelated pino field on a different line.
    expect(outcome.output).toMatch(/PORT[^\n]*\b0\b/);
  }, 15_000);

  test("RATE_LIMIT_MAX=abc refuses to start, naming RATE_LIMIT_MAX and the rejected value abc — specs/security/stratum-local-network.md#AC-5", async () => {
    // A normal free port, not "0", isolates RATE_LIMIT_MAX as the only setting under test: PORT=0 would be refused for its own reason (see the test above).
    const port = await freePort();
    const outcome = await runEntryPoint(baseEnv({ RATE_LIMIT_MAX: "abc", PORT: String(port) }));
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/RATE_LIMIT_MAX[^\n]*abc/);
  }, 15_000);
});

// ===== specs/security/stratum-local-network.md — AC-6 (REQ-5: upstream transport) =====
//
// Two of AC-6's five bullets are spawned, one per refusal class: plain http to a non-loopback host, and a self-loop. The three "starts" bullets (the same URL with DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1, a
// loopback CQ_LOCAL_BASE_URL, an https URL) and the self-loop cases (the same host name, a loopback upstream against a bind-all listener, this machine's own interface addresses, a different port) are
// decisions of assertUpstreamAllowed, proved without a process per case by its unit tests in start-options.test.ts, which match the variable name, the opt-in name and "self-loop" in the refusal.
//
// Both spawns set ANTHROPIC_BASE_URL with no ANTHROPIC_API_KEY. REQ-5's check reads the setting alone, so it refuses whether or not that provider is otherwise configured; resolving a provider's credentials
// returns null before it reads the base URL when its API key is absent, so a check hung off provider configuration would never see either value.
//
// baseEnv()'s CQ_LOCAL_BASE_URL=http://127.0.0.1:1/v1 (see the file header) is a valid upstream under REQ-5: loopback http, and port 1 never equals either spawn's PORT, so it is never a self-loop either.
// It isolates each assertion below to ANTHROPIC_BASE_URL alone.
describe("REQ-5 upstream-transport refusal — spawned entry point (specs/security/stratum-local-network.md#AC-6)", () => {
  test("ANTHROPIC_BASE_URL=http://10.0.0.5:8080 (plain http, non-loopback host, no opt-in) refuses to start, naming the variable and the opt-in — specs/security/stratum-local-network.md#AC-6", async () => {
    const port = await freePort();
    const outcome = await runEntryPoint(baseEnv({ ANTHROPIC_BASE_URL: "http://10.0.0.5:8080", PORT: String(port) }));
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/ANTHROPIC_BASE_URL/);
    expect(outcome.output).toMatch(/DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM/);
  }, 15_000);

  test("ANTHROPIC_BASE_URL pointed at the proxy's own listen address refuses as a self-loop — specs/security/stratum-local-network.md#AC-6", async () => {
    const port = await freePort();
    const outcome = await runEntryPoint(baseEnv({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, PORT: String(port) }));
    expect(outcome.exitCode).not.toBeNull();
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/ANTHROPIC_BASE_URL/);
    expect(outcome.output).toMatch(/self.?loop|listen/i);
  }, 15_000);
});
