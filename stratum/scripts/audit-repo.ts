/**
 * Deterministic audit runner (v0.6.x Tier-1) — FREE (real `git`, no LLM).
 *
 * Indexes a repo's recent git history into structured {@link CodeChange}s and reports
 * them; with `--facts <file>` it attests those facts against the history (Tier-1
 * CONFIRMED / UNVERIFIED / CONFLICT) and, with `--persist` + Supabase creds, records
 * CONFLICTs to audit_conflicts. The runnable surface of the audit engine — no
 * Anthropic (Tier-2/3 escalation of UNVERIFIED facts is the gated next step).
 *
 *   npm run audit:repo                                  # index THIS repo, report changes
 *   npm run audit:repo -- --max-count 50
 *   npm run audit:repo -- --facts claims.json           # attest claims (a JSON array of facts)
 *   npm run audit:repo -- --facts claims.json --persist --org-id <uuid> --session-id <uuid>
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { indexRepository } from "../src/audit/git-indexer";
import { auditFacts, summarizeAudit, persistConflicts } from "../src/audit/audit-engine";
import type { CodeChange } from "../src/audit/git-attestation";
import type { AnyFact } from "../src/types/facts";

interface Args {
  factsPath?: string;
  maxCount: number;
  persist: boolean;
  orgId?: string;
  sessionId?: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { maxCount: 100, persist: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--facts":
        out.factsPath = val();
        break;
      case "--max-count":
        out.maxCount = Math.max(1, Number.parseInt(val(), 10) || 100);
        break;
      case "--persist":
        out.persist = true;
        break;
      case "--org-id":
        out.orgId = val();
        break;
      case "--session-id":
        out.sessionId = val();
        break;
      default:
        break;
    }
  }
  return out;
}

/** Summarize an indexer change-set: distinct commits + counts by change type. */
export function summarizeIndex(changes: CodeChange[]): { commits: number; added: number; deleted: number; modified: number; files: number } {
  const commits = new Set<string>();
  const files = new Set<string>();
  let added = 0;
  let deleted = 0;
  let modified = 0;
  for (const c of changes) {
    commits.add(c.commitHash);
    if (c.filePath) files.add(c.filePath);
    if (c.changeType === "added") added++;
    else if (c.changeType === "deleted") deleted++;
    else if (c.changeType === "modified") modified++;
  }
  return { commits: commits.size, added, deleted, modified, files: files.size };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);

  let changes: CodeChange[];
  try {
    changes = await indexRepository({ maxCount: args.maxCount });
  } catch (e) {
    out(`Not a git repository (or git unavailable): ${e instanceof Error ? e.message : String(e)}. Exiting 0.`);
    return 0;
  }

  out("Deterministic audit (Tier-1; real git, no LLM)");
  out("=".repeat(50));
  const idx = summarizeIndex(changes);
  out(`Indexed last ${args.maxCount} commits → ${changes.length} code change(s) across ${idx.commits} commit(s), ${idx.files} file(s): ${idx.added} added, ${idx.deleted} deleted, ${idx.modified} modified.`);

  if (!args.factsPath) {
    out("");
    out("(No --facts given — showing the git index only. Pass --facts <json-array-of-facts> to attest claims.)");
    return 0;
  }
  if (!existsSync(args.factsPath)) {
    out(`--facts file not found: ${args.factsPath}`);
    return 1;
  }

  let facts: AnyFact[];
  try {
    const parsed = JSON.parse(readFileSync(args.factsPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("facts file must be a JSON array");
    facts = parsed as AnyFact[];
  } catch (e) {
    out(`could not read --facts: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const audited = auditFacts(facts, changes);
  out("");
  for (const a of audited) {
    const tag = a.result.status === "CONFIRMED" ? `CONFIRMED (commit ${a.result.evidence?.commitHash ?? "?"})` : a.result.status === "CONFLICT" ? `CONFLICT — ${a.result.conflictDetail ?? ""}` : "UNVERIFIED (→ Tier-2, gated)";
    out(`  [${a.fact.fact_type}] ${"id" in a.fact ? a.fact.id : ""}  ${tag}`);
  }
  const s = summarizeAudit(audited);
  out("");
  out(`Summary: ${s.confirmed} CONFIRMED, ${s.unverified} UNVERIFIED, ${s.conflict} CONFLICT.`);

  if (args.persist && s.conflict > 0) {
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_SERVICE_KEY"];
    if (!url || !key) {
      out("--persist skipped: SUPABASE_URL / SUPABASE_SERVICE_KEY not set.");
    } else if (!args.orgId || !args.sessionId) {
      out("--persist skipped: --org-id and --session-id are required (trusted FKs).");
    } else {
      const n = await persistConflicts(createClient(url, key), audited, { orgId: args.orgId, sessionId: args.sessionId });
      out(`Persisted ${n} CONFLICT(s) to audit_conflicts (suppressed).`);
    }
  }
  return s.conflict > 0 ? 1 : 0; // a CONFLICT (stale/false memory) is a non-zero exit
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("audit-repo.ts") || entryPath.endsWith("audit-repo.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`audit-repo failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
