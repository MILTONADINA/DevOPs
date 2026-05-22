# Laminar setup

Agent-first observability. Strong session replay and tool-call timeline view.
Better than Langfuse for long-running multi-agent workflows.

## Self-hosted

```bash
git clone https://github.com/lmnr-ai/lmnr
cd lmnr
docker-compose up -d
```

## Configure

```bash
export LAMINAR_API_KEY=...
export LAMINAR_HOST=http://localhost:8000
```

## Native SDK (TypeScript)

```typescript
import { Laminar } from '@lmnr-ai/lmnr';

Laminar.initialize({
  projectApiKey: process.env.LAMINAR_API_KEY,
  baseUrl: process.env.LAMINAR_HOST,
});
```

## What Laminar captures

- Full agent session traces
- Tool-call timelines (great for debugging "what did the agent actually do?")
- Cost attribution
- Replay (re-run a session with the original prompts and see what's different)
- Pipeline-style transcripts for multi-agent workflows
