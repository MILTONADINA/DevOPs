/**
 * Supabase Client Singleton
 *
 * Provides a configured Supabase client for Tier 2 warm memory
 * and billing record storage.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Returns the shared Supabase client instance.
 * @returns Configured Supabase client
 * @throws {Error} If SUPABASE_URL or SUPABASE_SERVICE_KEY is not set
 */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment");
  }

  client = createClient(url, key);
  return client;
}
