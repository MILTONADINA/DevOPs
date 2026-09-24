import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import { createLocalFactCompletion } from "../../src/memory/warm/local-completion";

describe("local fact completion transport", () => {
  test("rejects redirects and oversized model output", async () => {
    let mode: "redirect" | "large" = "redirect";
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain request */ }
      if (mode === "redirect") {
        response.writeHead(302, { location: "http://127.0.0.1:1/v1/chat/completions" }).end();
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "x".repeat(70_000) } }],
        }));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback fixture did not bind");
      const completion = createLocalFactCompletion(`http://127.0.0.1:${address.port}/v1`, "local/check");
      await expect(completion.complete("prompt")).rejects.toThrow();
      mode = "large";
      await expect(completion.complete("prompt")).rejects.toThrow("exceeded 65536 bytes");
    } finally {
      server.close();
    }
  });
});
