import type { BiEncoder } from "../pruner/encoder";
import { createContextManager, type ContextManager } from "../pruner/context-manager";

export interface ShadowInput {
  conversationId: string;
  orgId: string;
  keyId: string;
  projectScopeId?: string;
  exchangeId?: string;
  query: string;
  assistant: string;
}

export interface ShadowMetric {
  conversationId: string;
  orgId: string;
  keyId: string;
  projectScopeId?: string;
  candidateCount: number;
  selectedCount: number;
  prunedCount: number;
}

/** In-memory, bounded observer. Each trusted conversation has its own history. */
export function createShadowObserver(
  encoder: BiEncoder,
  emit: (metric: ShadowMetric) => void,
  options: { now?: () => number; maxConversations?: number; maxTurns?: number } = {},
): (input: ShadowInput) => Promise<void> {
  const now = options.now ?? Date.now;
  const maxConversations = Math.max(1, options.maxConversations ?? 100);
  const maxTurns = Math.max(2, options.maxTurns ?? 128);
  const idleMs = 7_200_000;
  const windows = new Map<string, { manager: ContextManager; lastUsed: number; chain: Promise<void>; binding: string }>();

  return async (input) => {
    const at = now();
    for (const [id, entry] of windows) if (at - entry.lastUsed > idleMs) windows.delete(id);
    const binding = JSON.stringify([input.orgId, input.keyId, input.projectScopeId ?? null]);
    let entry = windows.get(input.conversationId);
    if (entry && entry.binding !== binding) throw new Error("conversation binding changed");
    if (!entry) {
      while (windows.size >= maxConversations) windows.delete(windows.keys().next().value!);
      entry = { manager: createContextManager(encoder), lastUsed: at, chain: Promise.resolve(), binding };
      windows.set(input.conversationId, entry);
    }
    entry.lastUsed = at;
    // Serializing concurrent requests preserves this conversation's turn order.
    const current = entry;
    const work = current.chain
      .catch(() => undefined)
      .then(async () => {
        const scopeId = input.projectScopeId ?? `${input.orgId}/unbound`;
        const query = input.query.slice(0, 1200);
        const assistant = input.assistant.slice(0, 1200);
        const { decision } = await current.manager.select(query, now(), scopeId);
        emit({
          conversationId: input.conversationId,
          orgId: input.orgId,
          keyId: input.keyId,
          ...(input.projectScopeId ? { projectScopeId: input.projectScopeId } : {}),
        candidateCount: (decision.candidateIndices ?? []).length,
          selectedCount: decision.selectedIndices.length,
          prunedCount: decision.prunedIndices.length,
        });
        // Keep the current exchange and cap prior context without retaining unbounded raw turns.
        if (current.manager.hot.size() + 2 > maxTurns) current.manager = createContextManager(encoder);
        const timestampMs = now();
        await current.manager.ingest({ role: "user", content: query, timestampMs, scopeId, ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}) });
        await current.manager.ingest({ role: "assistant", content: assistant, timestampMs, scopeId, ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}) });
      });
    current.chain = work;
    await work;
  };
}
