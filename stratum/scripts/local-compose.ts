/** Loopback-only Compose stack for this project's local Supabase HTTP API. */
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

type Binding = { HostIp?: string; HostPort?: string };
type Ports = Record<string, Binding[] | null>;
const services = ["db", "rest", "gateway"] as const;
export function resolveLocalStackConfig(env: NodeJS.ProcessEnv): { project: string; names: Record<(typeof services)[number], string>; port: string } {
  const instance = env.DEVOPS_LOCAL_INSTANCE;
  const port = env.DEVOPS_LOCAL_PORT;
  if (instance === undefined && port === undefined) {
    return { project: "devops-stratum-compose", names: { db: "devops-stratum-local-db", rest: "devops-stratum-local-rest", gateway: "devops-stratum-local-gateway" }, port: "54321" };
  }
  if (!instance || !/^[a-z][a-z0-9-]{0,19}$/.test(instance) || instance === "local" || !port || !/^[1-9]\d{3,4}$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || port === "54321") {
    throw new Error("set a safe DEVOPS_LOCAL_INSTANCE and a distinct DEVOPS_LOCAL_PORT (1024-65535) together");
  }
  const prefix = `devops-stratum-isolated-${instance}`;
  return { project: prefix, names: { db: `${prefix}-db`, rest: `${prefix}-rest`, gateway: `${prefix}-gateway` }, port };
}

const localStack = resolveLocalStackConfig(process.env);
const names = localStack.names;
const file = "supabase/docker-compose.local.yml";
const composeArgs = ["compose", "-f", file, "-p", localStack.project];
const projectRoot = realpathSync(join(process.cwd(), ".."));

/** Reject any published DB/REST port and any API bind besides exact IPv4 loopback. */
export function assertLocalPorts(ports: Record<(typeof services)[number], Ports>, expectedPort = "54321"): void {
  for (const service of services) {
    const bindings = Object.values(ports[service]).flatMap((value) => value ?? []);
    if (service !== "gateway" && bindings.length > 0) throw new Error(`${service} must not publish a host port`);
    if (service === "gateway" && (bindings.length !== 1 || bindings[0]?.HostIp !== "127.0.0.1" || bindings[0]?.HostPort !== expectedPort)) {
      throw new Error(`gateway must publish only 127.0.0.1:${expectedPort}`);
    }
  }
}

/** Short-lived service-role JWT for local child processes; no credential file. */
export function serviceJwt(secret: string, expiresAt: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role", iss: "devops-local", exp: expiresAt })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function docker(args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  try {
    return execFileSync("docker", args, { cwd: process.cwd(), env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    // Docker output can include container environment, including the JWT secret.
    const detail = dockerFailureDetail((error as { stderr?: unknown }).stderr);
    throw new Error(`docker ${args[0] ?? ""} ${args[1] ?? ""} failed: ${detail}`);
  }
}

export function dockerFailureDetail(stderr: unknown): string {
  return /toomanyrequests|rate exceeded|too many requests|\b429\b/i.test(String(stderr ?? ""))
    ? "public registry rate limit"
    : "docker command failed";
}

function compose(args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  const composeEnv: NodeJS.ProcessEnv = { ...env, COMPOSE_PARALLEL_LIMIT: "1", COMPOSE_DISABLE_ENV_FILE: "1" };
  delete composeEnv.COMPOSE_ENV_FILES;
  return docker([...composeArgs, ...args], composeEnv, input);
}

export async function retryRateLimited(action: () => void, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      action();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("public registry rate limit") || attempt === 2) throw error;
      const delayMs = 2_000 * (attempt + 1);
      process.stderr.write(`Public registry rate limit; retrying startup in ${delayMs / 1000}s.\n`);
      await wait(delayMs);
    }
  }
}

async function composeUp(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await retryRateLimited(() => { compose(["up", "-d", "--wait", "--wait-timeout", "90", ...args], env); });
}

function stackEnv(secret: string): NodeJS.ProcessEnv {
  return { ...process.env, DEVOPS_LOCAL_JWT_SECRET: secret, DEVOPS_LOCAL_DB_NAME: names.db, DEVOPS_LOCAL_REST_NAME: names.rest, DEVOPS_LOCAL_GATEWAY_NAME: names.gateway, DEVOPS_LOCAL_PORT: localStack.port };
}

function inspectPorts(env: NodeJS.ProcessEnv): void {
  const ports = {} as Record<(typeof services)[number], Ports>;
  for (const service of services) {
    ports[service] = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", names[service]], env)) as Ports;
  }
  assertLocalPorts(ports, localStack.port);
}

function containerStates(env: NodeJS.ProcessEnv): string {
  return services.map((service) => {
    try {
      const state = docker(["inspect", "--format", "{{.State.Status}}/{{.State.ExitCode}}", names[service]], env).trim();
      return `${service}=${state}`;
    } catch {
      return `${service}=absent`;
    }
  }).join(", ");
}

function migrate(env: NodeJS.ProcessEnv): number {
  const sql = (args: string[], input?: string): string => compose(["exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", ...args], env, input);
  sql(["-c", "CREATE SCHEMA IF NOT EXISTS devops_local; CREATE TABLE IF NOT EXISTS devops_local.migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"]);
  const applied = new Set(sql(["-At", "-c", "SELECT version FROM devops_local.migrations"]).trim().split("\n").filter(Boolean));
  const dir = join(process.cwd(), "supabase/migrations");
  let count = 0;
  for (const name of readdirSync(dir).filter((entry) => /^\d+_[\w-]+\.sql$/.test(entry)).sort()) {
    if (applied.has(name)) continue;
    const statement = `INSERT INTO devops_local.migrations(version) VALUES ('${name}')`;
    sql(["--single-transaction", "-f", "-", "-c", statement], readFileSync(join(dir, name), "utf8"));
    count++;
  }
  if (count > 0) sql(["-c", "NOTIFY pgrst, 'reload schema'"]);
  return count;
}

function currentSecret(): string {
  const lines = docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", names.rest], stackEnv("placeholder")).split("\n");
  const entry = lines.find((line) => line.startsWith("PGRST_JWT_SECRET="));
  if (!entry) throw new Error("local REST service is not configured");
  return entry.slice("PGRST_JWT_SECRET=".length);
}

async function start(): Promise<void> {
  const secret = Buffer.from(randomBytes(32)).toString("hex");
  const env = stackEnv(secret);
  let stage = "database container startup";
  try {
    await composeUp(["db"], env);
    stage = "database migration";
    const applied = migrate(env);
    stage = "REST and gateway startup";
    await composeUp(["rest", "gateway"], env);
    stage = "loopback port inspection";
    inspectPorts(env);
    stage = "local API health check";
    const response = await fetch(`http://127.0.0.1:${localStack.port}/rest/v1/`, { headers: { Authorization: `Bearer ${serviceJwt(secret, Math.floor(Date.now() / 1000) + 3600)}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`local API returned HTTP ${response.status}`);
    process.stdout.write(`Local Supabase API ready on 127.0.0.1:${localStack.port}; ${applied} migration(s) applied.\n`);
  } catch (error) {
    const states = containerStates(env);
    try { compose(["down"], env); } catch { /* preserve startup error */ }
    throw new Error(`local stack ${stage} failed (${states}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withEnv(argv: string[]): number {
  if (argv.length === 0) throw new Error("usage: npm run db:with-env -- <command> [args...]");
  const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${localStack.port}`, SUPABASE_SERVICE_KEY: serviceJwt(currentSecret(), Math.floor(Date.now() / 1000) + 86_400), DEVOPS_STRATUM_PROJECT_ROOT: projectRoot };
  const child = spawnSync(argv[0]!, argv.slice(1), { cwd: process.cwd(), env, stdio: "inherit" });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (realpathSync(process.cwd()) !== join(projectRoot, "stratum")) throw new Error("run from stratum/");
  switch (argv[0]) {
    case "start": await start(); return 0;
    case "stop": compose(["down"], stackEnv("placeholder")); return 0;
    case "migrate": process.stdout.write(`${migrate(stackEnv("placeholder"))} migration(s) applied.\n`); return 0;
    case "with-env": return withEnv(argv.slice(1));
    default: throw new Error("usage: local-compose.ts start|stop|migrate|with-env");
  }
}

if ((process.argv[1] ?? "").endsWith("local-compose.ts")) {
  void main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`Local Compose failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
