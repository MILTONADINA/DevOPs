/**
 * OpenAPI 3.1 spec for the Stratum proxy API (the machine-readable form of docs/API_REFERENCE.md).
 *
 * Served at GET /openapi.json so clients can generate SDKs, validate requests, and render Swagger UI.
 * Covers the implemented /v1 surface; the `security` is bearer (the API key). Kept as a plain object
 * (no codegen) so it's reviewable + diffable against the routes.
 */

const ERROR_RESPONSE = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const ORG_ID_QUERY = {
  name: "org-id",
  in: "query",
  required: false,
  description: "Org id (when unauthenticated; otherwise taken from the API key).",
  schema: { type: "string", format: "uuid" },
};

const SINCE_UNTIL = [
  { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" } },
  { name: "until", in: "query", required: false, schema: { type: "string", format: "date-time" } },
];

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Stratum (CQ) Proxy API",
    version: process.env["npm_package_version"] ?? "0.1.0",
    description: "High-fidelity context-pruning proxy: Anthropic-compatible /v1/messages plus multi-tenant billing, memory, sessions, config, and webhooks. Charges 20% of token savings.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "An API key minted by create-api-key; sent as `Authorization: Bearer <key>` (or `x-api-key`)." },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { type: { const: "error" }, error: { type: "object", properties: { type: { type: "string" }, message: { type: "string" } } } },
      },
      OrgConfig: {
        type: "object",
        properties: {
          lambda: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 1 },
          gain_shift: { type: "number" },
          theta: { type: "number", exclusiveMinimum: 0 },
          zk_enabled: { type: "boolean" },
          audit_enabled: { type: "boolean" },
          webhook_url: { type: ["string", "null"] },
        },
      },
      Invoice: {
        type: "object",
        properties: {
          orgId: { type: "string" },
          plan: { type: "string" },
          totalOriginalTokens: { type: "integer" },
          totalQuarantinedTokens: { type: "integer" },
          totalSavingsUsd: { type: "number" },
          rawFeeUsd: { type: "number" },
          monthlyMinimumUsd: { type: "number" },
          amountDueUsd: { type: "number" },
          effectivenessPct: { type: "number" },
          lineItems: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: { summary: "Liveness + (commercial) dependency status", security: [], responses: { "200": { description: "OK" } } },
    },
    "/v1/messages": {
      post: {
        summary: "Anthropic-compatible Messages proxy (count + forward + capture)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model", "messages"], properties: { model: { type: "string" }, messages: { type: "array" }, max_tokens: { type: "integer" } } } } } },
        responses: { "200": { description: "Upstream Anthropic response (verbatim)" }, "400": ERROR_RESPONSE, "429": ERROR_RESPONSE, "502": ERROR_RESPONSE },
      },
    },
    "/v1/tokens/count": {
      post: {
        summary: "Exact input-token count for a {model, messages} body (no proxying)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model", "messages"], properties: { model: { type: "string" }, messages: { type: "array" } } } } } },
        responses: { "200": { description: "Token count", content: { "application/json": { schema: { type: "object", properties: { input_tokens: { type: "integer" }, token_count_method: { type: "string" } } } } } }, "400": ERROR_RESPONSE },
      },
    },
    "/v1/sessions": {
      get: { summary: "List the org's sessions", parameters: [ORG_ID_QUERY, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Sessions" }, "400": ERROR_RESPONSE } },
      post: { summary: "Start a session (enforces the plan's concurrent-session cap)", parameters: [ORG_ID_QUERY], responses: { "201": { description: "Created session" }, "400": ERROR_RESPONSE, "404": ERROR_RESPONSE, "429": ERROR_RESPONSE } },
    },
    "/v1/sessions/{id}": {
      get: { summary: "Session metadata", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, ORG_ID_QUERY], responses: { "200": { description: "Session" }, "404": ERROR_RESPONSE } },
      delete: { summary: "End a session (sets ended_at)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, ORG_ID_QUERY], responses: { "200": { description: "Ended" }, "404": ERROR_RESPONSE } },
    },
    "/v1/sessions/{id}/stats": {
      get: { summary: "Session token totals + savings", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, ORG_ID_QUERY], responses: { "200": { description: "Stats" }, "404": ERROR_RESPONSE } },
    },
    "/v1/billing/summary": {
      get: { summary: "Monthly billing summary", parameters: [ORG_ID_QUERY, { name: "month", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } }], responses: { "200": { description: "Summary" }, "404": ERROR_RESPONSE } },
    },
    "/v1/billing/invoice": {
      get: { summary: "Computed invoice", parameters: [ORG_ID_QUERY, ...SINCE_UNTIL], responses: { "200": { description: "Invoice", content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } }, "404": ERROR_RESPONSE } },
    },
    "/v1/billing/records": {
      get: { summary: "Paginated raw billing records", parameters: [ORG_ID_QUERY, ...SINCE_UNTIL, { name: "limit", in: "query", schema: { type: "integer", maximum: 500 } }, { name: "offset", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Records page" } } },
    },
    "/v1/billing/audit.csv": {
      get: { summary: "Signed-hash audit trail (CSV download)", parameters: [ORG_ID_QUERY, ...SINCE_UNTIL], responses: { "200": { description: "CSV", content: { "text/csv": {} } } } },
    },
    "/v1/memory/facts": {
      get: { summary: "Recent Tier-2 facts", parameters: [ORG_ID_QUERY, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Facts" } } },
    },
    "/v1/memory/facts/{id}": {
      delete: { summary: "Suppress a fact", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "table", in: "query", required: true, schema: { type: "string" } }, ORG_ID_QUERY], responses: { "200": { description: "Suppressed" }, "400": ERROR_RESPONSE, "404": ERROR_RESPONSE } },
    },
    "/v1/memory/conflicts": {
      get: { summary: "Unacknowledged Historical-Drift conflicts", parameters: [ORG_ID_QUERY], responses: { "200": { description: "Conflicts" } } },
    },
    "/v1/config": {
      get: { summary: "Org pruning + feature config", parameters: [ORG_ID_QUERY], responses: { "200": { description: "Config", content: { "application/json": { schema: { $ref: "#/components/schemas/OrgConfig" } } } } } },
      patch: { summary: "Update org config", parameters: [ORG_ID_QUERY], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/OrgConfig" } } } }, responses: { "200": { description: "Updated config" }, "400": ERROR_RESPONSE } },
    },
    "/v1/webhooks/test": {
      post: { summary: "Send a signed sample webhook event", parameters: [ORG_ID_QUERY], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { event_type: { type: "string" } } } } } }, responses: { "200": { description: "Delivered" }, "400": ERROR_RESPONSE, "502": ERROR_RESPONSE } },
    },
  },
} as const;
