import type { BiEncoder } from "../pruner/encoder";
import { createContextManager, type ContextManager } from "../pruner/context-manager";
import { suppressSuperseded } from "../pruner/supersession";
import { validProjectScope } from "./auth";

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
  supersededSelectedCount: number;
}

export interface ShadowSupersessionDeps {
  resolveEntities: (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[]) => Promise<Map<string, string>>;
  findFunctionSuperseded: (orgId: string, projectScope: string | null, names: string[]) => Promise<{ superseded: string; supersededBy: string }[]>;
}

/** In-memory, bounded observer. Each trusted conversation has its own history. */
export function createShadowObserver(
  encoder: BiEncoder,
  emit: (metric: ShadowMetric) => void,
  options: { now?: () => number; maxConversations?: number; maxTurns?: number; supersession?: ShadowSupersessionDeps } = {},
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
        const { decision, selectedTurns } = await current.manager.select(query, now(), scopeId);
        let supersededSelectedCount = 0;
        if (options.supersession) {
          const projectScope = input.projectScopeId === undefined ? null : input.projectScopeId.startsWith(`${input.orgId}/`) ? input.projectScopeId.slice(input.orgId.length + 1) : "";
          if (projectScope !== null && !validProjectScope(projectScope)) throw new Error("invalid shadow project binding");
          const exchangeIds = [...new Set(selectedTurns.map((turn) => turn.exchangeId).filter((id): id is string => id !== undefined))];
          if (exchangeIds.length > 0) {
            const entities = await options.supersession.resolveEntities(input.orgId, input.conversationId, projectScope, exchangeIds);
            const selected = selectedTurns.map((turn, index) => {
              const entity = turn.exchangeId ? entities.get(turn.exchangeId) : undefined;
              return entity === undefined ? { index } : { index, entity };
            });
            const names = [...new Set(selected.map((turn) => turn.entity).filter((name): name is string => name !== undefined))];
            if (names.length > 0) {
              const pairs = await options.supersession.findFunctionSuperseded(input.orgId, projectScope, names);
              supersededSelectedCount = selected.length - suppressSuperseded(selected, pairs).length;
            }
          }
        }
        emit({
          conversationId: input.conversationId,
          orgId: input.orgId,
          keyId: input.keyId,
          ...(input.projectScopeId ? { projectScopeId: input.projectScopeId } : {}),
          candidateCount: (decision.candidateIndices ?? []).length,
          selectedCount: decision.selectedIndices.length,
          prunedCount: decision.prunedIndices.length,
          supersededSelectedCount,
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
