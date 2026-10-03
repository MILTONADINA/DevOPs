import type { SupabaseClient } from "@supabase/supabase-js";

/** A copy boundary failed; callers must not fall back to another protected read. */
export class ErasureCoverageUnavailableError extends Error {
  constructor() {
    super("Session erasure coverage could not be invalidated");
    this.name = "ErasureCoverageUnavailableError";
  }
}

/** Mark uncertainty durably before reading content (session-erasure REQ-8). */
export async function markErasureCoverageUnknown(client: SupabaseClient, orgId: string, reason: "protected_read" | "backup_export", signal?: AbortSignal): Promise<void> {
  try {
    const request = client.rpc("mark_erasure_coverage_unknown", { p_org_id: orgId, p_reason: reason });
    const result = await (signal ? request.abortSignal(signal) : request);
    if (result?.data !== true || result.error !== null) throw new ErasureCoverageUnavailableError();
  } catch {
    // No error text/cause: database or transport details can contain protected data.
    throw new ErasureCoverageUnavailableError();
  }
}
