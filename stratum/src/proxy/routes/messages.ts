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
import type { ForwardHeaders, MessagesBody, MessagesDeps, TokenCountResult } from "../forward";
import { isStreamingRequest } from "../stream-forward";
import { createSseParser, createStreamAccumulator } from "../sse";
import { emitTurnTelemetry } from "../telemetry";

declare module "fastify" {
  interface FastifyRequest {
    /** Per-minute token-budget state (set by the budget gate; emitted as X-RateLimit-*-Tokens). */
    tokenBudgetHeaders?: { limit: number; remaining: number };
  }
}

/** The client headers a transparent proxy forwards upstream: the API version + any beta opt-ins. */
function passthroughHeaders(request: FastifyRequest): ForwardHeaders {
  const out: ForwardHeaders = {};
  const v = request.headers["anthropic-version"];
  if (typeof v === "string" && v !== "") out.anthropicVersion = v;
  const b = request.headers["anthropic-beta"];
  const beta = Array.isArray(b) ? b.join(",") : b;
  if (typeof beta === "string" && beta !== "") out.anthropicBeta = beta;
  return out;
}

/** Extract output_tokens from a response/usage object (0 if absent). */
function outputTokensOf(response: unknown): number {
  const u = (response as { usage?: { output_tokens?: number } } | null)?.usage;
  return typeof u?.output_tokens === "number" ? u.output_tokens : 0;
}

/** Extract input_tokens from an upstream response/usage object (0 if absent). The AUTHORITATIVE count. */
function inputTokensOf(response: unknown): number {
  const u = (response as { usage?: { input_tokens?: number } } | null)?.usage;
  return typeof u?.input_tokens === "number" ? u.input_tokens : 0;
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
 * Per-org token-budget gate (commercial). Returns a 429 reply if the org is over its plan's
 * token budget, else null (proceed). Fail-OPEN on a tracker error — never block legit traffic
 * on a transient budget-lookup failure. Only active when a budget + an authenticated org exist.
 */
async function checkTokenBudget(deps: MessagesDeps, request: FastifyRequest, inputTokens: number, reply: FastifyReply): Promise<boolean> {
  const orgId = request.orgId;
  if (deps.tokenBudget === undefined || typeof orgId !== "string" || orgId === "") return false;
  let verdict;
  try {
    verdict = await deps.tokenBudget.tryConsume(orgId, inputTokens);
  } catch {
    return false; // fail-open: never block legit traffic on a transient budget-lookup error
  }
  request.tokenBudgetHeaders = { limit: verdict.limit, remaining: verdict.remaining }; // for X-RateLimit-*-Tokens
  if (verdict.allowed) return false;
  void reply.status(429).send({
    type: "error",
    error: { type: "rate_limit_error", message: `token budget exceeded (${verdict.limitType ?? "tokens"}; limit ${verdict.limit ?? 0})`, limit_type: verdict.limitType },
  });
  return true; // over budget — response sent
}

/**
 * Best-effort commercial usage persistence (writes a signed billing_record to Supabase). Fire-and-forget
 * + fail-open: invoked AFTER a successful forward so it never adds latency to or fails the proxied
 * response. No-op unless an authenticated org + a recorder exist and the count is > 0.
 */
function recordUsageSafe(deps: MessagesDeps, request: FastifyRequest, model: string, inputTokens: number, outputTokens: number): void {
  const orgId = request.orgId;
  if (deps.recordUsage === undefined || typeof orgId !== "string" || orgId === "") return;
  if (!(inputTokens > 0)) {
    // The billing_records `original_tokens > 0` CHECK would reject a 0-token record. Callers now pass the
    // UPSTREAM-confirmed input count (present on every 2xx), so reaching here means both that and the
    // pre-flight count were unavailable — a genuine invoice hole. WARN (don't drop silently) so it's visible.
    request.log?.warn?.({ orgId, model }, "usage record skipped: input_tokens<=0 (no count from upstream OR pre-flight)");
    return;
  }
  void deps.recordUsage({ orgId, model, inputTokens, outputTokens }).catch((e: unknown) => {
    request.log?.error?.({ err: (e as Error).message }, "usage record failed (non-blocking)");
  });
}

/**
 * Streaming branch: forward with SSE, tee each chunk to the client while
 * accumulating the event stream, then capture the (redacted) accumulated turn.
 */
async function handleStreaming(body: MessagesBody, request: FastifyRequest, reply: FastifyReply, deps: MessagesDeps, start: number): Promise<FastifyReply> {
  // Count + budget-check BEFORE forwarding (so an over-budget request never reaches upstream).
  const tokens = await deps.countTokens(body).catch(() => ESTIMATED_FALLBACK);
  if (await checkTokenBudget(deps, request, tokens.input_tokens, reply)) return reply;

  let sf;
  try {
    sf = await deps.forwardStream(body, deps.apiKey, passthroughHeaders(request));
  } catch (e) {
    return reply.status(502).send({
      type: "error",
      error: { type: "upstream_unreachable", message: (e as Error).message },
    });
  }
  if (sf.status >= 400 || !sf.stream) {
    return reply.status(sf.status).send(sf.data);
  }

  const upstream = sf.stream;

  const out = new PassThrough();
  void reply.header("content-type", "text/event-stream");
  void reply.header("cache-control", "no-cache");
  void reply.header("connection", "keep-alive");

  // Pump runs concurrently with Fastify piping `out` to the client.
  void (async () => {
    const parser = createSseParser();
    // Incremental fold (not a growing events[] array): each parsed batch is folded into the running
    // message and then discarded, so per-request heap stays O(accumulated text) even for a very long
    // streaming generation — and even though we keep draining upstream after a client abort (below).
    const acc = createStreamAccumulator();
    try {
      for await (const chunk of upstream) {
        // Keep DRAINING upstream even after the client goes away — `message_delta` (the ONLY source of
        // output_tokens, and the invoice basis for this turn) is the LAST event, so breaking on a client
        // abort recorded a 0/partial output count. Anthropic generates + charges for the whole response
        // regardless, so reading the already-open socket to completion is the correct billing behavior;
        // we just stop WRITING to the departed client.
        if (!out.destroyed) out.write(chunk);
        acc.push(parser.push(chunk));
      }
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
      // flush() in the FINALLY (not the try) so a partial event buffered when the stream ERRORED
      // mid-chunk — e.g. a split `message_delta` carrying output_tokens — is still recovered for billing.
      acc.push(parser.flush());
      // Capture the accumulated turn (redaction + FAIL-CLOSED inside the store).
      // Done BEFORE out.end() so the artifact is written before the response
      // completes. A client abort still captures what was forwarded.
      const { message } = acc.result();
      // Bill on the UPSTREAM-confirmed input count (from message_start, which arrives early — present even
      // on an abort), falling back to the pre-flight count only if upstream omitted it (exact-counts rule).
      const billedInput = inputTokensOf(message) > 0 ? inputTokensOf(message) : tokens.input_tokens;
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
          "stratum.input_tokens": billedInput,
          "stratum.output_tokens": outputTokensOf(message),
          "stratum.token_count_method": tokens.token_count_method,
          "stratum.elapsed_ms": Date.now() - start,
          "stratum.streaming": true,
          "stratum.dropped": !recorded,
        },
        deps.telemetry,
      );
      recordUsageSafe(deps, request, body.model, billedInput, outputTokensOf(message));
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

      // Per-org token-budget gate (commercial) — reject before forwarding if over budget.
      if (await checkTokenBudget(deps, request, tokens.input_tokens, reply)) return reply;

      // Forward upstream. validateStatus:true means HTTP errors come back as a
      // result (not a throw); a throw here is a genuine network/transport error.
      let forwarded;
      try {
        forwarded = await deps.forward(body, deps.apiKey, passthroughHeaders(request));
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
      // Bill on the UPSTREAM-confirmed input count (Anthropic's own usage.input_tokens — the exact,
      // provable number the billing model requires), falling back to the pre-flight count only if the
      // response omitted usage. The pre-flight count is the BUDGET-gate input; the invoice basis is this.
      const billedInput = inputTokensOf(forwarded.data) > 0 ? inputTokensOf(forwarded.data) : tokens.input_tokens;
      emitTurnTelemetry(
        {
          "stratum.session_id": deps.capture.getSession().session_id,
          "stratum.turn_number": deps.capture.getSession().total_turns,
          "stratum.model": body.model,
          "stratum.input_tokens": billedInput,
          "stratum.output_tokens": outputTokensOf(forwarded.data),
          "stratum.token_count_method": tokens.token_count_method,
          "stratum.elapsed_ms": Date.now() - start,
          "stratum.streaming": false,
          "stratum.dropped": !recorded,
        },
        deps.telemetry,
      );
      recordUsageSafe(deps, request, body.model, billedInput, outputTokensOf(forwarded.data));

      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- FALSE POSITIVE: transparent JSON proxy. Forwards the upstream Anthropic response (Fastify sends it as application/json) to the Claude Code CLI client; never HTML rendered in a browser, so no XSS surface. The "user input" is the upstream provider's own JSON, not attacker markup.
      return reply.send(forwarded.data);
    });
    done();
  };
}
