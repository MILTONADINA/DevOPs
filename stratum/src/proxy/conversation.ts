import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversationRequest {
  orgId: string;
  keyId: string;
  projectScopeId?: string;
  model: string;
  requestedId?: string;
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only an authenticated key can create or continue its own conversation. */
export function createSupabaseConversationResolver(client: SupabaseClient): (request: ConversationRequest) => Promise<string> {
  return async ({ orgId, keyId, projectScopeId, model, requestedId }) => {
    const scope = projectScopeId === undefined ? null : projectScopeId.slice(orgId.length + 1);
    if (projectScopeId !== undefined && (!projectScopeId.startsWith(`${orgId}/`) || !scope)) {
      throw new ConversationError("invalid authenticated project scope", 503);
    }
    if (requestedId !== undefined) {
      if (!UUID.test(requestedId)) throw new ConversationError("invalid conversation ID", 400);
      let query = client.from("sessions").select("id").eq("id", requestedId).eq("org_id", orgId).eq("conversation_key_id", keyId).eq("kind", "conversation").is("ended_at", null);
      query = scope === null ? query.is("project_scope", null) : query.eq("project_scope", scope);
      const { data, error } = await query.limit(1);
      if (error) throw new ConversationError("conversation lookup unavailable", 503);
      if (!data?.length) throw new ConversationError("conversation not found", 404);
      return requestedId;
    }
    const id = randomUUID();
    const { error } = await client.from("sessions").insert({ id, org_id: orgId, conversation_key_id: keyId, project_scope: scope, kind: "conversation", model });
    if (error) throw new ConversationError("conversation creation unavailable", 503);
    return id;
  };
}
