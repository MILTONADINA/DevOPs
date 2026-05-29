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

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { PassThrough } from "node:stream";
import type { MessagesBody, MessagesDeps, TokenCountResult } from "../forward";
import { isStreamingRequest } from "../stream-forward";
import { createSseParser, accumulateAnthropicStream } from "../sse";
import { emitTurnTelemetry } from "../telemetry";

/** Extract output_tokens from a response/usage object (0 if absent). */
function outputTokensOf(response: unknown): number {
  const u = (response as { usage?: { output_tokens?: number } } | null)?.usage;
  return typeof u?.output_tokens === "number" ? u.output_tokens : 0;
}

const ESTIMATED_FALLBACK: TokenCountResult = {
  input_tokens: 0,
  token_count_method: "estimated",
  message_breakdown: [],
};

/** Build the redacted-by-store request shape from the inbound body. */
function captureRequest(body: MessagesBody): {
  model: string;
  messages: unknown;
  system?: unknown;
  tools?: unknown;
  max_tokens: number;
} {
  return {
    model: body.model,
    messages: body.messages,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    max_tokens: body.max_tokens,
  };
}

/**
 * Streaming branch: forward with SSE, tee each chunk to the client while
 * accumulating the event stream, then capture the (redacted) accumulated turn.
 */
async function handleStreaming(
  body: MessagesBody,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: MessagesDeps,
  start: number,
): Promise<FastifyReply> {
  let sf;
  try {
    sf = await deps.forwardStream(body, deps.apiKey);
  } catch (e) {
    return reply.status(502).send({
      type: "error",
      error: { type: "upstream_unreachable", message: (e as Error).message },
    });
  }
  if (sf.status >= 400 || !sf.stream) {
    return reply.status(sf.status).send(sf.data);
  }

  const tokens = await deps.countTokens(body).catch(() => ESTIMATED_FALLBACK);
  const upstream = sf.stream;

  const out = new PassThrough();
  void reply.header("content-type", "text/event-stream");
  void reply.header("cache-control", "no-cache");
  void reply.header("connection", "keep-alive");

  // Pump runs concurrently with Fastify piping `out` to the client.
  void (async () => {
    const parser = createSseParser();
    const events = [];
    try {
      for await (const chunk of upstream) {
        if (out.destroyed) break; // client went away
        out.write(chunk);
        events.push(...parser.push(chunk));
      }
      events.push(...parser.flush());
    } catch (e) {
      // Mid-stream upstream failure: emit an SSE error event so the client sees it.
      if (!out.destroyed) {
        out.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "upstream_stream_error", message: (e as Error).message },
          })}\n\n`,
        );
      }
    } finally {
      // Capture the accumulated turn (redaction + FAIL-CLOSED inside the store).
      // Done BEFORE out.end() so the artifact is written before the response
      // completes. A client abort still captures what was forwarded.
      const { message } = accumulateAnthropicStream(events);
      const recorded = deps.capture.record({
        request: captureRequest(body),
        response: message,
        inputTokens: tokens.input_tokens,
        tokenCountMethod: tokens.token_count_method,
        messageBreakdown: tokens.message_breakdown,
        elapsedMs: Date.now() - start,
      });
      emitTurnTelemetry(
        {
          "stratum.session_id": deps.capture.getSession().session_id,
          "stratum.turn_number": deps.capture.getSession().total_turns,
          "stratum.model": body.model,
          "stratum.input_tokens": tokens.input_tokens,
          "stratum.output_tokens": outputTokensOf(message),
          "stratum.token_count_method": tokens.token_count_method,
          "stratum.elapsed_ms": Date.now() - start,
          "stratum.streaming": true,
          "stratum.dropped": !recorded,
        },
        deps.telemetry,
      );
      out.end();
    }
  })();

  return reply.send(out);
}

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

      // Streaming branch: when the client asks for SSE (body.stream or Accept
      // header), forward as a stream + tee/accumulate/capture.
      const accept = request.headers["accept"];
      if (isStreamingRequest(body, typeof accept === "string" ? accept : undefined)) {
        return handleStreaming(body, request, reply, deps, start);
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
      const recorded = deps.capture.record({
        request: captureRequest(body),
        response: forwarded.data,
        inputTokens: tokens.input_tokens,
        tokenCountMethod: tokens.token_count_method,
        messageBreakdown: tokens.message_breakdown,
        elapsedMs: Date.now() - start,
      });
      emitTurnTelemetry(
        {
          "stratum.session_id": deps.capture.getSession().session_id,
          "stratum.turn_number": deps.capture.getSession().total_turns,
          "stratum.model": body.model,
          "stratum.input_tokens": tokens.input_tokens,
          "stratum.output_tokens": outputTokensOf(forwarded.data),
          "stratum.token_count_method": tokens.token_count_method,
          "stratum.elapsed_ms": Date.now() - start,
          "stratum.streaming": false,
          "stratum.dropped": !recorded,
        },
        deps.telemetry,
      );

      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- FALSE POSITIVE: transparent JSON proxy. Forwards the upstream Anthropic response (Fastify sends it as application/json) to the Claude Code CLI client; never HTML rendered in a browser, so no XSS surface. The "user input" is the upstream provider's own JSON, not attacker markup.
      return reply.send(forwarded.data);
    });
    done();
  };
}
