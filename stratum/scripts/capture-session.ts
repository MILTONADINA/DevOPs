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

dotenv.config();

const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];
if (!ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is required in .env");
  process.exit(1);
}

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
      "https://api.anthropic.com/v1/messages",
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

  // Record the turn
  const captured: CapturedRequest = {
    turn: turnNumber,
    timestamp: Date.now(),
    request: {
      model: body.model,
      messages: body.messages,
      system: body.system,
      tools: body.tools,
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

  session.requests.push(captured);
  session.total_input_tokens += resp.usage.input_tokens;
  session.total_output_tokens += resp.usage.output_tokens;

  // Write session to disk after every turn (safe against crashes)
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(session, null, 2));

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
