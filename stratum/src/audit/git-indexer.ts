/**
 * Git Indexer — commit history → structured {@link CodeChange}s (Phase 5 / v0.6.x).
 *
 * Feeds Tier-1 Git-Attestation (git-attestation.ts): turns real `git log -z -p` output
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

// `git log -z` NUL-delimits records: it terminates each commit's FORMAT output (the
// header line) with a NUL, then `-p` appends "\n" + the patch. A NUL byte cannot occur
// in a commit message or a text patch body, so it is a STRUCTURAL record boundary —
// unlike the prior \x1e/\x1f heuristic, no crafted commit message or file content can
// forge a record (PB-45). The header is a single line "<hash> <committer-unixtime>
// <subject>"; the subject (single-line) is just the remainder, so there is no field
// separator a subject could spoof to bleed into the patch either.
/** Plausible git hash (short or full, sha-1/sha-256); rejects non-hex junk. */
const HASH_RE = /^[0-9a-f]{4,64}$/;
/** `git log` format: "<hash> <committer-unixtime> <subject>"; `-z` NUL-terminates it, `-p` appends the patch. */
export const GIT_LOG_FORMAT = "%H %ct %s";

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
 * Parse a single header line "<hash> <committer-unixtime> <subject>" (the `git log -z`
 * format output). Validates the hash (hex) + timestamp (positive integer, not
 * implausibly future — `maxTs` rejects forged committer dates). Returns null on any
 * failure so a suspicious line is never fabricated into a commit.
 */
function parseHeaderLine(line: string, maxTs: number): CommitMeta | null {
  const s = line.replace(/\r$/, ""); // tolerate a stray CR
  const sp1 = s.indexOf(" ");
  if (sp1 < 0) return null;
  const sp2 = s.indexOf(" ", sp1 + 1);
  const hash = s.slice(0, sp1);
  const ctStr = sp2 < 0 ? s.slice(sp1 + 1) : s.slice(sp1 + 1, sp2);
  const message = sp2 < 0 ? "" : s.slice(sp2 + 1);
  if (!HASH_RE.test(hash) || !/^\d+$/.test(ctStr)) return null; // strict: ct all-digits (parseInt is lenient)
  const ts = Number.parseInt(ctStr, 10);
  if (!Number.isFinite(ts) || ts <= 0 || ts > maxTs) return null;
  return { hash, timestampSeconds: ts, message };
}

/** Split a string into (everything before the last newline, the last line). */
function lastLineAndRest(s: string): { rest: string; last: string } {
  const nl = s.lastIndexOf("\n");
  return nl < 0 ? { rest: "", last: s } : { rest: s.slice(0, nl), last: s.slice(nl + 1) };
}

interface RawCommit extends CommitMeta {
  patch: string;
}

/**
 * Split `git log -z -p --format=GIT_LOG_FORMAT` output into raw commits (header + patch).
 *
 * `-z` NUL-terminates each commit's header; `-p` then appends "\n" + the patch. So for N
 * commits the output is `H1\0\nP1H2\0\nP2…H_N\0\nP_N`, and splitting on NUL yields
 * `[H1, "\n"+P1+H2, "\n"+P2+H3, …, "\n"+P_N]`: commit i's header is piece[0] (i=1) or the
 * TRAILING line of the previous piece, and its patch is the rest of piece[i]. Because a
 * NUL cannot appear in a message or a text patch, crafted content can never introduce a
 * record boundary — the structural record-forgery defense (PB-45) that replaces the
 * prior \x1e-heuristic + re-attach. A header that fails validation (e.g. a forged
 * far-future committer date) is NOT made into a commit; its bytes fold into the previous
 * commit's patch (fail-safe — never fabricate a record).
 */
function splitRecords(raw: string, maxTs: number): RawCommit[] {
  const pieces = raw.split("\0");
  while (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop(); // tolerate a trailing NUL
  if (pieces.length === 0) return [];
  if (pieces.length === 1) {
    const only = parseHeaderLine(pieces[0]!, maxTs);
    return only ? [{ ...only, patch: "" }] : []; // a lone header, no patch (no -p / single record)
  }
  const out: RawCommit[] = [];
  const N = pieces.length - 1; // N commits → N+1 pieces
  let header = pieces[0]!; // H1
  let pending = ""; // orphan bytes from a LEADING record whose header failed to parse (out empty) — must
  // not be dropped (the newest commit is first; dropping it loses its diff → a missed CONFLICT). Fold
  // forward onto the next successfully-parsed commit's patch (the symmetric counterpart of the
  // re-attach-to-previous fail-safe used once a previous record exists).
  for (let i = 1; i <= N; i++) {
    const piece = pieces[i]!;
    let patch = piece; // last piece (i === N) is all patch
    let nextHeader: string | undefined;
    if (i < N) {
      const split = lastLineAndRest(piece);
      patch = split.rest;
      nextHeader = split.last;
    }
    const h = parseHeaderLine(header, maxTs);
    if (h) {
      out.push({ ...h, patch: pending === "" ? patch : `${pending}\n${patch}` });
      pending = "";
    } else if (out.length > 0) {
      out[out.length - 1]!.patch += `\n${header}\n${patch}`; // fail-safe re-attach to the previous record
    } else {
      pending += `${pending === "" ? "" : "\n"}${header}\n${patch}`; // leading-header fail: carry forward, never drop
    }
    if (nextHeader !== undefined) header = nextHeader;
  }
  return out;
}

/** Parse the commit metadata (hash / time / subject) of `git log -z` records, no patch. */
export function parseGitLog(raw: string): CommitMeta[] {
  const maxTs = Math.floor(Date.now() / 1000) + 86_400;
  return splitRecords(raw, maxTs).map((c) => ({ hash: c.hash, timestampSeconds: c.timestampSeconds, message: c.message }));
}

/**
 * Parse `git log -z -p --format=GIT_LOG_FORMAT` output into code changes.
 *
 * @param raw - the raw `git log -z -p` output (with {@link GIT_LOG_FORMAT}).
 * @returns all code changes across the commits, newest-first (git log order).
 */
export function parseGitLogWithPatches(raw: string): CodeChange[] {
  const maxTs = Math.floor(Date.now() / 1000) + 86_400;
  const changes: CodeChange[] = [];
  for (const c of splitRecords(raw, maxTs)) {
    changes.push(...extractChangesFromPatch(c.patch, { hash: c.hash, timestampSeconds: c.timestampSeconds, message: c.message }));
  }
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
  const args = ["log", "-z", "-p", "--no-color", `--format=${GIT_LOG_FORMAT}`, `--max-count=${opts.maxCount ?? 100}`];
  if (opts.sinceIso !== undefined) args.push(`--since=${opts.sinceIso}`);
  const raw = await runGit(args, cwd);
  return parseGitLogWithPatches(raw);
}
