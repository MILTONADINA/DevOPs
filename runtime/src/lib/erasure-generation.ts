/** Operator-bound local generation admission (session-erasure REQ-5/9/13). */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ERASURE_ENTRIES = {
  "api-proof": "runtime/test/integration/local-session-erasure-api.ts",
  proxy: "runtime/src/proxy/index.ts",
} as const;
const trees = ["runtime/src", "runtime/scripts", "runtime/vercel-src", "runtime/node_modules", "runtime/supabase/migrations", "observability", "hooks"];
const fixed = [
  "runtime/package.json",
  "runtime/package-lock.json",
  "package.json",
  "package-lock.json",
  "runtime/tsconfig.json",
  "runtime/tsconfig.typecheck.json",
  ".claude/settings.json",
  "runtime/supabase/docker-compose.local.yml",
  "runtime/supabase/pg_hba.local.conf",
  "runtime/supabase/kong.local.yml",
  ...Object.values(ERASURE_ENTRIES),
  "runtime/scripts/create-api-key.ts",
  "runtime/scripts/create-org.ts",
  "runtime/test/integration/erasure-api-fixture.ts",
  "runtime/src/lib/erasure-generation.ts",
  "runtime/scripts/local-compose.ts",
  "runtime/node_modules/tsx/dist/cli.mjs",
  "observability/pii-redaction.ts",
  "hooks/universal/session-start/graph-preflight.sh",
  "hooks/universal/session-start/load-baton.sh",
  "runtime/supabase/migrations/20261003060000_erasure_generation_binding.sql",
];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const port = z.number().int().min(1024).max(65535);
const schema = z
  .object({
    version: z.literal(1),
    instance: z.string().regex(/^erasure-[a-z0-9-]{1,12}$/),
    api_port: port.refine((value) => value !== 54321),
    proxy_port: port,
    local_provider_url: z.string().url(),
    activation_id: z.string().uuid(),
    selectors: z.array(z.enum(["api-proof", "proxy"])).nonempty(),
    stores: z.object({ capture: z.literal("runtime/data/sessions"), outbox: z.literal("runtime/data/usage-outbox"), tmp: z.literal("runtime/data/tmp") }).strict(),
    files: z.array(z.object({ path: z.string(), sha256: digest, target: z.string().optional() }).strict()).nonempty(),
  })
  .strict();
export type ErasureManifest = z.infer<typeof schema>;
export interface ErasureArtifact {
  root: string;
  projectRoot: string;
  manifestPath: string;
  manifest: ErasureManifest;
  digest: string;
}

function unavailable(): never {
  throw new Error("erasure generation unavailable");
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function validPath(path: string): boolean {
  return (
    path !== "" && !isAbsolute(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(part))
  );
}
function assertNoSymlinkParents(root: string, path: string, sealed = false): void {
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (sealed && (stat.mode & 0o222) !== 0)) unavailable();
  }
}
function listTree(root: string, rel: string, found: Set<string>): void {
  const target = join(root, rel);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || stat.isFile()) {
    found.add(rel);
    return;
  }
  if (!stat.isDirectory() || (stat.mode & 0o222) !== 0) unavailable();
  for (const child of readdirSync(target)) listTree(root, `${rel}/${child}`, found);
}

/** Reads only named public artifact inputs. Credentials and dotenv are never read. */
export function verifyErasureArtifact(manifestPath: string, projectRoot: string): ErasureArtifact {
  try {
    const project = realpathSync(projectRoot);
    const path = resolve(manifestPath);
    const root = dirname(path);
    const base = join(project, ".workflow", "erasure-artifacts");
    if (dirname(root) !== base || !/^[a-zA-Z0-9-]+$/.test(root.slice(base.length + 1)) || path !== join(root, "erasure-manifest.json")) unavailable();
    assertNoSymlinkParents(project, path);
    if (lstatSync(path).isSymbolicLink() || (lstatSync(path).mode & 0o222) !== 0 || realpathSync(root) !== root || (lstatSync(root).mode & 0o277) !== 0) unavailable();
    const manifest = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    const provider = new URL(manifest.local_provider_url);
    if (
      provider.protocol !== "http:" ||
      provider.hostname !== "127.0.0.1" ||
      provider.username ||
      provider.password ||
      !provider.port ||
      [manifest.api_port, manifest.proxy_port].includes(Number(provider.port)) ||
      manifest.api_port === manifest.proxy_port
    )
      unavailable();
    if (new Set(manifest.selectors).size !== manifest.selectors.length) unavailable();
    // dotenv/config uses cwd; an unlisted dotenv file must not override this binding.
    for (const dir of [root, join(root, "runtime")]) if (readdirSync(dir).some((name) => /^\.env(?:\.|$)/i.test(name))) unavailable();
    const declared = new Set<string>();
    const folded = new Set<string>();
    for (const file of manifest.files) {
      if (!validPath(file.path) || declared.has(file.path) || folded.has(file.path.toLowerCase())) unavailable();
      if (!fixed.includes(file.path) && !trees.some((tree) => file.path.startsWith(`${tree}/`))) unavailable();
      declared.add(file.path);
      folded.add(file.path.toLowerCase());
      const full = join(root, file.path);
      assertNoSymlinkParents(root, full, true);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full);
        const resolved = realpathSync(full);
        if (
          target !== file.target ||
          isAbsolute(target) ||
          !inside(root, resolved) ||
          !lstatSync(resolved).isFile() ||
          !manifest.files.some((entry) => entry.path === relative(root, resolved).split(sep).join("/")) ||
          hash(`symlink:${target}`) !== file.sha256
        )
          unavailable();
      } else if (!stat.isFile() || file.target !== undefined || (stat.mode & 0o222) !== 0 || hash(readFileSync(full)) !== file.sha256) unavailable();
    }
    if (fixed.some((name) => !declared.has(name))) unavailable();
    const discovered = new Set<string>();
    for (const tree of trees) listTree(root, tree, discovered);
    if ([...discovered].some((name) => !declared.has(name))) unavailable();
    for (const path of Object.values(manifest.stores)) {
      const full = join(root, path);
      assertNoSymlinkParents(root, full);
      const stat = lstatSync(full);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) unavailable();
    }
    // Sorting files/selectors makes JSON whitespace and property order irrelevant.
    manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    manifest.selectors.sort();
    return { root, projectRoot: project, manifestPath: path, manifest, digest: hash(JSON.stringify(canonical(manifest))) };
  } catch {
    return unavailable();
  }
}

/** No inherited env: the operator supplies credentials only after artifact verification. */
export function erasureChildEnvironment(artifact: ErasureArtifact, serviceToken: string, node: string): NodeJS.ProcessEnv {
  const { root, manifest } = artifact;
  return {
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_ENV: "production",
    TSX_DISABLE_CACHE: "1",
    TMPDIR: join(root, manifest.stores.tmp),
    DOTENV_CONFIG_PATH: join(root, manifest.stores.tmp, "no-dotenv"),
    CQ_COMMERCIAL: "true",
    DEVOPS_PROXY_HOST: "127.0.0.1",
    PORT: String(manifest.proxy_port),
    CQ_LOCAL_BASE_URL: manifest.local_provider_url,
    CQ_CAPTURE_DIR: join(root, manifest.stores.capture),
    CQ_USAGE_OUTBOX_DIR: join(root, manifest.stores.outbox),
    CQ_ERASURE_MANIFEST: artifact.manifestPath,
    CQ_ERASURE_ACTIVATION_ID: manifest.activation_id,
    DEVOPS_STRATUM_PROJECT_ROOT: artifact.projectRoot,
    DEVOPS_LOCAL_INSTANCE: manifest.instance,
    DEVOPS_LOCAL_PORT: String(manifest.api_port),
    SUPABASE_URL: `http://127.0.0.1:${manifest.api_port}`,
    SUPABASE_SERVICE_KEY: serviceToken,
  };
}

export function assertArtifactDeployment(artifact: ErasureArtifact, data: unknown): void {
  const row = z
    .object({
      enabled: z.literal(true),
      source_generation: z.literal("managed_explicit_session_v1"),
      activation_id: z.literal(artifact.manifest.activation_id),
      source_manifest_sha256: z.literal(artifact.digest),
    })
    .safeParse(data);
  if (!row.success) unavailable();
}

/** Read-only metadata gate before provider/capture/outbox construction. Never activates. */
export async function assertErasureStartup(env: NodeJS.ProcessEnv, makeClient: (url: string, key: string) => SupabaseClient): Promise<void> {
  try {
    const commercial = env.CQ_COMMERCIAL === "true" || env.CQ_COMMERCIAL === "1";
    if (!commercial) {
      if (env.CQ_ERASURE_MANIFEST) unavailable();
      return;
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) unavailable();
    const { data, error } = await makeClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY).from("erasure_deployment").select("*").eq("id", true).single();
    if (error) {
      // A known absent authority table is legacy/unactivated, never positive proof.
      if (!env.CQ_ERASURE_MANIFEST && ["42P01", "PGRST205"].includes(error.code)) return;
      unavailable();
    }
    if (data?.enabled === false && !env.CQ_ERASURE_MANIFEST) return;
    if (!env.CQ_ERASURE_MANIFEST || !env.DEVOPS_STRATUM_PROJECT_ROOT) unavailable();
    const artifact = verifyErasureArtifact(env.CQ_ERASURE_MANIFEST, env.DEVOPS_STRATUM_PROJECT_ROOT);
    assertArtifactDeployment(artifact, data);
    const expected = erasureChildEnvironment(artifact, env.SUPABASE_SERVICE_KEY, process.execPath);
    for (const key of Object.keys(expected).filter((name) => name !== "PATH")) if (env[key] !== expected[key]) unavailable();
    for (const key of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "TSX_TSCONFIG_PATH",
      "TS_NODE_PROJECT",
      "TS_NODE_COMPILER_OPTIONS",
      "CQ_SHADOW_OBSERVE",
      "CQ_MEMORY_EXTRACT_MODEL",
      "CQ_AUDIT_REPO_ROOT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GEMINI_API_KEY",
      "VERCEL",
    ])
      if (env[key]) unavailable();
    if (realpathSync(process.cwd()) !== join(artifact.root, "runtime") || realpathSync(process.argv[1] ?? "") !== join(artifact.root, ERASURE_ENTRIES.proxy)) unavailable();
    if (readFileSync(join(artifact.root, "runtime/data/erasure-launch-used"), "utf8") !== `${artifact.manifest.activation_id}\n${artifact.digest}\n`) unavailable();
    for (const store of [artifact.manifest.stores.capture, artifact.manifest.stores.outbox]) if (readdirSync(join(artifact.root, store)).length !== 0) unavailable();
  } catch {
    unavailable();
  }
}
