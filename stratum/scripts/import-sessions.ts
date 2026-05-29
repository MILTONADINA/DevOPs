/**
 * §2b corpus bootstrap — import existing Claude Code transcripts (Phase 0/1).
 *
 * Converts Claude Code's session transcripts (~/.claude/projects/<proj>/*.jsonl)
 * into Stratum capture artifacts (data/sessions/imported-<id>.json), so the §2b
 * waste-taxonomy analysis can run on a REAL corpus immediately instead of
 * waiting for fresh proxied sessions. Reuses the proven FAIL-CLOSED redaction +
 * flush path (src/proxy/capture.ts) — no unredacted content reaches disk.
 *
 * FIDELITY: Claude Code transcripts record each API call's RESPONSE as an
 * `assistant` record carrying the real `message.usage` (input/output +
 * cache_read/cache_creation) and `message.model` — so token counts are EXACT
 * (API-reported), not estimated. The "request" we reconstruct per turn is the
 * immediately-preceding user input (the new content that turn); the true
 * processed context size is preserved in token_counts.input_tokens (= reported
 * input + cache_read + cache_creation — the context-tax signal). max_tokens and
 * exact system/tools separation are NOT recorded in the transcript (set 0 /
 * omitted, documented). This is a bootstrap source for waste-pattern discovery,
 * NOT a substitute for live proxy measurement (which also captures max_tokens +
 * precise request envelopes + latency).
 *
 * Usage:
 *   npm run import-sessions -- <file-or-dir> [<file-or-dir> ...]
 *   npm run import-sessions                       # defaults to ~/.claude/projects
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import { createCaptureStore, type RecordTurnInput } from "../src/proxy/capture";

/** A minimal view of a Claude Code transcript record (only the fields we read). */
interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    model?: string;
    id?: string;
    stop_reason?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface ConvertedTranscript {
  sessionId: string;
  turns: RecordTurnInput[];
  /** assistant records seen (= turns). */
  assistantRecords: number;
  /** records that failed to parse (tolerated + skipped). */
  skippedLines: number;
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Convert raw transcript JSONL lines into capture turns (pure — no fs).
 *
 * Each `assistant` record becomes one turn; the request.messages is the most
 * recent preceding user content. Malformed lines are skipped.
 *
 * @param lines - raw JSONL lines.
 * @returns the session id + the ordered turns + counters.
 */
export function convertTranscript(lines: string[]): ConvertedTranscript {
  const turns: RecordTurnInput[] = [];
  let sessionId = "";
  let lastUserContent: unknown = "";
  let lastUserTimeMs = 0;
  let assistantRecords = 0;
  let skippedLines = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      skippedLines++;
      continue;
    }
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    const tMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN;

    if (rec.type === "user" && rec.message) {
      lastUserContent = rec.message.content ?? "";
      if (Number.isFinite(tMs)) lastUserTimeMs = tMs;
      continue;
    }

    if (rec.type === "assistant" && rec.message) {
      assistantRecords++;
      const m = rec.message;
      const usage = m.usage ?? {};
      const reportedInput = num(usage.input_tokens);
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheCreate = num(usage.cache_creation_input_tokens);
      const trueInput = reportedInput + cacheRead + cacheCreate;
      const outputTokens = num(usage.output_tokens);
      const elapsedMs = Number.isFinite(tMs) && lastUserTimeMs > 0 ? Math.max(0, tMs - lastUserTimeMs) : 0;

      turns.push({
        request: {
          model: m.model ?? "unknown",
          messages: lastUserContent,
          // system/tools are not separable in the transcript; max_tokens not recorded.
          max_tokens: 0,
        },
        response: {
          ...(m.id !== undefined ? { id: m.id } : {}),
          usage: { input_tokens: reportedInput, output_tokens: outputTokens },
          ...(m.stop_reason !== undefined ? { stop_reason: m.stop_reason } : {}),
        },
        // True processed context size (the context-tax signal): reported + cached.
        inputTokens: trueInput,
        tokenCountMethod: "exact",
        messageBreakdown: [{ role: "user", token_count: trueInput }],
        elapsedMs,
      });
    }
  }

  return { sessionId, turns, assistantRecords, skippedLines };
}

/** Write one transcript file → one capture artifact. Returns a summary. */
function importFile(file: string, outDir: string): { sessionId: string; recorded: number; dropped: number; outFile: string } {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const { sessionId: parsedId, turns } = convertTranscript(lines);
  const sessionId = parsedId || basename(file).replace(/\.jsonl$/i, "");
  const outFile = join(outDir, `imported-${sessionId}.json`);

  // capture.ts flushes the whole (growing) session on every record() — fine for
  // the live proxy (one turn at a time), but O(n²) disk I/O for a bulk import.
  // Buffer the flushes (keep only the latest full-session JSON) and write once.
  let buffered = "";
  const store = createCaptureStore({
    sessionId,
    outputFile: outFile,
    fs: { writeFileSync: (_p, d) => { buffered = d; } },
  });
  let recorded = 0;
  for (const t of turns) if (store.record(t)) recorded++;
  store.end();
  writeFileSync(outFile, buffered);
  const dropped = store.getSession().dropped_turns;
  return { sessionId, recorded, dropped, outFile };
}

/** Expand args (files or dirs) into a flat list of .jsonl files. */
function collectJsonl(targets: string[]): string[] {
  const files: string[] = [];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    if (statSync(t).isDirectory()) {
      for (const name of readdirSync(t)) if (name.toLowerCase().endsWith(".jsonl")) files.push(join(t, name));
    } else if (t.toLowerCase().endsWith(".jsonl")) {
      files.push(t);
    }
  }
  return files;
}

/**
 * CLI entry: import transcript(s) → capture artifacts.
 *
 * @param argv - file/dir targets (defaults to ~/.claude/projects).
 * @returns process exit code.
 */
export function main(argv: string[] = []): number {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const targets = argv.length > 0 ? argv : [join(homedir(), ".claude", "projects")];
  const files = collectJsonl(targets);

  if (files.length === 0) {
    out(`No .jsonl transcripts found in: ${targets.join(", ")}`);
    out("Pass a transcript file or a directory: npm run import-sessions -- <path>");
    return 0;
  }

  const outDir = join(process.cwd(), "data", "sessions");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  out(`Importing ${files.length} transcript(s) → ${outDir}`);
  let totalTurns = 0;
  let totalDropped = 0;
  for (const f of files) {
    try {
      const r = importFile(f, outDir);
      totalTurns += r.recorded;
      totalDropped += r.dropped;
      out(`  ${basename(f)} → ${r.recorded} turns${r.dropped ? `, ${r.dropped} dropped (FAIL-CLOSED redaction)` : ""}  [${r.sessionId}]`);
    } catch (err) {
      out(`  ${basename(f)} → ERROR: ${(err as Error).message}`);
    }
  }
  out(`Done: ${totalTurns} turns across ${files.length} session(s)${totalDropped ? `, ${totalDropped} dropped` : ""}.`);
  out(`View with the dashboard (npm run dev → /dashboard) or analyze for docs/waste-taxonomy.md.`);
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("import-sessions.ts") || entryPath.endsWith("import-sessions.js")) {
  process.exitCode = main(process.argv.slice(2));
}
