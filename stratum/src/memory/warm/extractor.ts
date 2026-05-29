/**
 * Fact Extractor — structured extraction from evicted Tier-1 turns (Phase 3).
 *
 * Evicted turns → an extraction model → typed structured facts (NEVER summaries,
 * per stratum CLAUDE.md). Outputs are Zod-validated (validateFact) before any DB
 * write; invalid outputs are DISCARDED, not retried (FAIL-CLOSED). Runs on a
 * cheap model (Llama / Haiku-class) since it fires per eviction.
 *
 * Built on an injectable {@link FactCompletion} seam (same pattern as the eval
 * judge): the prompt-building + array parsing + per-fact validate-or-discard +
 * system-field assignment are PURE and unit-tested with a fake completion (no
 * API). The real model + the Tier-2 Supabase write that consumes these facts are
 * gated separately (key / account).
 */

import { randomUUID } from "node:crypto";
import type { AnyFact, FactType } from "../../types/facts";
import { validateFact } from "./schemas";

/** Single-shot completion seam (the extraction model). Tests inject a fake. */
export interface FactCompletion {
  complete(prompt: string): Promise<string>;
}

/** The evicted turns to extract durable facts from. */
export interface ExtractInput {
  session_id: string;
  turns: { role: string; content: string }[];
  /** Optional commit the turns relate to (stored on each fact). */
  commit_hash?: string;
}

export interface ExtractorOptions {
  /** Clock for created_at (ISO). Default new Date().toISOString(). */
  now?: () => string;
  /** ID minter. Default randomUUID. */
  mintId?: () => string;
}

const FACT_TYPES: FactType[] = ["FunctionChange", "TechDecision", "PolicyUpdate", "Todo", "VariableChange"];

/**
 * Build the extraction prompt: durable STRUCTURED facts only, never prose
 * summaries; return a JSON array (possibly empty).
 *
 * ENUM COUPLING (keep in sync — there is no compile-time link): the enum values
 * embedded below (change_type / policy_type / status) MUST match BOTH the Zod
 * schemas in ./schemas.ts AND the DB CHECK constraints (supabase/migrations —
 * narrowed in 20260529160000). If you widen an enum, update all three together,
 * or a value will round-trip-fail (prompt can't emit it, or the DB/Zod drops it).
 */
export function extractionPrompt(input: ExtractInput): string {
  const transcript = input.turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  return (
    "Extract DURABLE structured facts from the conversation below. Output ONLY a " +
    "JSON array (no prose). NEVER summarize — emit typed records only. Allowed " +
    `fact_type values: ${FACT_TYPES.join(", ")}. Each object: {\"fact_type\":<one of those>, ` +
    'plus that type\'s fields, "confidence":0..1}. Type fields — FunctionChange: ' +
    "{old_name, new_name?, change_type:deprecated|renamed|signature_changed, file_path?, language?}; " +
    "TechDecision: {decision_text, domain, rationale?}; PolicyUpdate: {policy_name, old_value?, " +
    "new_value, policy_type:security|compliance|process}; Todo: {description, status:open|done|cancelled}; " +
    "VariableChange: {var_name, old_value?, new_value, context?}. If there are no durable facts, return [].\n\n" +
    `CONVERSATION:\n${transcript}`
  );
}

/** Extract the outermost balanced [...] array, respecting JSON strings. */
function extractJsonArray(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the model's JSON array into validated facts. System fields (id /
 * created_at / session_id / commit_hash / is_verified / is_suppressed) are
 * assigned here; the model supplies fact_type + content + confidence. Each
 * candidate is run through validateFact; anything that fails is DISCARDED.
 *
 * @param raw - the model's raw output.
 * @param ctx - session id + commit hash + system clock/id minters.
 * @returns the validated facts (possibly empty).
 */
export function parseExtractedFacts(
  raw: string,
  ctx: { session_id: string; commit_hash?: string; now: () => string; mintId: () => string },
): AnyFact[] {
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // SYSTEM-CONTROLLED fields the model must NEVER supply: identity, provenance,
  // verification flags, and relationship FKs. A spread of {...candidate, ...system}
  // only protects fields the system explicitly re-sets — so STRIP the whole set
  // from the untrusted candidate first, then assign trusted values. Otherwise a
  // malicious/compromised extraction model forges developer_id (authorship),
  // commit_hash (the Git-attestation anchor, only conditionally overridden
  // before), supersedes_id (marks a real decision superseded), or assigned_to
  // (Todo → developers(id) FK — assign a task to an arbitrary developer).
  // These are EVERY identity/provenance/verification/FK field across all 5 fact
  // types (id/created_at/session_id/commit_hash/developer_id are BaseFact;
  // supersedes_id is TechDecision; assigned_to is Todo — both developer/decision
  // FKs). Resolution of FKs is a trusted server-side step, never model output.
  const SYSTEM_FIELDS = ["id", "created_at", "session_id", "commit_hash", "developer_id", "supersedes_id", "assigned_to", "is_verified", "is_suppressed"];
  const out: AnyFact[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const content: Record<string, unknown> = { ...(candidate as Record<string, unknown>) };
    for (const k of SYSTEM_FIELDS) delete content[k];
    const merged = {
      ...content,
      id: ctx.mintId(),
      created_at: ctx.now(),
      session_id: ctx.session_id,
      // Always set commit_hash from trusted ctx (undefined if no commit) so a
      // model-supplied value can never leak through; developer_id/supersedes_id
      // stay stripped (resolved server-side later, never from model output).
      ...(ctx.commit_hash !== undefined ? { commit_hash: ctx.commit_hash } : {}),
      is_verified: false,
      is_suppressed: false,
    };
    const valid = validateFact(merged);
    if (valid) out.push(valid);
  }
  return out;
}

export interface FactExtractor {
  /** Extract validated facts from evicted turns (invalid discarded). */
  extract(input: ExtractInput): Promise<AnyFact[]>;
}

/**
 * Create a fact extractor over a completion seam.
 *
 * @param completion - the extraction model (real or fake).
 * @param opts - clock / id minter.
 * @returns a {@link FactExtractor}.
 */
export function createFactExtractor(completion: FactCompletion, opts: ExtractorOptions = {}): FactExtractor {
  const now = opts.now ?? (() => new Date().toISOString());
  const mintId = opts.mintId ?? (() => randomUUID());
  return {
    async extract(input: ExtractInput): Promise<AnyFact[]> {
      if (input.turns.length === 0) return [];
      const raw = await completion.complete(extractionPrompt(input));
      return parseExtractedFacts(raw, {
        session_id: input.session_id,
        ...(input.commit_hash !== undefined ? { commit_hash: input.commit_hash } : {}),
        now,
        mintId,
      });
    },
  };
}
