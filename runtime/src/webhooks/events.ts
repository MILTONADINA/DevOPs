/**
 * Webhook event types + envelope (Phase 2+ commercial) — per docs/WEBHOOKS.md.
 *
 * Every event is `{ event, id, created_at, org_id, data }`. The envelope is pure (id + timestamp
 * are injected, never generated here, so it stays deterministic + testable). SAMPLE_EVENT_DATA
 * backs the `/v1/webhooks/test` endpoint. Event SOURCES (the audit engine firing conflict.detected,
 * the session lifecycle firing session.ended, etc.) are wired with their subsystems at activation —
 * this is the signing + delivery + envelope layer, built ahead.
 */

export const WEBHOOK_EVENT_TYPES = ["conflict.detected", "fact.suppressed", "eval.completed", "session.ended"] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  event: WebhookEventType;
  id: string;
  created_at: string;
  org_id: string;
  data: Record<string, unknown>;
}

/** Type guard for an inbound event-type string (e.g. the test endpoint's body). */
export function isWebhookEventType(s: unknown): s is WebhookEventType {
  return typeof s === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(s);
}

/**
 * Assemble a webhook event envelope (pure).
 *
 * @param event - the event type.
 * @param orgId - the owning org.
 * @param data - the event-specific payload.
 * @param id - the event id (e.g. `evt_<uuid>`; injected for determinism).
 * @param createdAt - ISO timestamp (injected).
 * @returns the {@link WebhookEvent}.
 */
export function buildEvent(event: WebhookEventType, orgId: string, data: Record<string, unknown>, id: string, createdAt: string): WebhookEvent {
  return { event, id, created_at: createdAt, org_id: orgId, data };
}

/** Illustrative `data` payloads for the `/v1/webhooks/test` endpoint (docs/WEBHOOKS.md examples). */
export const SAMPLE_EVENT_DATA: Record<WebhookEventType, Record<string, unknown>> = {
  "conflict.detected": {
    conflict_id: "00000000-0000-0000-0000-0000000000c1",
    session_id: "00000000-0000-0000-0000-0000000000a1",
    fact_type: "FunctionChange",
    fact_id: "00000000-0000-0000-0000-0000000000f1",
    claimed_state: "fetchUser() introduced in commit a3f9b2d",
    actual_state: "fetchUser() deleted in commit c7d1e4f on 2026-03-02",
    conflict_commit: "c7d1e4f",
    suppressed: true,
  },
  "fact.suppressed": {
    fact_id: "00000000-0000-0000-0000-0000000000f1",
    fact_type: "TechDecision",
    suppression_reason: "manual",
    suppressed_by: "api",
  },
  "eval.completed": {
    config_change_id: "00000000-0000-0000-0000-0000000000e1",
    result: "passed",
    faithfulness_before: 0.924,
    faithfulness_after: 0.918,
    answer_relevancy_before: 0.911,
    answer_relevancy_after: 0.905,
    critical_failures: 0,
    config_applied: true,
  },
  "session.ended": {
    session_id: "00000000-0000-0000-0000-0000000000a1",
    developer_id: null,
    duration_seconds: 3642,
    total_turns: 47,
    total_original_tokens: 187400,
    total_quarantined_tokens: 21300,
    token_delta: 166100,
    estimated_savings_usd: 4.98,
    facts_extracted: 7,
    conflicts_detected: 1,
  },
};
