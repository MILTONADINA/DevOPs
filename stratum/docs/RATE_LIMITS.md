# RATE_LIMITS.md — Rate Limits and Quotas

## Overview

CQ applies rate limits at two layers: CQ's own proxy layer, and the upstream Anthropic API. Understanding both is important for building reliable integrations.

---

## CQ Proxy Rate Limits

These limits are enforced by the CQ proxy before the request reaches Anthropic.

| Plan | Requests per minute | Requests per hour | Concurrent sessions |
|---|---|---|---|
| Starter | 20 | 500 | 1 |
| Growth | 60 | 2,000 | 5 |
| Enterprise | 300 | 10,000 | 25 |
| Custom | Negotiated | Negotiated | Negotiated |

### Token Budget Limits

| Plan | Tokens per minute (input) | Tokens per day |
|---|---|---|
| Starter | 50,000 | 1,000,000 |
| Growth | 200,000 | 5,000,000 |
| Enterprise | 1,000,000 | Unlimited |

Note: These are limits on tokens **sent to CQ** (pre-pruning). After pruning, significantly fewer tokens reach Anthropic. The limits exist to protect the CQ infrastructure, not to cap your Anthropic usage.

---

## Rate Limit Headers

Every response from the CQ proxy includes rate limit headers:

```
X-RateLimit-Limit-Requests: 60
X-RateLimit-Remaining-Requests: 54
X-RateLimit-Reset-Requests: 2026-04-06T14:24:00Z

X-RateLimit-Limit-Tokens: 200000
X-RateLimit-Remaining-Tokens: 187400
X-RateLimit-Reset-Tokens: 2026-04-06T14:24:00Z
```

---

## Rate Limit Errors

When a rate limit is exceeded, CQ returns:

```json
HTTP 429 Too Many Requests

{
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded. You have sent 60 requests in the last 60 seconds. Limit is 60/min.",
    "limit_type": "requests_per_minute",
    "retry_after_seconds": 23
  }
}
```

`retry_after_seconds` tells you exactly how long to wait before retrying.

---

## Handling Rate Limits in Code

```typescript
async function callWithRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxRetries = 3
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        const retryAfter = parseInt(
          (error as { headers?: Record<string, string> }).headers?.["retry-after"] ?? "30"
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## Anthropic Upstream Limits

CQ forwards requests to Anthropic, which has its own rate limits. CQ surfaces these transparently: if Anthropic returns a 429, CQ returns a 429 to you with the same `retry-after` value.

Current Anthropic limits (as of April 2026 — check Anthropic's documentation for current values):

| Model | Tokens per minute (input) | Requests per minute |
|---|---|---|
| Claude Opus | 40,000 | 50 |
| Claude Sonnet | 80,000 | 100 |
| Claude Haiku | 100,000 | 200 |

These limits apply to your Anthropic API key, not to CQ's proxy. If you share an API key across multiple applications, their usage counts toward the same Anthropic limits.

---

## Special Limits

### Token Counting Endpoint (`POST /v1/tokens/count`)

The token counting endpoint has separate, more generous limits because it does not incur Anthropic API costs:

| Plan | Requests per minute |
|---|---|
| All plans | 200 |

### Eval Trigger (config changes)

When you change λ, g, or θ via `PATCH /v1/config`, an eval run is triggered automatically. Eval runs are limited to:

- 1 triggered eval run per config change
- Maximum 5 config changes per day (to prevent eval abuse)
- Eval results are available via webhook (`eval.completed`) and via `GET /v1/evals/latest`

### Webhook Test Endpoint (`POST /v1/webhooks/test`)

- 10 test events per hour per organization

---

## Increasing Limits

Contact `support@startum.com` or your account manager with:

- Your current plan
- Your expected usage pattern (requests/min, tokens/min)
- Your use case

Enterprise and Custom plans have negotiated limits. For short-term bursts (e.g., a batch processing job), temporary limit increases are available with 24 hours notice.

---

## Best Practices

**Use session pinning for multi-turn conversations.** Rather than creating a new session for each message, pin requests to a session ID. This improves CQ's pruning accuracy (more history to work with) and avoids hitting per-session creation limits.

**Implement exponential backoff.** Don't retry immediately on a 429. Use the `retry_after_seconds` value from the error response. If not present, use: 1s, 2s, 4s, 8s, 16s.

**Batch token counting separately.** If you need to count tokens for display purposes (e.g., showing the user their context size), use `POST /v1/tokens/count` rather than sending a full message. This uses the cheaper counting endpoint and doesn't count against your message rate limit.

**Monitor your usage proactively.** The dashboard shows real-time rate limit usage. Set up the `session.ended` webhook to track per-session token usage and get ahead of limit issues before they cause failures in production.
