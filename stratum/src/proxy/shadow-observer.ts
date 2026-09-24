import type { BiEncoder } from "../pruner/encoder";
import { createContextManager, type ContextManager } from "../pruner/context-manager";
import { createHotMemory } from "../memory/hot/tier1";
import { suppressSuperseded } from "../pruner/supersession";
import { validProjectScope } from "./auth";

export interface ShadowInput {
  conversationId: string;
  orgId: string;
  keyId: string;
  projectScopeId?: string;
  exchangeId?: string;
  /** Internal memory-write completion; observation queues before awaiting it. */
  memoryReady?: Promise<boolean>;
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
  /** Candidate exchanges only; a fact does not prove that a whole turn is deletable. */
  candidateSupersededExchangeCount: number;
  /** Active typed-fact exchanges in the hot window; omitted when lookup is not configured. */
  factCoverage?: {
    activeExchangeCount: number;
    selectedExchangeCount: number;
    droppedExchangeCount: number;
    activeFactCount: number;
    selectedFactCount: number;
    droppedFactCount: number;
  };
  /** Proposed bounded lexical rescue; counts only and never changes forwarding. */
  queryFactRescue?: {
    matchedFactCount: number;
    rescuedExchangeCount: number;
    rescuedFactCount: number;
    addedTurnCount: number;
    candidateSelectedCount: number;
  };
  /** Hot exchanges with failed memory writes; fact coverage is omitted while positive. */
  provenanceIncompleteExchangeCount?: number;
}

export interface ShadowSupersessionDeps {
  resolveEntities: (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[]) => Promise<Map<string, string>>;
  findFunctionSuperseded: (orgId: string, projectScope: string | null, names: string[]) => Promise<{ superseded: string; supersededBy: string }[]>;
  findFreshSuperseded: (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[]) => Promise<{ superseded: string; supersededBy: string }[]>;
}

/** In-memory, bounded observer. Each trusted conversation has its own history. */
export function createShadowObserver(
  encoder: BiEncoder,
  emit: (metric: ShadowMetric) => void,
  options: {
    now?: () => number;
    maxConversations?: number;
    maxTurns?: number;
    supersession?: ShadowSupersessionDeps;
    factCoverage?: (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[]) => Promise<Map<string, number>>;
    queryFactCandidates?: (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[], query: string) => Promise<Map<string, number>>;
  } = {},
): (input: ShadowInput) => Promise<void> {
  const now = options.now ?? Date.now;
  const maxConversations = Math.max(1, options.maxConversations ?? 100);
  const maxTurns = Math.max(2, options.maxTurns ?? 128);
  const idleMs = 7_200_000;
  const windows = new Map<string, { manager: ContextManager; lastUsed: number; chain: Promise<void>; binding: string; failedExchanges: Set<string> }>();
  const newManager = (): ContextManager => createContextManager(encoder, { hot: createHotMemory({ now }) });

  return async (input) => {
    const at = now();
    for (const [id, entry] of windows) if (at - entry.lastUsed > idleMs) windows.delete(id);
    const binding = JSON.stringify([input.orgId, input.keyId, input.projectScopeId ?? null]);
    let entry = windows.get(input.conversationId);
    if (entry && entry.binding !== binding) throw new Error("conversation binding changed");
    if (!entry) {
      while (windows.size >= maxConversations) windows.delete(windows.keys().next().value!);
      entry = { manager: newManager(), lastUsed: at, chain: Promise.resolve(), binding, failedExchanges: new Set() };
      windows.set(input.conversationId, entry);
    }
    entry.lastUsed = at;
    // Serializing concurrent requests preserves this conversation's turn order.
    const current = entry;
    const work = current.chain
      .catch(() => undefined)
      .then(async () => {
        // Enqueue immediately, then wait inside the per-conversation chain so a
        // faster later write cannot reorder exchanges or make prior coverage stale.
        const memoryPersisted = input.memoryReady === undefined ? undefined : await input.memoryReady.catch(() => false);
        const scopeId = input.projectScopeId ?? `${input.orgId}/unbound`;
        const query = input.query.slice(0, 1200);
        const assistant = input.assistant.slice(0, 1200);
        const { decision, selectedTurns } = await current.manager.select(query, now(), scopeId);
        const liveIds = new Set(current.manager.hot.recent().flatMap((turn) => (turn.exchangeId ? [turn.exchangeId] : [])));
        for (const failed of current.failedExchanges) if (!liveIds.has(failed)) current.failedExchanges.delete(failed);
        const incompleteExchangeCount = current.failedExchanges.size;
        const projectScope = input.projectScopeId === undefined ? null : input.projectScopeId.startsWith(`${input.orgId}/`) ? input.projectScopeId.slice(input.orgId.length + 1) : "";
        if ((options.supersession || options.factCoverage || options.queryFactCandidates) && projectScope !== null && !validProjectScope(projectScope))
          throw new Error("invalid shadow project binding");
        let factCoverage: ShadowMetric["factCoverage"];
        if (options.factCoverage && incompleteExchangeCount === 0) {
          const exchangeIds = [...new Set(current.manager.hot.recent().flatMap((turn) => (turn.scopeId === scopeId && turn.exchangeId ? [turn.exchangeId] : [])))];
          const selectedIds = new Set(selectedTurns.flatMap((turn) => (turn.exchangeId ? [turn.exchangeId] : [])));
          const facts = exchangeIds.length ? await options.factCoverage(input.orgId, input.conversationId, projectScope, exchangeIds) : new Map<string, number>();
          const activeIds = exchangeIds.filter((id) => facts.has(id));
          const selectedExchangeCount = activeIds.filter((id) => selectedIds.has(id)).length;
          const activeFactCount = activeIds.reduce((sum, id) => sum + facts.get(id)!, 0);
          const selectedFactCount = activeIds.reduce((sum, id) => sum + (selectedIds.has(id) ? facts.get(id)! : 0), 0);
          factCoverage = {
            activeExchangeCount: activeIds.length,
            selectedExchangeCount,
            droppedExchangeCount: activeIds.length - selectedExchangeCount,
            activeFactCount,
            selectedFactCount,
            droppedFactCount: activeFactCount - selectedFactCount,
          };
        }
        let queryFactRescue: ShadowMetric["queryFactRescue"];
        if (options.queryFactCandidates && incompleteExchangeCount === 0) {
          const liveTurns = current.manager.hot.recent().filter((turn) => turn.scopeId === scopeId);
          const exchangeIds = [...new Set(liveTurns.flatMap((turn) => (turn.exchangeId ? [turn.exchangeId] : [])))];
          const selectedIds = new Set(selectedTurns.flatMap((turn) => (turn.exchangeId ? [turn.exchangeId] : [])));
          const matches = exchangeIds.length ? await options.queryFactCandidates(input.orgId, input.conversationId, projectScope, exchangeIds, query) : new Map<string, number>();
          const rescuedIds = new Set(exchangeIds.filter((id) => !selectedIds.has(id) && matches.has(id)));
          const addedTurnCount = liveTurns.filter((turn) => turn.exchangeId && rescuedIds.has(turn.exchangeId)).length;
          queryFactRescue = {
            matchedFactCount: exchangeIds.reduce((sum, id) => sum + (matches.get(id) ?? 0), 0),
            rescuedExchangeCount: rescuedIds.size,
            rescuedFactCount: [...rescuedIds].reduce((sum, id) => sum + matches.get(id)!, 0),
            addedTurnCount,
            candidateSelectedCount: decision.selectedIndices.length + addedTurnCount,
          };
        }
        let candidateSupersededExchangeCount = 0;
        if (options.supersession && incompleteExchangeCount === 0) {
          const exchangeIds = [...new Set(selectedTurns.map((turn) => turn.exchangeId).filter((id): id is string => id !== undefined))];
          if (exchangeIds.length > 0) {
            const entities = await options.supersession.resolveEntities(input.orgId, input.conversationId, projectScope, exchangeIds);
            const selectedExchanges = exchangeIds.flatMap((exchangeId) => {
              const entity = entities.get(exchangeId);
              return entity === undefined ? [] : [{ exchangeId, entity }];
            });
            const names = [...new Set(selectedExchanges.map((exchange) => exchange.entity))];
            if (names.length > 0) {
              const [graphPairs, freshPairs] = await Promise.all([
                options.supersession.findFunctionSuperseded(input.orgId, projectScope, names),
                options.supersession.findFreshSuperseded(
                  input.orgId,
                  input.conversationId,
                  projectScope,
                  selectedExchanges.map((exchange) => exchange.exchangeId),
                ),
              ]);
              const selected = selectedExchanges.map((exchange, index) => ({ index, entity: exchange.entity }));
              candidateSupersededExchangeCount = selected.length - suppressSuperseded(selected, [...graphPairs, ...freshPairs]).length;
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
          candidateSupersededExchangeCount,
          ...(factCoverage ? { factCoverage } : {}),
          ...(queryFactRescue ? { queryFactRescue } : {}),
          ...(incompleteExchangeCount > 0 ? { provenanceIncompleteExchangeCount: incompleteExchangeCount } : {}),
        });
        // Keep the current exchange and cap prior context without retaining unbounded raw turns.
        if (current.manager.hot.size() + 2 > maxTurns) {
          current.manager = newManager();
          current.failedExchanges.clear();
        }
        if (memoryPersisted === false && input.exchangeId) current.failedExchanges.add(input.exchangeId);
        const timestampMs = now();
        await current.manager.ingest({ role: "user", content: query, timestampMs, scopeId, ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}) });
        await current.manager.ingest({ role: "assistant", content: assistant, timestampMs, scopeId, ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}) });
      });
    current.chain = work;
    await work;
  };
}
