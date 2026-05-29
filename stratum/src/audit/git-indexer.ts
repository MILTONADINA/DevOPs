/**
 * Git Indexer — commit history → structured {@link CodeChange}s (Phase 5 / v0.6.x).
 *
 * Feeds Tier-1 Git-Attestation (git-attestation.ts): turns real `git log -p` output
 * into the entity-level CodeChange[] that `attestFact` cross-references. FREE +
 * deterministic (no LLM). Per ADR-0013 the indexed changes live in the Supabase
 * graph; this module produces the CodeChanges (the graph-write is a later slice).
 *
 * The PARSERS are PURE (string → CodeChange[]) and unit-tested with fixture git
 * output. The only I/O is `defaultRunGit` (a `git` exec via execFile — array args,
 * NO shell, so no injection); it is INJECTED into `indexRepository`, so the
 * composition is testable with a fake runner and the real run is a thin wrapper.
 *
 * HEURISTIC + LIMITATIONS (honest): symbol detection is declaration-line-based
 * (function / const|let|var / class / def / func — methods are intentionally skipped
 * as too noisy). It does NOT infer renames at the symbol level (a rename surfaces as
 * delete-old + add-new, which attestFact treats as rename evidence). It is the
 * deterministic $0 FIRST pass; the gated Tier-2 (Llama) / Tier-3 (Opus) handle what
 * it can't. Built ahead of the v0.6.x gate as shadow code (the pruner precedent),
 * wired NOWHERE in the request path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeChange } from "./git-attestation";

const execFileAsync = promisify(execFile);

// Record/field separators for the `git log` format. NOTE: these control bytes are
// rare but NOT guaranteed absent from commit metadata or patch BODIES (`-p` appends
// the diff verbatim). So a record is accepted only if its header validates (hex hash +
// plausible timestamp), and a fragment that fails — a stray RS in a patch body, or a
// forged record injected via commit/file content — is RE-ATTACHED to the preceding
// commit's patch rather than parsed as its own commit (defends the deterministic Tier-1
// against record-forgery + symbol-loss; see commitHeaderFields / parseGitLogWithPatches).
const REC = "\x1e";
const UNIT = "\x1f";
/** Plausible git hash (short or full, sha-1/sha-256); rejects non-hex junk from patch bodies. */
const HASH_RE = /^[0-9a-f]{4,64}$/;
/** `git log` format string: <RS>hash<US>committer-unixtime<US>subject<US>. `-p` appends the patch. */
export const GIT_LOG_FORMAT = `${REC}%H${UNIT}%ct${UNIT}%s${UNIT}`;

// Declaration patterns → the declared symbol (group 1). Conservative + multi-language.
const DECL_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, // JS/TS function
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, // JS/TS binding
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // JS/TS/Python class
  /^def\s+([A-Za-z_][\w]*)\s*\(/, // Python def
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/, // Go func
];

/** The symbol declared on a code line, or undefined. (Leading +/- already stripped.) */
function declaredSymbol(codeLine: string): string | undefined {
  const trimmed = codeLine.replace(/^\s+/, "");
  for (const re of DECL_PATTERNS) {
    const m = trimmed.match(re);
    if (m && m[1] !== undefined) return m[1];
  }
  return undefined;
}

interface CommitMeta {
  hash: string;
  timestampSeconds: number;
  message: string;
}

/**
 * Extract entity-level code changes from one commit's unified-diff patch.
 *
 * Per symbol declared on changed lines: added on a `+` line AND removed on a `-`
 * line ⇒ `modified`; only added ⇒ `added`; only removed ⇒ `deleted`.
 *
 * @param patch - the commit's `git log -p` patch body.
 * @param meta - the commit hash / time / message.
 * @returns the code changes (one per touched symbol; empty if none detected).
 */
/** Strip a leading a/ or b/ diff-path prefix. */
function stripPathPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

export function extractChangesFromPatch(patch: string, meta: CommitMeta): CodeChange[] {
  // Keyed by (file, symbol) so the SAME symbol name in two files in one commit stays
  // distinct (else they'd collapse into one mis-typed, mis-attributed change).
  const seen = new Map<string, { entity: string; added: boolean; removed: boolean; filePath?: string }>();
  let currentFile: string | undefined;
  let preImage: string | undefined; // `--- a/<path>` — the deleted file's path when `+++ /dev/null`

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      preImage = p === "/dev/null" ? undefined : stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      currentFile = p === "/dev/null" ? preImage : stripPathPrefix(p); // full-file deletion → keep the pre-image path
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue; // ---/+++ headers
    const isAdd = line.startsWith("+");
    const isDel = line.startsWith("-");
    if (!isAdd && !isDel) continue;
    const sym = declaredSymbol(line.slice(1));
    if (sym === undefined) continue;
    const key = `${currentFile ?? ""}\x00${sym}`;
    const entry = seen.get(key) ?? { entity: sym, added: false, removed: false, ...(currentFile !== undefined ? { filePath: currentFile } : {}) };
    if (isAdd) entry.added = true;
    else entry.removed = true;
    seen.set(key, entry);
  }

  const out: CodeChange[] = [];
  for (const s of seen.values()) {
    const changeType: CodeChange["changeType"] = s.added && s.removed ? "modified" : s.added ? "added" : "deleted";
    out.push({
      entity: s.entity,
      changeType,
      commitHash: meta.hash,
      message: meta.message,
      timestampSeconds: meta.timestampSeconds,
      ...(s.filePath !== undefined ? { filePath: s.filePath } : {}),
    });
  }
  return out;
}

/**
 * Validate a REC-split fragment as a real commit header (hex hash + plausible time +
 * the format's field count). Rejects a stray RS in a patch body or a forged record
 * (e.g. a far-future timestamp). `maxTs` bounds implausibly-future (forged) timestamps.
 */
function commitHeaderFields(fragment: string, maxTs: number): { hash: string; ts: number; message: string; patch: string } | null {
  const parts = fragment.split(UNIT);
  if (parts.length < 4) return null; // the format is hash<US>ct<US>subject<US> then the patch
  const hash = (parts[0] ?? "").trim();
  const ts = Number.parseInt((parts[1] ?? "").trim(), 10);
  if (!HASH_RE.test(hash) || !Number.isFinite(ts) || ts <= 0 || ts > maxTs) return null;
  return { hash, ts, message: (parts[2] ?? "").trim(), patch: parts.slice(3).join(UNIT) };
}

/** Parse the commit metadata (hash / time / subject) of `git log` records, no patch. */
export function parseGitLog(raw: string): CommitMeta[] {
  const maxTs = Math.floor(Date.now() / 1000) + 86_400;
  const out: CommitMeta[] = [];
  for (const fragment of raw.split(REC)) {
    if (fragment === "") continue;
    const h = commitHeaderFields(fragment, maxTs);
    if (h) out.push({ hash: h.hash, timestampSeconds: h.ts, message: h.message });
  }
  return out;
}

/**
 * Parse `git log -p --format=GIT_LOG_FORMAT` output into code changes.
 *
 * Validates each record's header and RE-ATTACHES non-header fragments (a stray RS in a
 * patch body, or a forged record injected via commit/file content) to the preceding
 * commit's patch — so symbols after a body-RS are not lost and an injected fragment
 * cannot masquerade as its own commit (record-forgery defense). Time-bounded only by
 * the far-future timestamp guard; otherwise pure.
 *
 * @param raw - the raw `git log -p` output (with {@link GIT_LOG_FORMAT}).
 * @returns all code changes across the commits, newest-first (git log order).
 */
export function parseGitLogWithPatches(raw: string): CodeChange[] {
  const maxTs = Math.floor(Date.now() / 1000) + 86_400;
  const commits: { hash: string; ts: number; message: string; patch: string }[] = [];
  for (const fragment of raw.split(REC)) {
    if (fragment === "") continue;
    const h = commitHeaderFields(fragment, maxTs);
    if (h) {
      commits.push(h);
    } else if (commits.length > 0) {
      // Stray RS inside a patch body, or an injected/forged fragment: re-attach to the
      // previous commit's patch (don't lose its symbols; don't accept a forged record).
      commits[commits.length - 1]!.patch += REC + fragment;
    }
    // else: junk before the first real commit → ignore.
  }
  const changes: CodeChange[] = [];
  for (const c of commits) changes.push(...extractChangesFromPatch(c.patch, { hash: c.hash, timestampSeconds: c.ts, message: c.message }));
  return changes;
}

export interface IndexOptions {
  /** Repo working directory (default: process.cwd()). */
  cwd?: string;
  /** Limit to the most recent N commits (default 100, per the spec's incremental index). */
  maxCount?: number;
  /** Only commits after this ISO date (incremental index). */
  sinceIso?: string;
}

/** Runs `git` with the given args and returns stdout. The injectable I/O seam. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Default git runner — execFile (array args, no shell → no injection). */
export const defaultRunGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
};

/**
 * Index a repository's recent history into code changes.
 *
 * @param opts - cwd / maxCount / sinceIso.
 * @param runGit - the git runner (default: real `git` via execFile; inject a fake in tests).
 * @returns the code changes (deterministic; feeds attestFact).
 * @throws {Error} if the git invocation fails.
 */
export async function indexRepository(opts: IndexOptions = {}, runGit: GitRunner = defaultRunGit): Promise<CodeChange[]> {
  const cwd = opts.cwd ?? process.cwd();
  const args = ["log", "-p", "--no-color", `--format=${GIT_LOG_FORMAT}`, `--max-count=${opts.maxCount ?? 100}`];
  if (opts.sinceIso !== undefined) args.push(`--since=${opts.sinceIso}`);
  const raw = await runGit(args, cwd);
  return parseGitLogWithPatches(raw);
}
