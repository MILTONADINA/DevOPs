/**
 * Operator setup / readiness check (v0.8.x acceptance: "<5 min cold-clone-to-running").
 *
 * Validates the local environment and reports — given your current .env — exactly which
 * capability tiers are live and which commands you can run RIGHT NOW (FREE/local vs
 * Supabase vs Anthropic-gated). Creates .env from .env.example if missing. FREE; does no
 * network I/O unless you pass --fetch-model (pre-warms the ~23MB ONNX encoder).
 *
 *   npm run setup                    # validate + report readiness
 *   npm run setup -- --fetch-model   # also pre-download the ONNX encoder
 *
 * Preparatory operator tooling (the v0.8.x onboarding slice), built ahead of the gate at
 * standing direction — it wires NOTHING into the request path and claims no unvalidated
 * capability; it only reads the env and reports.
 */

import "dotenv/config";
import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const MIN_NODE_MAJOR = 20;
const RECOMMENDED_NODE_MAJOR = 24;

/** Major version from a "24.12.0" / "v24.12.0" string (→ 0 if unparseable). */
export function nodeMajor(version: string): number {
  const m = version.replace(/^v/, "").match(/^(\d+)/);
  return m && m[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
}

/** Is an env value an unfilled .env.example placeholder (i.e. NOT actually configured)? */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const t = value.trim();
  if (t === "" || t === "...") return true;
  if (t.endsWith("...")) return true; // sk-ant-..., eyJ...
  if (/xxx/i.test(t)) return true; // https://xxx..., neo4j+s://xxx...
  return false;
}

export interface Capabilities {
  local: true;
  supabase: boolean;
  anthropic: boolean;
  auditModel: boolean;
  tee: boolean;
}

/** Decide which capability tiers are available, given a "is this key configured?" predicate. */
export function assessCapabilities(configured: (key: string) => boolean): Capabilities {
  return {
    local: true,
    supabase: configured("SUPABASE_URL") && configured("SUPABASE_SERVICE_KEY"),
    anthropic: configured("ANTHROPIC_API_KEY"),
    auditModel: configured("AUDIT_MODEL_ENDPOINT") && configured("AUDIT_MODEL_API_KEY"),
    tee: configured("AWS_NITRO_ENCLAVE_CID") && configured("AWS_NITRO_PCR0"),
  };
}

interface Tier {
  title: string;
  live: boolean;
  note: string;
  commands: string[];
}

/** The capability-aware command map (pure; testable). */
export function readinessTiers(caps: Capabilities): Tier[] {
  return [
    {
      title: "FREE / local (ONNX pruner + in-memory)",
      live: caps.local,
      note: "always available",
      commands: ["verify-encoder", "shadow-prune", "eval:locomo:survival", "eval:longmemeval:survival", "audit:repo", "bench:tiers"],
    },
    {
      title: "Supabase tiers (warm/cold memory + audit persist/alert)",
      live: caps.supabase,
      note: caps.supabase ? "configured" : "set SUPABASE_URL + SUPABASE_SERVICE_KEY",
      commands: ["verify-tier2", "promote", "understand-codebase", "audit:repo -- --persist", "audit:conflicts"],
    },
    {
      title: "Anthropic-gated (judged evals + live ingestion)",
      live: caps.anthropic,
      note: caps.anthropic ? "configured" : "set ANTHROPIC_API_KEY",
      commands: ["smoke:memory", "smoke:judge", "eval:locomo", "eval:longmemeval", "eval:tierb"],
    },
    {
      title: "Audit Tier-2 spot-check (Llama)",
      live: caps.auditModel,
      note: caps.auditModel ? "configured" : "set AUDIT_MODEL_ENDPOINT + AUDIT_MODEL_API_KEY",
      commands: ["(audit engine Tier-2 real spot-checks)"],
    },
    {
      title: "TEE / crypto (v0.7.x — gated on AWS Nitro + security review)",
      live: caps.tee,
      note: caps.tee ? "configured" : "set AWS_NITRO_ENCLAVE_CID + PCRs",
      commands: ["(ZK-Context decrypt — not yet implemented)"],
    },
  ];
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const fetchModel = argv.includes("--fetch-model");
  const cwd = process.cwd();
  let blockers = 0; // things that stop you running ANYTHING (Node / deps)
  let envCreated = false;

  out("Stratum setup / readiness  (v0.8.x — cold-clone-to-running)");
  out("=".repeat(62));

  // 1) Node version (a hard blocker if too old).
  const nm = nodeMajor(process.versions.node);
  if (nm >= MIN_NODE_MAJOR) out(`  ✓ Node ${process.versions.node}${nm < RECOMMENDED_NODE_MAJOR ? ` (${RECOMMENDED_NODE_MAJOR}+ recommended)` : ""}`);
  else {
    out(`  ✗ Node ${process.versions.node} — need >= ${MIN_NODE_MAJOR}`);
    blockers++;
  }

  // 2) Dependencies (a hard blocker if absent).
  if (existsSync(join(cwd, "node_modules"))) out("  ✓ dependencies installed");
  else {
    out("  ✗ dependencies missing — run: npm install");
    blockers++;
  }

  // 3) .env — create from the template if missing (the FREE/local tier needs no creds,
  //    so a fresh .env is a note, not a blocker).
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");
  if (existsSync(envPath)) {
    out("  ✓ .env present");
  } else if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    envCreated = true;
    out("  ✓ created .env from .env.example (fill in keys to unlock the higher tiers)");
  } else {
    out("  ⚠ no .env and no .env.example (FREE/local tier still runs)");
  }

  // 4) Capability tiers (dotenv has loaded .env into process.env).
  const caps = assessCapabilities((k) => !isPlaceholder(process.env[k]));
  out("");
  out("Capability tiers (given your current .env):");
  for (const t of readinessTiers(caps)) {
    out(`  ${t.live ? "●" : "○"} ${t.title} — ${t.note}`);
    for (const c of t.commands) out(`      ${c.startsWith("(") ? c : `npm run ${c}`}`);
  }

  // 5) Optional ONNX model pre-fetch (opt-in; non-fatal).
  if (fetchModel) {
    out("");
    out("→ pre-fetching the ONNX encoder (~23MB → models/)…");
    try {
      const { createOnnxEncoder } = await import("../src/pruner/encoder");
      const enc = createOnnxEncoder({ cacheDir: join(cwd, "models") });
      const [v] = await enc.encode(["warm up"]);
      out(v && v.length > 0 ? `  ✓ ONNX encoder ready (dim=${v.length})` : "  ⚠ encoder returned no vector");
    } catch (e) {
      out(`  ⚠ model pre-fetch failed (offline?): ${e instanceof Error ? e.message : String(e)} — run \`npm run verify-encoder\` later`);
    }
  }

  // 6) Verdict + next steps.
  out("");
  out("-".repeat(62));
  if (blockers === 0) {
    out("READY ✓ — the FREE/local tier runs now.");
    out("  verify: npm run typecheck && npm run test && npm run verify-encoder");
    if (!caps.supabase) out("  unlock Supabase tiers: set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env");
    if (!caps.anthropic) out("  unlock judged evals / ingestion: set ANTHROPIC_API_KEY in .env");
    if (envCreated) out("  (you just got a fresh .env — fill it in, then re-run `npm run setup`)");
  } else {
    out(`${blockers} blocker(s) above must be fixed first (Node >= ${MIN_NODE_MAJOR}; \`npm install\`), then re-run \`npm run setup\`.`);
  }
  out("Docs: docs/MEMORY_AND_EVAL_COMMANDS.md (FREE vs NEEDS-CREDITS) · README.md");
  return blockers === 0 ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("setup.ts") || entryPath.endsWith("setup.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
