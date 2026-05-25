/**
 * Anthropic Client Singleton
 *
 * Provides a configured Anthropic SDK client.
 * Used for exact token counting and API forwarding.
 *
 * IMPORTANT: Use this client's countTokens for all token counting.
 * Never use tiktoken. Never estimate.
 */

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/**
 * Returns the shared Anthropic client instance.
 * @returns Configured Anthropic client
 * @throws {Error} If ANTHROPIC_API_KEY is not set
 */
export function getAnthropicClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set in environment");
  }

  client = new Anthropic({ apiKey });
  return client;
}
