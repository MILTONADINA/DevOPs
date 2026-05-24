/**
 * Pino Logger Instance
 *
 * All logging goes through this instance. Never use console.log.
 *
 * SECURITY: Never log plaintext context content, session encryption
 * keys, or full API keys. Log masked versions only (sk-ant-...xxxx).
 */

import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport:
    process.env["NODE_ENV"] === "development"
      ? { target: "pino-pretty" }
      : undefined,
});
