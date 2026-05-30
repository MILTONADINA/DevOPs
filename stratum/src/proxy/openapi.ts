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

/**
 * A self-contained, dependency-free API-reference page served at GET /docs. It fetches /openapi.json
 * (the always-current contract, kept honest by the drift-guard test) and renders it client-side using
 * ONLY createElement + textContent — no innerHTML, no external CDN/script — matching the XSS-safe
 * vanilla-HTML convention of the CFO dashboard. The human-browsable face of the machine contract.
 */
export const OPENAPI_DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stratum API Reference</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0b0e14; color: #e6e6e6; }
  header { padding: 28px 32px 18px; border-bottom: 1px solid #232a36; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .ver { color: #8b97a8; font-size: 13px; }
  header p.desc { color: #b9c2d0; max-width: 70ch; }
  main { padding: 18px 32px 64px; max-width: 980px; }
  .op { border: 1px solid #232a36; border-radius: 8px; padding: 14px 16px; margin: 12px 0; background: #11151d; }
  .op-head { display: flex; align-items: center; gap: 10px; }
  .method { color: #fff; font-weight: 700; font-size: 12px; padding: 3px 8px; border-radius: 5px; letter-spacing: .03em; }
  .path { font-size: 15px; color: #e6e6e6; }
  .summary { margin: 8px 0 6px; color: #b9c2d0; }
  .pub { display: inline-block; font-size: 12px; color: #6ee7b7; border: 1px solid #14532d; background: #052e1a; padding: 2px 7px; border-radius: 5px; }
  table { border-collapse: collapse; margin: 8px 0 2px; font-size: 13px; width: 100%; }
  th, td { text-align: left; padding: 4px 10px 4px 0; color: #c9d2de; border-bottom: 1px solid #1b2230; }
  th { color: #8b97a8; font-weight: 600; }
  .req { color: #f59e0b; }
  .resp { margin-top: 8px; font-size: 13px; color: #8b97a8; }
  .auth { margin: 6px 0 0; font-size: 13px; color: #8b97a8; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: #7aa2f7; }
</style>
</head>
<body>
<header>
  <h1 id="title">Stratum API Reference</h1>
  <div class="ver" id="ver"></div>
  <p class="desc" id="desc"></p>
  <p class="auth">Authenticate with <code>Authorization: Bearer &lt;api-key&gt;</code>. Machine-readable spec: <a href="/openapi.json">/openapi.json</a>.</p>
</header>
<main id="app">Loading the contract…</main>
<script>
(async () => {
  const app = document.getElementById("app");
  let spec;
  try {
    const res = await fetch("/openapi.json");
    if (!res.ok) throw new Error(String(res.status));
    spec = await res.json();
  } catch (e) {
    app.textContent = "Failed to load /openapi.json (" + e.message + ")";
    return;
  }
  document.getElementById("title").textContent = spec.info.title;
  document.getElementById("ver").textContent = "v" + spec.info.version;
  document.getElementById("desc").textContent = spec.info.description || "";
  app.textContent = "";
  const colors = { get: "#2563eb", post: "#16a34a", patch: "#d97706", delete: "#dc2626", put: "#7c3aed" };
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const card = document.createElement("section");
      card.className = "op";
      const head = document.createElement("div");
      head.className = "op-head";
      const badge = document.createElement("span");
      badge.className = "method";
      badge.textContent = method.toUpperCase();
      badge.style.background = colors[method] || "#555";
      const code = document.createElement("code");
      code.className = "path";
      code.textContent = path;
      head.append(badge, code);
      card.append(head);
      if (op.summary) {
        const s = document.createElement("p");
        s.className = "summary";
        s.textContent = op.summary;
        card.append(s);
      }
      if (Array.isArray(op.security) && op.security.length === 0) {
        const pub = document.createElement("span");
        pub.className = "pub";
        pub.textContent = "public — no key required";
        card.append(pub);
      }
      const params = op.parameters || [];
      if (params.length) {
        const t = document.createElement("table");
        const hr = document.createElement("tr");
        for (const h of ["Parameter", "In", "Required"]) {
          const th = document.createElement("th");
          th.textContent = h;
          hr.append(th);
        }
        t.append(hr);
        for (const prm of params) {
          const tr = document.createElement("tr");
          const n = document.createElement("td");
          const c = document.createElement("code");
          c.textContent = prm.name;
          n.append(c);
          const i = document.createElement("td");
          i.textContent = prm.in;
          const r = document.createElement("td");
          r.textContent = prm.required ? "required" : "optional";
          if (prm.required) r.className = "req";
          tr.append(n, i, r);
          t.append(tr);
        }
        card.append(t);
      }
      const codes = Object.keys(op.responses || {});
      if (codes.length) {
        const r = document.createElement("div");
        r.className = "resp";
        r.textContent = "Responses: " + codes.join(", ");
        card.append(r);
      }
      app.append(card);
    }
  }
})();
</script>
</body>
</html>`;
