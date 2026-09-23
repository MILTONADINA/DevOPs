/** Project/org-bound adapter for the universal /understand-codebase command. */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isAllowed } from "./session-start-context";
import { main as understand } from "./understand-codebase";

export interface BoundOptions {
  projectRoot: string;
  boundRoot: string;
  orgId: string;
  supabaseUrl: string;
  serviceKey: string;
  allowlistText: string;
}

/** Parse only the read options this command permits; organization comes from the binding. */
export function parseBoundArgs(argv: string[]): string[] {
  const parsed: string[] = [];
  let hasTarget = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const eq = token.indexOf("=");
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (flag !== "--entity" && flag !== "--query" && flag !== "--k") throw new Error(`unsupported option: ${flag}`);
    const value = eq < 0 ? argv[++i] : token.slice(eq + 1);
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (flag === "--k" && (!/^[1-9][0-9]*$/.test(value) || Number(value) > 20)) throw new Error("--k must be 1..20");
    if (flag !== "--k") hasTarget = true;
    parsed.push(flag, value);
  }
  if (!hasTarget) throw new Error("provide --entity or --query");
  return parsed;
}

export async function runBoundUnderstand(
  opts: BoundOptions,
  argv: string[],
  invoke: (args: string[]) => Promise<number> = understand,
): Promise<number> {
  if (!isAllowed({ ...opts, task: "" })) {
    process.stderr.write("understand-codebase: trusted project/org connection is unavailable.\n");
    return 2;
  }
  try {
    return await invoke(["--org-id", opts.orgId, ...parseBoundArgs(argv)]);
  } catch (error) {
    process.stderr.write(`understand-codebase: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const workdir = realpathSync(process.cwd());
  const projectRoot = realpathSync(join(workdir, ".."));
  if (workdir !== join(projectRoot, "stratum")) return 2;
  let boundRoot = "";
  try { boundRoot = realpathSync(process.env["DEVOPS_STRATUM_PROJECT_ROOT"] ?? ""); } catch { /* invalid binding */ }
  let allowlistText = "";
  try {
    const path = realpathSync(join(projectRoot, ".workflow/network-allowlist.txt"));
    if (path.startsWith(`${projectRoot}/`)) allowlistText = readFileSync(path, "utf8");
  } catch { /* invalid binding */ }
  return runBoundUnderstand({
    projectRoot, boundRoot, allowlistText,
    orgId: process.env["DEVOPS_STRATUM_ORG_ID"] ?? "",
    supabaseUrl: process.env["SUPABASE_URL"] ?? "",
    serviceKey: process.env["SUPABASE_SERVICE_KEY"] ?? "",
  }, argv);
}

if ((process.argv[1] ?? "").endsWith("understand-codebase-bound.ts")) {
  void main().then((code) => { process.exitCode = code; });
}
