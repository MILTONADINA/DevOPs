/**
 * Billing Record Writer — Append-Only with HMAC Signing
 *
 * CRITICAL: Billing records are append-only. The Postgres
 * no_update_billing and no_delete_billing rules enforce this.
 *
 * Every record is signed with HMAC-SHA256. Any bug here has
 * financial consequences. Full test coverage required.
 * Every change requires a second reviewer.
 */

// TODO: Implement billing recorder (Phase 6)
