import { afterEach, describe, expect, test, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertErasureStartup, erasureChildEnvironment, verifyErasureArtifact } from "../../src/lib/erasure-generation";

const dirs: string[] = [];
const project = join(process.cwd(), "..");
const activation = "62d73725-f22f-411c-9ea5-0a3f74e68b49";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function directoryModes(root: string, mode: number): void {
  for (const item of readdirSync(root)) {
    const full = join(root, item);
    if (lstatSync(full).isDirectory()) directoryModes(full, mode);
  }
  if (!root.includes("/runtime/data")) chmodSync(root, mode);
}
const required = [
  "runtime/src/proxy/index.ts",
  "runtime/src/lib/erasure-generation.ts",
  "runtime/scripts/local-compose.ts",
  "runtime/scripts/create-org.ts",
  "runtime/scripts/create-api-key.ts",
  "runtime/vercel-src/entry.ts",
  "runtime/test/integration/local-session-erasure-api.ts",
  "runtime/test/integration/erasure-api-fixture.ts",
  "runtime/node_modules/tsx/dist/cli.mjs",
  "runtime/supabase/migrations/20261003060000_erasure_generation_binding.sql",
  "runtime/package.json",
  "runtime/package-lock.json",
  "package.json",
  "package-lock.json",
  "runtime/tsconfig.json",
  "runtime/tsconfig.typecheck.json",
  ".claude/settings.json",
  "observability/pii-redaction.ts",
  "hooks/universal/session-start/graph-preflight.sh",
  "hooks/universal/session-start/load-baton.sh",
  "runtime/supabase/docker-compose.local.yml",
  "runtime/supabase/pg_hba.local.conf",
  "runtime/supabase/kong.local.yml",
];
function fixture() {
  const base = join(project, ".workflow/erasure-artifacts");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "unit-"));
  dirs.push(root);
  for (const file of required) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `synthetic public source: ${file}\n`);
    chmodSync(join(root, file), 0o444);
  }
  for (const path of ["runtime/data/sessions", "runtime/data/usage-outbox", "runtime/data/tmp"]) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  const manifest = {
    version: 1,
    instance: "erasure-unit",
    api_port: 54329,
    proxy_port: 4189,
    local_provider_url: "http://127.0.0.1:4190/v1",
    activation_id: activation,
    selectors: ["api-proof", "proxy"],
    stores: { capture: "runtime/data/sessions", outbox: "runtime/data/usage-outbox", tmp: "runtime/data/tmp" },
    files: required.sort().map((path) => ({ path, sha256: sha(readFileSync(join(root, path))) })),
  };
  const path = join(root, "erasure-manifest.json");
  const save = () => {
    try {
      chmodSync(path, 0o644);
    } catch {
      /* first creation */
    }
    writeFileSync(path, JSON.stringify(manifest));
    chmodSync(path, 0o444);
  };
  save();
  directoryModes(root, 0o500);
  return { root, path, manifest, save };
}
function client(data: unknown, error: unknown = null): SupabaseClient {
  return { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data, error })) })) })) })) } as unknown as SupabaseClient;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    directoryModes(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("REQ-5/9 frozen activation artifact", () => {
  test("exact sealed inputs and configuration produce a stable canonical digest", () => {
    const f = fixture();
    const first = verifyErasureArtifact(f.path, project);
    chmodSync(f.path, 0o644);
    writeFileSync(f.path, JSON.stringify(f.manifest, null, 2));
    chmodSync(f.path, 0o444);
    expect(verifyErasureArtifact(f.path, project).digest).toBe(first.digest);
    expect(first.root).toBe(f.root);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  test.each(["runtime/src/proxy/index.ts", "observability/pii-redaction.ts", ".claude/settings.json", "runtime/package-lock.json"])("changed input %s refuses", (name) => {
    const f = fixture();
    chmodSync(join(f.root, name), 0o644);
    writeFileSync(join(f.root, name), "changed");
    chmodSync(join(f.root, name), 0o444);
    expect(() => verifyErasureArtifact(f.path, project)).toThrow(/erasure generation/);
  });
  test("missing and unexpected executable inputs refuse", () => {
    const f = fixture();
    chmodSync(join(f.root, "runtime/src/proxy"), 0o700);
    rmSync(join(f.root, "runtime/src/proxy/index.ts"));
    chmodSync(join(f.root, "runtime/src/proxy"), 0o500);
    expect(() => verifyErasureArtifact(f.path, project)).toThrow();
    const g = fixture();
    chmodSync(join(g.root, "runtime/src"), 0o700);
    writeFileSync(join(g.root, "runtime/src/extra.ts"), "extra");
    chmodSync(join(g.root, "runtime/src"), 0o500);
    expect(() => verifyErasureArtifact(g.path, project)).toThrow();
  });
  test("traversal, duplicate path, mutable input and mutable checkout root refuse", () => {
    const f = fixture();
    f.manifest.files.push({ path: "../escape.ts", sha256: "a".repeat(64) });
    f.save();
    expect(() => verifyErasureArtifact(f.path, project)).toThrow();
    const g = fixture();
    g.manifest.files.push(g.manifest.files[0]!);
    g.save();
    expect(() => verifyErasureArtifact(g.path, project)).toThrow();
    const h = fixture();
    chmodSync(join(h.root, "runtime/src/proxy/index.ts"), 0o644);
    expect(() => verifyErasureArtifact(h.path, project)).toThrow();
    expect(() => verifyErasureArtifact(join(project, "erasure-manifest.json"), project)).toThrow();
  });
  test("bound internal dependency symlink is accepted; escape is rejected", () => {
    const f = fixture();
    const name = "runtime/node_modules/.bin/tsx";
    chmodSync(join(f.root, "runtime/node_modules"), 0o700);
    mkdirSync(dirname(join(f.root, name)), { recursive: true });
    symlinkSync("../tsx/dist/cli.mjs", join(f.root, name));
    directoryModes(f.root, 0o500);
    f.manifest.files.push({ path: name, sha256: sha("symlink:../tsx/dist/cli.mjs"), target: "../tsx/dist/cli.mjs" } as never);
    f.manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    f.save();
    expect(() => verifyErasureArtifact(f.path, project)).not.toThrow();
    chmodSync(dirname(join(f.root, name)), 0o700);
    rmSync(join(f.root, name));
    symlinkSync(join(project, "runtime/node_modules/tsx/dist/cli.mjs"), join(f.root, name));
    chmodSync(dirname(join(f.root, name)), 0o500);
    expect(() => verifyErasureArtifact(f.path, project)).toThrow();
  });
  test.each(["manifest", "code directory"])("writable %s cannot replace sealed lazy-loaded inputs", (part) => {
    const f = fixture();
    chmodSync(part === "manifest" ? f.path : join(f.root, "runtime/src"), part === "manifest" ? 0o644 : 0o700);
    expect(() => verifyErasureArtifact(f.path, project)).toThrow(/erasure generation/);
  });
  test("configuration and allowed selectors are part of the digest", () => {
    const f = fixture();
    const before = verifyErasureArtifact(f.path, project).digest;
    f.manifest.proxy_port = 4191;
    f.save();
    expect(verifyErasureArtifact(f.path, project).digest).not.toBe(before);
    f.manifest.selectors.push("shell");
    f.save();
    expect(() => verifyErasureArtifact(f.path, project)).toThrow();
  });
  test.each(["create-org", "create-api-key"])("unusable standalone %s is not a launch selector", (selector) => {
    const f = fixture();
    f.manifest.selectors.push(selector);
    f.save();
    expect(() => verifyErasureArtifact(f.path, project)).toThrow(/erasure generation/);
  });
  test("minimal child environment cannot inherit loaders, credentials or unknown options", () => {
    const f = fixture();
    const artifact = verifyErasureArtifact(f.path, project);
    const env = erasureChildEnvironment(artifact, "synthetic-service-token", process.execPath);
    expect(env).toMatchObject({ CQ_COMMERCIAL: "true", TSX_DISABLE_CACHE: "1", PORT: "4189", CQ_LOCAL_BASE_URL: f.manifest.local_provider_url, CQ_ERASURE_MANIFEST: f.path });
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "TSX_TSCONFIG_PATH", "ANTHROPIC_API_KEY", "CQ_SHADOW_OBSERVE", "CQ_MEMORY_EXTRACT_MODEL"]) expect(env[name]).toBeUndefined();
    expect(env.CQ_CAPTURE_DIR).toBe(join(f.root, "runtime/data/sessions"));
    expect(env.CQ_USAGE_OUTBOX_DIR).toBe(join(f.root, "runtime/data/usage-outbox"));
  });
});

describe("REQ-5/9 read-only startup admission", () => {
  test("matching bound receipt admits only the exact frozen proxy and fixed environment", async () => {
    const f = fixture();
    const artifact = verifyErasureArtifact(f.path, project);
    writeFileSync(join(f.root, "runtime/data/erasure-launch-used"), `${activation}\n${artifact.digest}\n`);
    const env = erasureChildEnvironment(artifact, "synthetic", process.execPath);
    const row = { enabled: true, source_generation: "managed_explicit_session_v1", activation_id: activation, source_manifest_sha256: artifact.digest };
    const oldEntry = process.argv[1];
    vi.spyOn(process, "cwd").mockReturnValue(join(f.root, "runtime"));
    process.argv[1] = join(f.root, "runtime/src/proxy/index.ts");
    try {
      await expect(assertErasureStartup(env, () => client(row))).resolves.toBeUndefined();
      await expect(assertErasureStartup({ ...env, NODE_OPTIONS: "--import foreign-code" }, () => client(row))).rejects.toThrow(/erasure generation/);
      await expect(assertErasureStartup(env, () => client({ ...row, source_manifest_sha256: "f".repeat(64) }))).rejects.toThrow(/erasure generation/);
      process.argv[1] = join(f.root, "runtime/scripts/create-org.ts");
      await expect(assertErasureStartup(env, () => client(row))).rejects.toThrow(/erasure generation/);
    } finally {
      process.argv[1] = oldEntry!;
    }
  });
  test("prior capture or outbox content cannot be adopted for a fresh startup", async () => {
    const f = fixture();
    const artifact = verifyErasureArtifact(f.path, project);
    writeFileSync(join(f.root, "runtime/data/erasure-launch-used"), `${activation}\n${artifact.digest}\n`);
    writeFileSync(join(f.root, "runtime/data/sessions/old-capture.json"), "synthetic old payload");
    const row = { enabled: true, source_generation: "managed_explicit_session_v1", activation_id: activation, source_manifest_sha256: artifact.digest };
    const oldEntry = process.argv[1];
    vi.spyOn(process, "cwd").mockReturnValue(join(f.root, "runtime"));
    process.argv[1] = join(f.root, "runtime/src/proxy/index.ts");
    try {
      await expect(assertErasureStartup(erasureChildEnvironment(artifact, "synthetic", process.execPath), () => client(row))).rejects.toThrow(/erasure generation/);
    } finally {
      process.argv[1] = oldEntry!;
    }
  });
  test("personal needs no DB call; disabled ordinary deployment remains ordinary", async () => {
    const make = vi.fn(() => client({ enabled: false }));
    await assertErasureStartup({}, make);
    expect(make).not.toHaveBeenCalled();
    await assertErasureStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "http://127.0.0.1:54329", SUPABASE_SERVICE_KEY: "synthetic" }, make);
    expect(make).toHaveBeenCalledOnce();
  });
  test.each([null, { enabled: true }, { enabled: "false" }])("missing/malformed or enabled-unbound metadata refuses: %j", async (data) => {
    await expect(assertErasureStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "http://127.0.0.1:54329", SUPABASE_SERVICE_KEY: "synthetic" }, () => client(data))).rejects.toThrow(/erasure generation/);
  });
  test("transport error is sanitized and cannot become disabled authority", async () => {
    await expect(
      assertErasureStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "http://127.0.0.1:54329", SUPABASE_SERVICE_KEY: "synthetic" }, () => client(null, { message: "private-token-value", code: "08006" })),
    ).rejects.toThrow("erasure generation unavailable");
  });
});
