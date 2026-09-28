/** Local, explicit review of one TechDecision replacement. No model may mint a link. */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../src/proxy/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Args = { orgId: string; projectScope: string | null; newerId: string; olderId: string; reviewer?: string; apply: boolean };
type Decision = { id: string; decision_text: string; domain: string; created_at: string; is_suppressed: boolean; supersedes_id: string | null; supersession_reviewed_at?: string | null };

export function parseReviewArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let unbound = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--apply" || flag === "--unbound") {
      if (flag === "--apply") {
        if (apply) throw new Error("duplicate --apply");
        apply = true;
      } else {
        if (unbound) throw new Error("duplicate --unbound");
        unbound = true;
      }
      continue;
    }
    if (!["--org-id", "--project-scope", "--newer-id", "--older-id", "--reviewer"].includes(flag) || values.has(flag)) throw new Error(`invalid or duplicate argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const orgId = values.get("--org-id") ?? "";
  const newerId = values.get("--newer-id") ?? "";
  const olderId = values.get("--older-id") ?? "";
  const project = values.get("--project-scope");
  const reviewer = values.get("--reviewer");
  if (![orgId, newerId, olderId].every((value) => UUID.test(value)) || newerId === olderId) throw new Error("distinct organization and decision UUIDs required");
  if (unbound === (project !== undefined) || (project !== undefined && !validProjectScope(project))) throw new Error("specify exactly one valid --project-scope or --unbound");
  if (apply && (!reviewer || reviewer.trim().length < 3 || reviewer.length > 100)) throw new Error("--apply requires a reviewer of 3 to 100 characters");
  return {
    orgId: orgId.toLowerCase(),
    projectScope: unbound ? null : project!,
    newerId: newerId.toLowerCase(),
    olderId: olderId.toLowerCase(),
    ...(reviewer ? { reviewer: reviewer.trim() } : {}),
    apply,
  };
}

export function validLocalApiOrigin(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value);
  const port = Number(match?.[1]);
  return !!match && port > 0 && port <= 65535;
}

/** Read-only pair check. The database RPC repeats its invariants at write time. */
export async function inspectDecisionPair(client: SupabaseClient, args: Args): Promise<{ newer: Decision; older: Decision }> {
  let pairQuery = client.from("tech_decisions").select("id,decision_text,domain,created_at,is_suppressed,supersedes_id").eq("org_id", args.orgId).in("id", [args.newerId, args.olderId]);
  pairQuery = args.projectScope === null ? pairQuery.is("project_scope", null) : pairQuery.eq("project_scope", args.projectScope);
  const result = await pairQuery;
  if (result.error) throw new Error("decision pair lookup failed");
  const rows = (result.data ?? []) as Decision[];
  const newer = rows.find((row) => row.id === args.newerId);
  const older = rows.find((row) => row.id === args.olderId);
  if (!newer || !older || newer.is_suppressed || older.is_suppressed || newer.supersedes_id) throw new Error("both active, unlinked decisions must exist in the exact binding");
  const newerAt = Date.parse(newer.created_at);
  const olderAt = Date.parse(older.created_at);
  if (!Number.isFinite(newerAt) || !Number.isFinite(olderAt) || newerAt <= olderAt) throw new Error("replacement must be later than the old decision");
  let successorQuery = client.from("tech_decisions").select("id").eq("org_id", args.orgId).eq("supersedes_id", args.olderId).limit(1);
  successorQuery = args.projectScope === null ? successorQuery.is("project_scope", null) : successorQuery.eq("project_scope", args.projectScope);
  const existing = await successorQuery;
  if (existing.error) throw new Error("successor lookup failed");
  if ((existing.data ?? []).length) throw new Error("older decision already has a reviewed successor");
  return { newer, older };
}

export async function reviewDecisionPair(client: SupabaseClient, args: Args, evidence: string): Promise<string> {
  const result = await client.rpc("review_tech_decision_supersession", {
    match_org: args.orgId,
    match_project_scope: args.projectScope,
    newer_id: args.newerId,
    older_id: args.olderId,
    reviewer: args.reviewer,
    evidence,
  });
  if (result.error || result.data !== args.newerId) throw new Error("reviewed supersession write rejected");
  let verifyQuery = client.from("tech_decisions").select("id,supersedes_id,supersession_reviewed_at").eq("org_id", args.orgId).eq("id", args.newerId);
  verifyQuery = args.projectScope === null ? verifyQuery.is("project_scope", null) : verifyQuery.eq("project_scope", args.projectScope);
  const check = await verifyQuery;
  const row = (check.data ?? [])[0] as Decision | undefined;
  if (check.error || row?.supersedes_id !== args.olderId || !row.supersession_reviewed_at) throw new Error("review write completed but verification failed; inspect before retrying");
  return row.supersession_reviewed_at;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: { makeClient?: (url: string, key: string) => SupabaseClient; readEvidence?: () => string; out?: (text: string) => void } = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const args = parseReviewArgs(argv);
    const url = env["SUPABASE_URL"] ?? "";
    const key = env["SUPABASE_SERVICE_KEY"] ?? "";
    if (!validLocalApiOrigin(url) || !key) throw new Error("project-local loopback SUPABASE_URL and service key required");
    let evidence = "";
    if (args.apply) {
      if (!deps.readEvidence && process.stdin.isTTY) throw new Error("pipe review evidence on standard input");
      evidence = (deps.readEvidence ?? (() => readFileSync(0, "utf8")))().trim();
      if (evidence.length < 20 || evidence.length > 1000) throw new Error("review evidence must be 20 to 1000 characters");
    }
    const client = (deps.makeClient ?? createClient)(url, key);
    const pair = await inspectDecisionPair(client, args);
    out(
      JSON.stringify({
        older: { id: pair.older.id, created_at: pair.older.created_at, domain: pair.older.domain.slice(0, 100), decision_text: pair.older.decision_text.slice(0, 300) },
        newer: { id: pair.newer.id, created_at: pair.newer.created_at, domain: pair.newer.domain.slice(0, 100), decision_text: pair.newer.decision_text.slice(0, 300) },
      }),
    );
    if (!args.apply) {
      out("preview only; pass --apply with --reviewer and pipe evidence to record this link");
      return 0;
    }
    const reviewedAt = await reviewDecisionPair(client, args, evidence);
    out(JSON.stringify({ newerId: args.newerId, supersedesId: args.olderId, reviewedAt }));
    return 0;
  } catch (error) {
    process.stderr.write(`review-decision failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if ((process.argv[1] ?? "").endsWith("review-decision.ts")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
