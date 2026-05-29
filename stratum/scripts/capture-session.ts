/**
 * scripts/capture-session.ts
 *
 * Phase 0 tool: captures raw Anthropic API traffic from a Claude Code session
 * and dumps it to a timestamped JSON file for manual waste analysis.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4090 npm run capture
 *
 * This starts a lightweight interceptor proxy on port 4090.
 * Point Claude Code at it, run a normal session, then Ctrl+C.
 * The captured session is written to data/sessions/session-<timestamp>.json
 *
 * This script does NOT prune, modify, or analyze — it only captures.
 * Analysis happens manually using the waste-taxonomy.md template.
 */

import Fastify from "fastify";
import axios from "axios";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

// Session 15 §2a-2: P0-F PII redaction consumption.
// Single source of truth for PII patterns per spec §3 P0-F (Stratum CONSUMES,
// does NOT duplicate). The 8 patterns (email, phone-us, ssn, cc, jwt, bearer,
// sk-key, aws-key) live in observability/pii-redaction.ts.
//
// Cross-subtree import via @devops/* alias: observability/ is at DevOPs root;
// capture-session.ts is at stratum/scripts/. The alias is configured in
// stratum/tsconfig.json `paths` (ts-node honors at runtime for `npm run
// capture`) and stratum/vitest.config.ts `resolve.alias` (vitest honors at
// test time, allowing reliable vi.mock matching).
import { redactValue as devopsRedactValue } from "@devops/observability/pii-redaction";

dotenv.config();

const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is required in .env");
  process.exit(1);
}

// Q4 binding (Session 15 §2a-1): env-var-primary base-URL override with
// safe default + fail-fast validation at module load (NOT at first request).
// See specs/meta/session-15-v0.3x-2a-code-gaps.md REQ-S15-2a-1.
const ANTHROPIC_BASE_URL = (() => {
  const raw = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.error(
        `ERROR: ANTHROPIC_BASE_URL must use http:// or https:// protocol; got: ${parsed.protocol}`,
      );
      console.error(`  Value: ${raw}`);
      console.error(
        "  Fail-fast at module load per AC-S15-2a-1.3; this is a config error, not a runtime error.",
      );
      process.exit(1);
    }
    // Strip trailing slash for consistent path concatenation.
    return raw.replace(/\/+$/, "");
  } catch (e) {
    console.error(`ERROR: ANTHROPIC_BASE_URL is not a parseable URL: ${raw}`);
    console.error(`  Parser error: ${(e as Error).message}`);
    console.error(
      "  Fail-fast at module load per AC-S15-2a-1.3; this is a config error, not a runtime error.",
    );
    process.exit(1);
  }
})();

const CAPTURE_PORT = 4090;
const SESSION_ID = randomUUID();
const OUTPUT_DIR = path.join(process.cwd(), "data", "sessions");
const OUTPUT_FILE = path.join(OUTPUT_DIR, `session-${SESSION_ID}.json`);

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

interface CapturedRequest {
  turn: number;
  timestamp: number;
  request: {
    model: string;
    messages: unknown[];
    system?: string;
    tools?: unknown[];
    max_tokens: number;
  };
  token_counts: {
    input_tokens: number;
    message_breakdown: {
      role: string;
      token_count: number;
    }[];
  };
  response: {
    id: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
    stop_reason: string;
  };
  elapsed_ms: number;
}

interface CapturedSession {
  session_id: string;
  started_at: string;
  ended_at?: string;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  requests: CapturedRequest[];
}

const session: CapturedSession = {
  session_id: SESSION_ID,
  started_at: new Date().toISOString(),
  total_turns: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  requests: [],
};

const fastify = Fastify({ logger: false });

fastify.post("/v1/messages", async (request, reply) => {
  const start = Date.now();
  const body = request.body as {
    model: string;
    messages: { role: string; content: unknown }[];
    system?: string;
    tools?: unknown[];
    max_tokens: number;
  };

  session.total_turns++;
  const turnNumber = session.total_turns;

  console.log(`\n[Turn ${turnNumber}] Intercepted request`);
  console.log(`  Model: ${body.model}`);
  console.log(`  Messages in context: ${body.messages.length}`);

  // Count tokens using the Anthropic SDK (exact count)
  let inputTokenCount = 0;
  const messageBreakdown: { role: string; token_count: number }[] = [];

  try {
    const countResult = await client.messages.countTokens({
      model: body.model,
      messages: body.messages as Anthropic.MessageParam[],
      ...(body.system ? { system: body.system } : {}),
      ...(body.tools ? { tools: body.tools as Anthropic.Tool[] } : {}),
    });

    inputTokenCount = countResult.input_tokens;
    console.log(`  Total input tokens: ${inputTokenCount}`);

    // Count tokens per message for granular breakdown
    for (const msg of body.messages) {
      const singleCount = await client.messages.countTokens({
        model: body.model,
        messages: [msg as Anthropic.MessageParam],
      });
      messageBreakdown.push({
        role: msg.role,
        token_count: singleCount.input_tokens,
      });
    }
  } catch (e) {
    console.warn("  Token count failed:", e);
  }

  // Forward to real Anthropic API
  let anthropicResponse: unknown;
  try {
    const response = await axios.post(
      `${ANTHROPIC_BASE_URL}/v1/messages`,
      body,
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );
    anthropicResponse = response.data;
  } catch (e: unknown) {
    const axiosError = e as { response?: { data: unknown; status: number } };
    if (axiosError.response) {
      reply.status(axiosError.response.status).send(axiosError.response.data);
      return;
    }
    throw e;
  }

  const elapsed = Date.now() - start;
  const resp = anthropicResponse as {
    id: string;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
  };

  console.log(`  Reported input tokens: ${resp.usage.input_tokens}`);
  console.log(`  Output tokens: ${resp.usage.output_tokens}`);
  console.log(`  Elapsed: ${elapsed}ms`);

  // Session 15 §2a-2 — P0-F PII redaction (AC-S15-2a-2.1, AC-S15-2a-2.2):
  // Redact PII from request payload + response payload BEFORE building the
  // capture artifact. Non-PII metadata (model, stop_reason, usage, id, type,
  // role) is preserved per AC-S15-2a-2.3 — those fields aren't strings that
  // contain PII patterns, so devopsRedactValue() is structure-preserving for
  // them.
  //
  // FAIL-CLOSED on redactor exception (AC-S15-2a-2.2): drop this turn from
  // the session JSON, emit structured stderr, continue accepting subsequent
  // turns. Do NOT write unredacted content to disk.
  let redactedRequestMessages: unknown;
  let redactedSystem: string | undefined;
  let redactedTools: unknown;
  let redactedResponse: unknown;
  try {
    redactedRequestMessages = devopsRedactValue(body.messages);
    redactedSystem = body.system
      ? (devopsRedactValue(body.system) as string)
      : undefined;
    redactedTools = body.tools ? devopsRedactValue(body.tools) : undefined;
    redactedResponse = devopsRedactValue(anthropicResponse);
  } catch (redactionError) {
    const err = redactionError as Error;
    console.error(
      `[PII-redaction FAIL-CLOSED] Turn ${turnNumber} dropped from session JSON.`,
    );
    console.error(`  Reason: ${err.name}: ${err.message}`);
    console.error(
      `  Per AC-S15-2a-2.2: unredacted content MUST NOT reach disk. Continuing with subsequent turns.`,
    );
    // Send the forwarded response back to the client; the dropped turn is
    // only the CAPTURE artifact, not the user's response. The client should
    // still get their LLM reply.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- FALSE POSITIVE: transparent JSON proxy. This forwards the upstream Anthropic API response (sent by Fastify as application/json) to the Claude Code CLI client; it is never HTML rendered in a browser, so there is no XSS surface. The "user input" the rule warns about is the upstream provider's own JSON response, not attacker-controlled markup.
    reply.send(anthropicResponse);
    return;
  }

  // Record the turn (redacted payloads only)
  const captured: CapturedRequest = {
    turn: turnNumber,
    timestamp: Date.now(),
    request: {
      model: body.model,
      messages: redactedRequestMessages as unknown[],
      ...(redactedSystem !== undefined ? { system: redactedSystem } : {}),
      ...(redactedTools !== undefined ? { tools: redactedTools as unknown[] } : {}),
      max_tokens: body.max_tokens,
    },
    token_counts: {
      input_tokens: inputTokenCount,
      message_breakdown: messageBreakdown,
    },
    response: {
      id: resp.id,
      usage: resp.usage,
      stop_reason: resp.stop_reason,
    },
    elapsed_ms: elapsed,
  };
  // Also redact response.content[].text values if they exist. The minimal
  // response shape recorded above (id/usage/stop_reason) is metadata-only,
  // but the full response payload contains content[].text which may contain
  // PII (e.g., assistant echoed a JWT). Store the redacted FULL response so
  // downstream Phase 1+ tooling can analyze actual content safely.
  (captured.response as unknown as { content?: unknown }).content =
    (redactedResponse as { content?: unknown }).content;

  session.requests.push(captured);
  session.total_input_tokens += resp.usage.input_tokens;
  session.total_output_tokens += resp.usage.output_tokens;

  // Write session to disk after every turn (safe against crashes).
  // The session.requests array is now guaranteed redacted-only.
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(session, null, 2));

  // Forward the ORIGINAL (un-redacted) Anthropic response to the client.
  // Redaction is a capture-artifact concern; the client expects the real
  // response. This is the proxy's purpose: pass-through with observation.
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- FALSE POSITIVE: transparent JSON proxy. This forwards the upstream Anthropic API response (sent by Fastify as application/json) to the Claude Code CLI client; it is never HTML rendered in a browser, so there is no XSS surface. The "user input" the rule warns about is the upstream provider's own JSON response, not attacker-controlled markup.
  reply.send(anthropicResponse);
});

// Handle shutdown
const shutdown = () => {
  session.ended_at = new Date().toISOString();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(session, null, 2));

  console.log("\n\n====================================");
  console.log("Session capture complete");
  console.log("====================================");
  console.log(`Session ID:     ${SESSION_ID}`);
  console.log(`Total turns:    ${session.total_turns}`);
  console.log(`Total input:    ${session.total_input_tokens.toLocaleString()} tokens`);
  console.log(`Total output:   ${session.total_output_tokens.toLocaleString()} tokens`);
  console.log(`Output file:    ${OUTPUT_FILE}`);
  console.log("\nNext step: open the JSON and fill in docs/waste-taxonomy.md");
  console.log("====================================\n");

  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

fastify.listen({ port: CAPTURE_PORT, host: "127.0.0.1" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  console.log("====================================");
  console.log("CQ Session Capture — Phase 0");
  console.log("====================================");
  console.log(`Proxy running on:  http://localhost:${CAPTURE_PORT}`);
  console.log(`Session ID:        ${SESSION_ID}`);
  console.log(`Output file:       ${OUTPUT_FILE}`);
  console.log("\nTo capture Claude Code sessions:");
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${CAPTURE_PORT}`);
  console.log("  claude  (or run Claude Code normally)");
  console.log("\nPress Ctrl+C when done to save the session.");
  console.log("====================================\n");
});
