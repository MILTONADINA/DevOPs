/**
 * Token-count API (Phase 1) — POST /v1/tokens/count (docs/API_REFERENCE.md).
 *
 * Count input tokens for a messages body WITHOUT proxying the request — lets a client estimate
 * cost/savings before sending. Wraps the same exact SDK counter the proxy uses (NEVER tiktoken).
 * The counter is INJECTED (TokensDeps) so the route is testable with no SDK/network; commercial
 * mode reuses the already-wired messages counter.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { MessagesBody, TokenCountResult } from "../forward";

export interface TokensDeps {
  countTokens: (body: MessagesBody) => Promise<TokenCountResult>;
}

function err(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type: "request_error", message } });
}

/** Validate the minimal {model, messages} shape the counter needs. */
function asMessagesBody(body: unknown): MessagesBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b["model"] !== "string" || b["model"] === "") return null;
  if (!Array.isArray(b["messages"])) return null;
  return b as unknown as MessagesBody;
}

/**
 * Build the token-count API plugin.
 *
 * @param deps - the token counter (a fake in tests; the SDK counter in prod).
 * @returns a plugin registering POST /v1/tokens/count.
 */
export function makeTokensRoute(deps: TokensDeps): FastifyPluginCallback {
  return function tokensPlugin(app: FastifyInstance, _opts, done): void {
    app.post("/v1/tokens/count", async (req: FastifyRequest, reply) => {
      const parsed = asMessagesBody(req.body);
      if (parsed === null) return err(reply, 400, "body must be { model: string, messages: [...] }");
      const result = await deps.countTokens(parsed);
      return { input_tokens: result.input_tokens, token_count_method: result.token_count_method };
    });
    done();
  };
}
