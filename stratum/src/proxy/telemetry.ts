/**
 * Per-turn telemetry emission (§2d, Q7 soft-dependency).
 *
 * Emits a structured record of NON-PII proxy metrics for each turn. Per the
 * Q7 soft-dependency rule: telemetry is OPTIONAL — when no OTLP endpoint is
 * configured it falls back to a structured log line (the default sink), and it
 * NEVER crashes the proxy. A real OTel OTLP exporter can be slotted in as the
 * sink when @opentelemetry + OTEL_EXPORTER_OTLP_ENDPOINT are configured; the
 * attribute contract here is exactly what such an exporter would carry.
 *
 * HARD RULE: telemetry attributes NEVER include message/response CONTENT — only
 * counts, model name, timing, and ids. PII lives in the (redacted) capture
 * artifact, never in spans.
 */

import { logger } from "../lib/logger";

/** The non-PII attribute set carried for each proxied turn. */
export interface TurnTelemetry {
  "stratum.session_id": string;
  "stratum.turn_number": number;
  "stratum.model": string;
  "stratum.input_tokens": number;
  "stratum.output_tokens": number;
  "stratum.token_count_method": "exact" | "estimated";
  "stratum.elapsed_ms": number;
  "stratum.streaming": boolean;
  /** True when the turn was dropped FAIL-CLOSED (redactor error). */
  "stratum.dropped": boolean;
}

export type TelemetrySink = (attrs: TurnTelemetry) => void;

/**
 * Default sink: a structured log line (the Q7 stderr/log fallback). Swap for an
 * OTLP exporter when one is configured.
 */
export const defaultTelemetrySink: TelemetrySink = (attrs) => {
  // logger is configured to stderr-style structured output; content-free.
  logger.info(attrs, "stratum.turn");
};

/** Resolve the active sink (real OTLP later; structured log fallback for now). */
export function resolveTelemetrySink(): TelemetrySink {
  // When @opentelemetry + OTEL_EXPORTER_OTLP_ENDPOINT are wired, return an
  // OTLP-backed sink here. Until then the structured-log fallback is the
  // soft-dependency behavior (Q7): present, content-free, never crashes.
  return defaultTelemetrySink;
}

/**
 * Emit one turn's telemetry. Guaranteed not to throw — a sink failure is logged
 * and swallowed (telemetry must never break request handling).
 *
 * @param attrs - the non-PII attribute set.
 * @param sink - the sink (default {@link defaultTelemetrySink}).
 */
export function emitTurnTelemetry(attrs: TurnTelemetry, sink: TelemetrySink = defaultTelemetrySink): void {
  try {
    sink(attrs);
  } catch (e) {
    // Soft-dep: never let telemetry break the proxy.
    try {
      logger.warn({ err: (e as Error).message }, "telemetry sink failed (ignored)");
    } catch {
      /* last-resort: swallow */
    }
  }
}
