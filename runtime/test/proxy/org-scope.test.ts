// resolveOrg (src/proxy/routes/org-scope.ts) is the org-scoping helper that the usage read API and the sessions API share. Its ?org-id query fallback exists for personal/unauthenticated
// mode ONLY: when the auth gate is registered it sets req.authEnforced, and the fallback MUST be refused so a caller can never read another tenant by supplying a UUID (the
// defense-in-depth half of the percent-encoding-bypass fix). The four cases below are that cross-tenant guard, moved here with their assertions unchanged from the billing route test
// (specs/ops/payment-removal.md AC-3).

import { describe, test, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { resolveOrg } from "../../src/proxy/routes/org-scope";

describe("resolveOrg — ?org-id is refused once auth is enforced (cross-tenant guard)", () => {
  const req = (o: Partial<FastifyRequest> & { query?: Record<string, unknown> }) => o as unknown as FastifyRequest;

  // Mutation: reading ?org-id ahead of req.orgId, so a client-supplied org overrides the authenticated one.
  test("specs/ops/payment-removal.md#AC-3 resolveOrg: the authenticated org wins, ignoring any ?org-id (regression guard)", () => {
    expect(resolveOrg(req({ orgId: "A", query: { "org-id": "B" } }))).toBe("A");
  });

  // Mutation: dropping the ?org-id fallback, which personal mode relies on.
  test("specs/ops/payment-removal.md#AC-3 resolveOrg: personal mode (authEnforced unset) honors the ?org-id fallback (regression guard)", () => {
    expect(resolveOrg(req({ query: { "org-id": "B" } }))).toBe("B");
  });

  // Mutation: deleting the authEnforced refusal branch, so an authenticated-mode request with no org falls through to a client-supplied ?org-id (a cross-tenant read).
  test("specs/ops/payment-removal.md#AC-3 resolveOrg: commercial mode (authEnforced) + no orgId refuses ?org-id, giving undefined (a 400, not a cross-tenant read) (regression guard)", () => {
    expect(resolveOrg(req({ authEnforced: true, query: { "org-id": "B" } }))).toBeUndefined();
  });

  // Mutation: moving the authEnforced refusal above the req.orgId check, so an authenticated request loses its own org.
  test("specs/ops/payment-removal.md#AC-3 resolveOrg: commercial mode + authenticated still gives the authenticated org (regression guard)", () => {
    expect(resolveOrg(req({ authEnforced: true, orgId: "A", query: { "org-id": "B" } }))).toBe("A");
  });
});
