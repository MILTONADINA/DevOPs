/**
 * The organization a request is scoped to. The usage read API (specs/ops/payment-removal.md REQ-3) and the sessions API share this
 * one rule; the memory, config and webhooks routes keep their own copies of it.
 */

import type { FastifyRequest } from "fastify";

/**
 * The org for this request: the authenticated org, else ?org-id (unauthenticated/personal proxy ONLY).
 * Exported for the cross-tenant security regression test. The same pattern is used by every commercial
 * route (sessions/memory/config/webhooks); when `req.authEnforced` is set (the auth gate is registered),
 * the ?org-id fallback is REFUSED so a client can never read another tenant by supplying a UUID.
 */
export function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  // Auth ENFORCED (commercial mode): the org MUST come from the authenticated key — never a client-supplied
  // ?org-id (which would be an unauthenticated cross-tenant read if the gate were ever bypassed). Personal/
  // unauthenticated mode (authEnforced unset) keeps the ?org-id convenience for the local dashboard.
  if (req.authEnforced === true) return undefined;
  const q = req.query as Record<string, unknown>;
  const fromQuery = q["org-id"];
  return typeof fromQuery === "string" && fromQuery !== "" ? fromQuery : undefined;
}
