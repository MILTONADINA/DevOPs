/**
 * Tier-2 session / organization resolver (Phase 3 / v0.5.x).
 *
 * The warm-memory adapter (tier2.ts) requires a {@link PersistContext} of REAL
 * foreign keys — a `sessions(id)` row and the `organizations(id)` that owns it —
 * because the fact tables enforce both as NOT NULL FKs. Nothing else mints those
 * rows. This resolver does: create-or-get an org, open a session (carrying the
 * dial params the session ran under), and close it.
 *
 * It is the trusted, server-side half of the forgery-prevention model in ADR-0012:
 * the FKs come from here (the server), never from model-derived fact content.
 *
 * Built on the same injectable-client seam as tier2.ts: a Supabase client is
 * passed in (real service-role client in prod; a fake in tests). The live SQL is
 * separately exercised by scripts/verify-tier2.ts (gated on SUPABASE_SERVICE_KEY).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Parameters for opening a session row. */
export interface CreateSessionInput {
  /** Owning organizations(id). */
  orgId: string;
  /** Model the session targets (e.g. "claude-opus-4-8"). NOT NULL in the schema. */
  model: string;
  /** Temporal-decay λ this session ran under (default 0.97 in the schema). */
  lambda?: number;
  /** Gain shift g (default 0.0). */
  gainShift?: number;
  /** Gain threshold θ (default 1.0). */
  theta?: number;
}

export interface SessionStore {
  /**
   * Create-or-get an organization by name, returning its id.
   *
   * @param name - the organization name (matched exactly).
   * @returns the existing or newly-created organizations(id).
   * @throws {Error} if the select or insert fails.
   */
  ensureOrg(name: string): Promise<string>;
  /**
   * Open a session row.
   *
   * @param input - owning org + model + optional dial params.
   * @returns the new sessions(id).
   * @throws {Error} if the insert fails.
   */
  createSession(input: CreateSessionInput): Promise<string>;
  /**
   * Mark a session ended (sets ended_at = now).
   *
   * @param sessionId - the sessions(id) to close.
   * @throws {Error} if the update fails.
   */
  endSession(sessionId: string): Promise<void>;
}

export interface SessionStoreOptions {
  /** Clock for ended_at (ISO). Default new Date().toISOString(). */
  now?: () => string;
}

/**
 * Create a session/org resolver over a Supabase client.
 *
 * @param client - a configured Supabase client (service-role key; bypasses RLS).
 * @param opts - injectable clock.
 * @returns a {@link SessionStore}.
 */
export function createSessionStore(client: SupabaseClient, opts: SessionStoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async ensureOrg(name: string): Promise<string> {
      // NOTE: organizations has no UNIQUE(name) constraint, so this select-then-
      // insert is best-effort create-or-get (a concurrent double-create could make
      // two orgs with the same name). Acceptable for the single-tenant dev path;
      // a UNIQUE(name) + upsert is the multi-tenant hardening (tracked with PB-31).
      const existing = await client.from("organizations").select("id").eq("name", name).limit(1);
      if (existing.error) throw new Error(`ensureOrg select failed: ${existing.error.message}`);
      const rows = (existing.data ?? []) as { id: string }[];
      const first = rows[0];
      if (first) return first.id;

      const created = await client.from("organizations").insert({ name }).select("id").single();
      if (created.error || !created.data) throw new Error(`ensureOrg insert failed: ${created.error?.message ?? "no row returned"}`);
      return (created.data as { id: string }).id;
    },

    async createSession(input: CreateSessionInput): Promise<string> {
      const row: Record<string, unknown> = { org_id: input.orgId, model: input.model };
      if (input.lambda !== undefined) row["lambda"] = input.lambda;
      if (input.gainShift !== undefined) row["gain_shift"] = input.gainShift;
      if (input.theta !== undefined) row["theta"] = input.theta;

      const created = await client.from("sessions").insert(row).select("id").single();
      if (created.error || !created.data) throw new Error(`createSession failed: ${created.error?.message ?? "no row returned"}`);
      return (created.data as { id: string }).id;
    },

    async endSession(sessionId: string): Promise<void> {
      const res = await client.from("sessions").update({ ended_at: now() }).eq("id", sessionId);
      if (res.error) throw new Error(`endSession failed: ${res.error.message}`);
    },
  };
}
