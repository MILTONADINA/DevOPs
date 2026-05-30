// Tests for the entry-point wiring (commercialEnabled, buildStartOptions). Importing
// index.ts does NOT boot a server (the entry guard only starts when run as the entry).

import { describe, test, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuildProxyOptions } from "../../src/proxy/app";
import { commercialEnabled, buildStartOptions, type ClientFactory } from "../../src/proxy/index";

const base = { messages: {} as never, dashboard: { readSessions: () => [] } } as unknown as BuildProxyOptions;
const fakeClient = {} as unknown as SupabaseClient;

describe("commercialEnabled", () => {
  test("requires BOTH the flag and Supabase creds", () => {
    expect(commercialEnabled({})).toBe(false);
    expect(commercialEnabled({ CQ_COMMERCIAL: "true" })).toBe(false); // flag, no creds
    expect(commercialEnabled({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(true);
    expect(commercialEnabled({ CQ_COMMERCIAL: "1", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(true);
    expect(commercialEnabled({ CQ_COMMERCIAL: "false", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(false);
    expect(commercialEnabled({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "" })).toBe(false); // empty key
  });
});

describe("buildStartOptions", () => {
  test("personal mode: returns only the base; never constructs a client", () => {
    const makeClient = vi.fn() as unknown as ClientFactory;
    const opts = buildStartOptions({}, base, makeClient);
    expect(opts.messages).toBe(base.messages);
    expect(opts.auth).toBeUndefined();
    expect(opts.config).toBeUndefined();
    expect(opts.memory).toBeUndefined();
    expect(opts.billing).toBeUndefined();
    expect(opts.sessions).toBeUndefined();
    expect(makeClient).not.toHaveBeenCalled();
  });

  test("commercial mode: builds the client ONCE and wires auth(/v1)+config+memory+billing+sessions", () => {
    const makeClient = vi.fn(() => fakeClient);
    const opts = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" }, base, makeClient as unknown as ClientFactory);
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledWith("u", "k");
    expect(opts.auth?.protectedPrefixes).toEqual(["/v1/"]);
    expect(opts.config).toBeDefined();
    expect(opts.memory).toBeDefined();
    expect(opts.billing).toBeDefined();
    expect(opts.sessions).toBeDefined();
    expect(opts.webhooks).toBeDefined();
    expect(opts.tokens).toBeDefined();
    expect(opts.messages).toBe(base.messages); // base preserved
    expect(opts.dashboard).toBe(base.dashboard);
  });
});
