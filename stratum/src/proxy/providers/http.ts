/**
 * Small HTTP helpers shared by the provider adapters (ADR-0019).
 */

import axios from "axios";

/** Lower-case all string response headers (so retry/backoff can read Retry-After + pass headers through). */
export function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

/** True for an axios cancel / AbortController abort — so an idle-timeout abort isn't mistaken for a real error. */
export function isAbort(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return axios.isCancel(e) || name === "AbortError" || name === "CanceledError";
}
