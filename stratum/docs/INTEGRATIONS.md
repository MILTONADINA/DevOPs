# INTEGRATIONS.md — Integration Guide

## Overview

CQ works by intercepting requests to the Anthropic API before they reach the LLM. Any tool that calls the Anthropic API can be integrated by pointing it at the CQ proxy instead. This document covers the most common integration patterns.

---

## Claude Code (Primary Integration)

Claude Code respects the `ANTHROPIC_BASE_URL` environment variable.

### Local Development (Phase 1)

```bash
# Terminal 1: Start the CQ proxy
npm run dev
# → Proxy running at http://localhost:4080

# Terminal 2: Point Claude Code at the proxy
export ANTHROPIC_BASE_URL=http://localhost:4080
claude
```

### Production

```bash
export ANTHROPIC_BASE_URL=https://proxy.startum.com
export CQ_API_KEY=your-cq-api-key   # set in Claude Code's env
claude
```

Add to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent:

```bash
# Startum proxy
export ANTHROPIC_BASE_URL=https://proxy.startum.com
```

### Verifying the Integration

After starting a Claude Code session, check the CQ dashboard:

```bash
curl http://localhost:4080/v1/sessions \
  -H "Authorization: Bearer <your-cq-api-key>"
# Should show your active session with token counts
```

---

## Custom Node.js / TypeScript Agents

Replace `baseURL` in your Anthropic client initialization:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
  baseURL: process.env["CQ_PROXY_URL"] ?? "https://proxy.startum.com",
  defaultHeaders: {
    "Authorization": `Bearer ${process.env["CQ_API_KEY"]}`,
  },
});

// All subsequent calls go through CQ automatically
const message = await client.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});

// CQ metadata is available in the response headers
// X-CQ-Session-Id, X-CQ-Original-Tokens, X-CQ-Quarantined-Tokens
```

### Reading CQ Metadata from Responses

```typescript
// When using the raw fetch API (not the SDK):
const response = await fetch(`${CQ_PROXY_URL}/v1/messages`, {
  method: "POST",
  headers: {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "Authorization": `Bearer ${CQ_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(requestBody),
});

const sessionId = response.headers.get("X-CQ-Session-Id");
const originalTokens = response.headers.get("X-CQ-Original-Tokens");
const quarantinedTokens = response.headers.get("X-CQ-Quarantined-Tokens");

const data = await response.json();
// data.cq_metadata contains the same fields
```

---

## Python Agents

```python
import anthropic
import os

client = anthropic.Anthropic(
    api_key=os.environ["ANTHROPIC_API_KEY"],
    base_url=os.environ.get("CQ_PROXY_URL", "https://proxy.startum.com"),
    default_headers={
        "Authorization": f"Bearer {os.environ['CQ_API_KEY']}"
    }
)

message = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
```

---

## LangChain

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic({
  model: "claude-opus-4-6",
  anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
  clientOptions: {
    baseURL: process.env["CQ_PROXY_URL"],
    defaultHeaders: {
      "Authorization": `Bearer ${process.env["CQ_API_KEY"]}`,
    },
  },
});
```

---

## AutoGPT / Open-Source Agents

Any agent that supports a custom Anthropic base URL works with CQ. Set:

```
ANTHROPIC_BASE_URL=https://proxy.startum.com
```

in the agent's environment. If the agent uses a raw HTTP client, add the `Authorization: Bearer <cq-api-key>` header to all requests.

---

## Multi-Session Setup (Fractional CTO Agencies)

For agencies managing multiple projects, use separate sessions per project to prevent Context Bleed:

```typescript
// Project A session
const projectAClient = new Anthropic({
  baseURL: CQ_PROXY_URL,
  defaultHeaders: {
    "Authorization": `Bearer ${CQ_API_KEY}`,
    "X-CQ-Session-Id": PROJECT_A_SESSION_ID,  // pin to a specific session
  },
});

// Project B session — completely isolated
const projectBClient = new Anthropic({
  baseURL: CQ_PROXY_URL,
  defaultHeaders: {
    "Authorization": `Bearer ${CQ_API_KEY}`,
    "X-CQ-Session-Id": PROJECT_B_SESSION_ID,
  },
});
```

Sessions are isolated by default. Cross-session memory (Tier 2/3 retrieval) is scoped to your organization and does not auto-inject — it is queried explicitly.

---

## CI/CD Integration

To measure AI usage in CI pipelines:

```yaml
# GitHub Actions example
- name: Run AI-assisted code generation
  env:
    ANTHROPIC_BASE_URL: https://proxy.startum.com
    CQ_API_KEY: ${{ secrets.CQ_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: |
    # Your AI-assisted step here
    npm run generate

- name: Report CQ savings
  env:
    CQ_API_KEY: ${{ secrets.CQ_API_KEY }}
  run: |
    curl -s "https://proxy.startum.com/v1/sessions?since=$(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%SZ)" \
      -H "Authorization: Bearer $CQ_API_KEY" | jq '.[] | {session_id, token_delta, cq_fee_usd}'
```

---

## Git Repository Connection (for Git-Attestation, Phase 5+)

Connect your repositories to enable Git-Attestation memory verification:

### GitHub

```bash
curl -X POST https://proxy.startum.com/v1/repos \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "github",
    "repo_url": "https://github.com/your-org/your-repo",
    "access_token": "ghp_xxxx"
  }'
```

The access token requires `repo` scope (read-only is sufficient). CQ clones commit metadata only — not the full source code.

### GitLab

```bash
curl -X POST https://proxy.startum.com/v1/repos \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gitlab",
    "repo_url": "https://gitlab.com/your-org/your-repo",
    "access_token": "glpat-xxxx"
  }'
```

### Webhook for Real-Time Indexing

For real-time Git-Attestation (rather than hourly polling), configure a webhook in your repository:

- **GitHub:** Settings → Webhooks → Add webhook
  - Payload URL: `https://proxy.startum.com/v1/webhooks/git`
  - Content type: `application/json`
  - Events: Pushes only
  - Secret: Your webhook secret from `GET /v1/config`

- **GitLab:** Settings → Webhooks
  - URL: `https://proxy.startum.com/v1/webhooks/git`
  - Secret token: Your webhook secret
  - Trigger: Push events only

---

## Environment Variable Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key (forwarded to Anthropic by CQ) |
| `ANTHROPIC_BASE_URL` | Yes | Set to your CQ proxy URL |
| `CQ_API_KEY` | Yes | Your CQ organization API key |
| `CQ_SESSION_ID` | No | Pin requests to a specific session ID |

---

## Verifying Your Integration Works

After setup, run this end-to-end check:

```bash
# 1. Send a test message through CQ
curl -X POST $ANTHROPIC_BASE_URL/v1/messages \
  -H "Authorization: Bearer $CQ_API_KEY" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'

# 2. Check the response includes cq_metadata
# Should see: "cq_metadata": {"session_id": "...", "original_tokens": N, ...}

# 3. Check the dashboard
open $ANTHROPIC_BASE_URL/dashboard
```

If `cq_metadata` is present in the response, CQ is intercepting and processing your requests correctly.
