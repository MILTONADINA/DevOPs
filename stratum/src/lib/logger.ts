/**
 * Pino Logger Instance
 *
 * All logging goes through this instance. Never use console.log.
 *
 * SECURITY: Never log plaintext context content, session encryption
 * keys, or full API keys. Log masked versions only (sk-ant-...xxxx).
 */

import pino from "pino";

// `transport` is included ONLY in development. Under exactOptionalPropertyTypes,
// pino's LoggerOptions.transport must not be assigned `undefined` explicitly, so
// we conditionally spread the key in rather than setting it to undefined.
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  ...(process.env["NODE_ENV"] === "development"
    ? { transport: { target: "pino-pretty" } }
    : {}),
});
