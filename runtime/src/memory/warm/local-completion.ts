import type { FactCompletion } from "./extractor";

/** Complete fact extraction against an already-validated loopback OpenAI endpoint. */
export function createLocalFactCompletion(baseUrl: string, model: string, apiKey?: string): FactCompletion {
  return {
    async complete(prompt) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: model.slice(6),
          temperature: 0,
          max_tokens: 1024,
          chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error(`local extraction model returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          throw new Error("local extraction model response exceeded 65536 bytes");
        }
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
      const choice = body?.choices?.[0];
      if (choice?.finish_reason !== "stop") throw new Error("local extraction model did not complete");
      if (typeof choice.message?.content !== "string" || !choice.message.content) {
        throw new Error("local extraction model returned no text");
      }
      return choice.message.content;
    },
  };
}
