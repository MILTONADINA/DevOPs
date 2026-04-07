# TECHNICAL_SPEC.md — Implementation Specification

## Stack Decisions and Rationale

| Component | Choice | Rationale |
|---|---|---|
| Proxy runtime | Cloudflare Workers | Global edge, <50ms, Durable Objects for state |
| Core language | TypeScript | Type safety, Anthropic SDK native, team velocity |
| Hot-path string ops | Rust (WASM) | Token counting, string hashing at >10M ops/sec |
| Client embedder | ONNX Runtime (Node/browser) | <10ms local inference, no network dependency |
| Warm storage | Supabase (Postgres) | Row-level security, real-time subscriptions, local dev parity |
| Cold vector store | Pinecone | Managed, <100ms p99, metadata filtering |
| Cold graph store | Neo4j AuraDB | Managed, Cypher queries, enterprise SLA |
| Fact extractor | Llama 4-8B | Cost: ~$0.001/extraction. Sufficient for structured output |
| Audit model | Claude Opus | Highest accuracy for conflict detection, used sparingly |
| TEE | AWS Nitro Enclaves | Verifiable attestation, no operator access |
| Billing ledger | Supabase (separate schema) | Append-only, auditable, Postgres triggers for immutability |

---

## TypeScript Interfaces

### Core Session Types

```typescript
// src/types/session.ts

export interface Session {
  id: string;                  // uuid
  org_id: string;              // uuid
  developer_id: string;        // uuid
  created_at: number;          // Unix ms
  model: string;               // e.g. "claude-opus-4-6"
  config: SessionConfig;
}

export interface SessionConfig {
  lambda: number;              // temporal decay, default 0.97
  gain_shift: number;          // KadaneDial g param, default 0.0
  theta: number;               // KadaneDial θ param, default 1.0
  embedding_model: string;     // ONNX model path
  audit_enabled: boolean;      // default true
  zk_enabled: boolean;         // default true for enterprise
}

export interface Turn {
  id: string;
  session_id: string;
  timestamp: number;           // Unix ms — used for λ decay
  role: "user" | "assistant" | "tool";
  content: string;
  token_count: number;         // exact, from @anthropic-ai/tokenizer
  embedding: Float32Array;     // 384-dim, L2-normalized
  tool_name?: string;          // if role === "tool"
  tool_call_id?: string;
}
```

### Proxy Request/Response

```typescript
// src/types/proxy.ts

// What the client sends to the CQ proxy
export interface CQProxyRequest {
  session_id: string;
  original_token_count: number;  // counted before pruning
  encrypted_payload?: EncryptedPayload;  // null if zk_enabled=false
  plaintext_payload?: PlaintextPayload;  // null if zk_enabled=true
  anthropic_request_metadata: {
    model: string;
    max_tokens: number;
    system?: string;
  };
}

export interface EncryptedPayload {
  iv: string;             // base64, 12 bytes
  ciphertext: string;     // base64
  auth_tag: string;       // base64, 16 bytes
  attestation_nonce: string;
}

export interface PlaintextPayload {
  messages: AnthropicMessage[];  // pruned turns only
}

// What the proxy sends back
export interface CQProxyResponse {
  session_id: string;
  quarantined_token_count: number;
  anthropic_response: AnthropicAPIResponse;
  billing_record_id: string;
}
```

### Billing Types

```typescript
// src/types/billing.ts

export interface BillingRecord {
  id: string;                    // uuid
  created_at: number;            // Unix ms
  session_id: string;
  org_id: string;
  original_tokens: number;       // signed at proxy ingress
  quarantined_tokens: number;    // signed at proxy egress
  token_delta: number;           // original - quarantined
  api_price_per_token: number;   // snapshot at request time
  cost_delta_usd: number;        // token_delta × price
  cq_fee_usd: number;            // cost_delta × 0.20
  pruning_log_id: string;        // ref to audit log
  signed_hash: string;           // HMAC-SHA256 of this record
}

export interface PruningLog {
  id: string;
  session_id: string;
  created_at: number;
  turns_total: number;
  turns_selected: number[];      // indices of selected turns
  turns_pruned: number[];        // indices of pruned turns
  relevance_scores: number[];    // R_i for each turn
  spans_selected: Array<[number, number]>;  // KadaneDial output
  lambda_used: number;
  gain_shift_used: number;
  theta_used: number;
}
```

### Fact Types

```typescript
// src/types/facts.ts

export type FactType =
  | "FunctionChange"
  | "TechDecision"
  | "PolicyUpdate"
  | "Todo"
  | "VariableChange";

export interface BaseFact {
  id: string;
  created_at: string;            // ISO8601
  session_id: string;
  developer_id?: string;
  commit_hash?: string;
  confidence: number;            // 0.0 – 1.0
  is_verified: boolean;
  is_suppressed: boolean;
  fact_type: FactType;
}

export interface FunctionChangeFact extends BaseFact {
  fact_type: "FunctionChange";
  old_name: string;
  new_name?: string;
  change_type: "deprecated" | "renamed" | "signature_changed";
  file_path?: string;
  language?: string;
}

export interface TechDecisionFact extends BaseFact {
  fact_type: "TechDecision";
  decision_text: string;
  domain: string;
  rationale?: string;
  supersedes_id?: string;
}

export interface PolicyUpdateFact extends BaseFact {
  fact_type: "PolicyUpdate";
  policy_name: string;
  old_value?: string;
  new_value: string;
  policy_type: "security" | "compliance" | "process";
  effective_date?: string;
}

export interface TodoFact extends BaseFact {
  fact_type: "Todo";
  description: string;
  status: "open" | "done" | "cancelled";
  due_date?: string;
  assigned_to?: string;
}

export interface VariableChangeFact extends BaseFact {
  fact_type: "VariableChange";
  var_name: string;
  old_value?: string;
  new_value: string;
  context?: string;
}

export type AnyFact =
  | FunctionChangeFact
  | TechDecisionFact
  | PolicyUpdateFact
  | TodoFact
  | VariableChangeFact;
```

---

## Supabase Schema (Postgres DDL)

```sql
-- Sessions
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id        UUID NOT NULL,
  developer_id  UUID NOT NULL,
  model         TEXT NOT NULL,
  lambda        FLOAT NOT NULL DEFAULT 0.97,
  gain_shift    FLOAT NOT NULL DEFAULT 0.0,
  theta         FLOAT NOT NULL DEFAULT 1.0,
  zk_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  audit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ended_at      TIMESTAMPTZ
);

-- Billing records (append-only via trigger)
CREATE TABLE billing_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id            UUID NOT NULL REFERENCES sessions(id),
  org_id                UUID NOT NULL,
  original_tokens       INTEGER NOT NULL,
  quarantined_tokens    INTEGER NOT NULL,
  token_delta           INTEGER GENERATED ALWAYS AS (original_tokens - quarantined_tokens) STORED,
  api_price_per_token   NUMERIC(12,8) NOT NULL,
  cost_delta_usd        NUMERIC(12,6) GENERATED ALWAYS AS (token_delta * api_price_per_token) STORED,
  cq_fee_usd            NUMERIC(12,6) GENERATED ALWAYS AS (cost_delta_usd * 0.20) STORED,
  pruning_log_id        UUID,
  signed_hash           TEXT NOT NULL
);

-- Prevent billing record modification
CREATE RULE no_update_billing AS ON UPDATE TO billing_records DO INSTEAD NOTHING;
CREATE RULE no_delete_billing AS ON DELETE TO billing_records DO INSTEAD NOTHING;

-- Pruning logs
CREATE TABLE pruning_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id        UUID NOT NULL REFERENCES sessions(id),
  turns_total       INTEGER NOT NULL,
  turns_selected    INTEGER[] NOT NULL,
  turns_pruned      INTEGER[] NOT NULL,
  relevance_scores  FLOAT[] NOT NULL,
  spans_selected    INT4RANGE[] NOT NULL,
  lambda_used       FLOAT NOT NULL,
  gain_shift_used   FLOAT NOT NULL,
  theta_used        FLOAT NOT NULL
);

-- Fact tables (one per type, all share base columns)
CREATE TABLE function_changes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    UUID NOT NULL REFERENCES sessions(id),
  developer_id  UUID,
  commit_hash   TEXT,
  confidence    FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  old_name      TEXT NOT NULL,
  new_name      TEXT,
  change_type   TEXT NOT NULL CHECK (change_type IN ('deprecated','renamed','signature_changed')),
  file_path     TEXT,
  language      TEXT,
  promoted_to_t3 BOOLEAN NOT NULL DEFAULT FALSE
);

-- (tech_decisions, policy_updates, todos, variable_changes follow same pattern)

-- Org config
CREATE TABLE org_config (
  org_id      UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lambda      FLOAT NOT NULL DEFAULT 0.97,
  gain_shift  FLOAT NOT NULL DEFAULT 0.0,
  theta       FLOAT NOT NULL DEFAULT 1.0,
  zk_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  plan        TEXT NOT NULL DEFAULT 'starter'
);
```

---

## API Endpoints

Full reference in `docs/API_REFERENCE.md`. Key proxy routes:

```
POST   /v1/messages           → Anthropic-compatible proxy endpoint
GET    /v1/sessions/:id       → Session metadata
GET    /v1/sessions/:id/stats → Token counts and savings for a session
GET    /v1/billing/summary    → Monthly billing summary for org
GET    /v1/billing/records    → Paginated billing record list
GET    /dashboard             → Waste dashboard UI
GET    /health                → Proxy health check
```

---

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
PINECONE_API_KEY=...
PINECONE_INDEX=cq-cold-memory
NEO4J_URI=neo4j+s://xxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=...
AWS_NITRO_ENCLAVE_CID=16
AUDIT_MODEL_ENDPOINT=https://...
OPUS_API_KEY=sk-ant-...
CQ_MASTER_ENCRYPTION_KEY=...   # 32 random bytes, base64

# Optional
CQ_DEFAULT_LAMBDA=0.97
CQ_DEFAULT_GAIN_SHIFT=0.0
CQ_DEFAULT_THETA=1.0
CQ_ARBITRAGE_RATE=0.20
CQ_AUDIT_CONFIDENCE_THRESHOLD=0.85
LOG_LEVEL=info
PORT=4080
```

---

## Token Counting

**Use `@anthropic-ai/sdk` for all token counting.** Never estimate or use tiktoken.

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function countTokens(messages: MessageParam[], model: string): Promise<number> {
  const response = await client.messages.countTokens({
    model,
    messages,
  });
  return response.input_tokens;
}
```

This must be called twice per request:
1. On the original (pre-pruning) message array → `original_tokens`
2. On the pruned message array → `quarantined_tokens`

Both counts are recorded in the billing record before forwarding to the API.
