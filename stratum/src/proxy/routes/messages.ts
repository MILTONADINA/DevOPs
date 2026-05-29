/**
 * POST /v1/messages — Anthropic-compatible proxy endpoint (Phase 1).
 *
 * Drop-in replacement for the Anthropic Messages API. Phase 1: counts tokens,
 * forwards the request UNCHANGED, captures the (redacted) turn, and returns the
 * upstream response verbatim. No pruning (that is Phase 2). Upstream 4xx/5xx
 * bodies are passed through; network failures surface as 502.
 *
 * The handler takes injectable deps (forward / countTokens / capture) so it is
 * tested hermetically via app.inject() without real network or SDK calls.
 */

import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import type { MessagesBody, MessagesDeps } from "../forward";

/**
 * Build the /v1/messages Fastify plugin bound to the given deps.
 *
 * @param deps - forward + token-count + capture dependencies.
 * @returns a Fastify plugin registering POST /v1/messages.
 */
export function makeMessagesRoute(deps: MessagesDeps): FastifyPluginCallback {
  return function messagesPlugin(app: FastifyInstance, _opts, done): void {
    app.post("/v1/messages", async (request, reply) => {
      const start = Date.now();
      const body = request.body as MessagesBody;

      if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
        return reply.status(400).send({
          type: "error",
          error: { type: "invalid_request_error", message: "missing required field: messages[]" },
        });
      }

      // Exact token count (best-effort; method is flagged honestly downstream).
      let tokens;
      try {
        tokens = await deps.countTokens(body);
      } catch {
        tokens = { input_tokens: 0, token_count_method: "estimated" as const, message_breakdown: [] };
      }

      // Forward upstream. validateStatus:true means HTTP errors come back as a
      // result (not a throw); a throw here is a genuine network/transport error.
      let forwarded;
      try {
        forwarded = await deps.forward(body, deps.apiKey);
      } catch (e) {
        request.log?.error?.({ err: (e as Error).message }, "upstream forward failed");
        return reply.status(502).send({
          type: "error",
          error: { type: "upstream_unreachable", message: (e as Error).message },
        });
      }

      // Pass upstream 4xx/5xx through unchanged; do NOT capture error turns.
      if (forwarded.status >= 400) {
        return reply.status(forwarded.status).send(forwarded.data);
      }

      // Capture the turn (redaction + FAIL-CLOSED happen inside the store).
      deps.capture.record({
        request: {
          model: body.model,
          messages: body.messages,
          ...(body.system !== undefined ? { system: body.system } : {}),
          ...(body.tools !== undefined ? { tools: body.tools } : {}),
          max_tokens: body.max_tokens,
        },
        response: forwarded.data,
        inputTokens: tokens.input_tokens,
        tokenCountMethod: tokens.token_count_method,
        messageBreakdown: tokens.message_breakdown,
        elapsedMs: Date.now() - start,
      });

      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- FALSE POSITIVE: transparent JSON proxy. Forwards the upstream Anthropic response (Fastify sends it as application/json) to the Claude Code CLI client; never HTML rendered in a browser, so no XSS surface. The "user input" is the upstream provider's own JSON, not attacker markup.
      return reply.send(forwarded.data);
    });
    done();
  };
}
