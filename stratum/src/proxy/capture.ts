/**
 * Phase 1 capture store.
 *
 * Records every proxied turn to an in-memory session and flushes it to a
 * timestamped JSON artifact on disk. PII is redacted (FAIL-CLOSED) before a
 * turn is recorded — the redaction logic is the single source of truth in
 * observability/pii-redaction.ts (consumed via the @devops/* alias; NOT
 * duplicated, per spec §3 P0-F).
 *
 * This promotes the proven scripts/capture-session.ts logic into a reusable,
 * dependency-injected module so the Fastify proxy can capture turns and so the
 * behavior is unit-testable without real fs/network.
 */

import { writeFileSync as nodeWriteFileSync } from "node:fs";
import { redactValue } from "@devops/observability/pii-redaction";

/** One captured proxied turn (redacted request + response + token accounting). */
export interface CapturedTurn {
  turn: number;
  timestamp: number;
  request: {
    model: string;
    messages: unknown;
    system?: unknown;
    tools?: unknown;
    max_tokens: number;
  };
  token_counts: {
    input_tokens: number;
    /** "exact" (SDK countTokens) or "estimated" (fallback) — NEVER silently estimated. */
    token_count_method: "exact" | "estimated";
    message_breakdown: { role: string; token_count: number }[];
  };
  response: {
    id?: string;
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  elapsed_ms: number;
}

/** The accumulating session artifact written to disk. */
export interface CaptureSession {
  session_id: string;
  started_at: string;
  ended_at?: string;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  /** Turns intercepted but DROPPED by the FAIL-CLOSED redaction guard. */
  dropped_turns: number;
  requests: CapturedTurn[];
}

/** Minimal fs surface the store needs — injectable so tests avoid real disk. */
export interface CaptureFs {
  writeFileSync(path: string, data: string): void;
}

export interface CaptureStoreOptions {
  sessionId: string;
  outputFile: string;
  /** Defaults to node:fs; tests inject a fake. */
  fs?: CaptureFs;
  /** Defaults to the @devops redactor; tests may inject to force a throw. */
  redact?: (v: unknown) => unknown;
  /** Defaults to console.error; injectable for assertions. */
  onError?: (msg: string) => void;
  /** Defaults to new Date().toISOString(); injectable for determinism. */
  now?: () => string;
}

export interface RecordTurnInput {
  request: CapturedTurn["request"];
  /** The raw (un-redacted) upstream Anthropic response object. */
  response: unknown;
  inputTokens: number;
  tokenCountMethod: "exact" | "estimated";
  messageBreakdown: { role: string; token_count: number }[];
  elapsedMs: number;
}

export interface CaptureStore {
  /**
   * Redact + record a turn, then flush the session to disk.
   * @returns true if recorded, false if the turn was DROPPED (FAIL-CLOSED) —
   *          either way NO unredacted content reaches disk.
   */
  record(input: RecordTurnInput): boolean;
  /** Mark the session ended and flush. */
  end(): void;
  /** Current in-memory session (already redacted). */
  getSession(): CaptureSession;
}

interface MinimalResponseShape {
  id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

/**
 * Create a capture store.
 *
 * @param opts - session id, output path, and injectable fs/redactor/clock.
 * @returns A {@link CaptureStore}.
 */
export function createCaptureStore(opts: CaptureStoreOptions): CaptureStore {
  const fsImpl: CaptureFs = opts.fs ?? { writeFileSync: nodeWriteFileSync };
  const redact = opts.redact ?? redactValue;
  const onError = opts.onError ?? ((m: string) => console.error(m));
  const now = opts.now ?? (() => new Date().toISOString());

  const session: CaptureSession = {
    session_id: opts.sessionId,
    started_at: now(),
    total_turns: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    dropped_turns: 0,
    requests: [],
  };

  function flush(): void {
    fsImpl.writeFileSync(opts.outputFile, JSON.stringify(session, null, 2));
  }

  function record(input: RecordTurnInput): boolean {
    session.total_turns++;
    const turnNumber = session.total_turns;

    // FAIL-CLOSED (AC-S15-2a-2.2): redact request + response BEFORE building the
    // artifact. If the redactor throws, drop the turn — never write unredacted
    // content to disk — and continue accepting subsequent turns.
    let redactedRequest: CapturedTurn["request"];
    let redactedResponse: unknown;
    try {
      redactedRequest = {
        model: input.request.model,
        messages: redact(input.request.messages),
        ...(input.request.system !== undefined
          ? { system: redact(input.request.system) }
          : {}),
        ...(input.request.tools !== undefined
          ? { tools: redact(input.request.tools) }
          : {}),
        max_tokens: input.request.max_tokens,
      };
      redactedResponse = redact(input.response);
    } catch (redactionError) {
      session.dropped_turns++;
      const err = redactionError as Error;
      onError(
        `[PII-redaction FAIL-CLOSED] Turn ${turnNumber} dropped: ${err.name}: ${err.message}. ` +
          `Per AC-S15-2a-2.2: unredacted content MUST NOT reach disk. Continuing with subsequent turns.`,
      );
      // Do NOT push, do NOT increment token totals, do NOT write this turn.
      return false;
    }

    const resp = (redactedResponse ?? {}) as MinimalResponseShape;
    const captured: CapturedTurn = {
      turn: turnNumber,
      timestamp: Date.parse(now()) || 0,
      request: redactedRequest,
      token_counts: {
        input_tokens: input.inputTokens,
        token_count_method: input.tokenCountMethod,
        message_breakdown: input.messageBreakdown,
      },
      response: {
        ...(resp.id !== undefined ? { id: resp.id } : {}),
        ...(resp.usage !== undefined ? { usage: resp.usage } : {}),
        ...(resp.stop_reason !== undefined ? { stop_reason: resp.stop_reason } : {}),
      },
      elapsed_ms: input.elapsedMs,
    };

    session.requests.push(captured);
    if (resp.usage) {
      session.total_input_tokens += resp.usage.input_tokens;
      session.total_output_tokens += resp.usage.output_tokens;
    }
    flush();
    return true;
  }

  function end(): void {
    session.ended_at = now();
    flush();
  }

  return { record, end, getSession: () => session };
}
