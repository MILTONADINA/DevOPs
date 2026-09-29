// Tests for the entry-point wiring (commercialEnabled, buildStartOptions). Importing
// index.ts does NOT boot a server (the entry guard only starts when run as the entry).

import { describe, test, expect, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuildProxyOptions } from "../../src/proxy/app";
import {
  commercialEnabled,
  buildStartOptions,
  resolveListenHost,
  assertCommercialStartup,
  assertRemoteBindAllowed,
  isLoopbackBindAddress,
  usesDeprecatedHostAlias,
  resolvePort,
  resolveRateLimitMax,
  assertUpstreamAllowed,
  baseOptions,
  type ClientFactory,
} from "../../src/proxy/index";

const base = { messages: {} as never, dashboard: { readSessions: () => [] } } as unknown as BuildProxyOptions;
const fakeClient = {} as unknown as SupabaseClient;

// ===== specs/security/stratum-local-network.md — AC-4 (REQ-3: no unauthenticated remote bind) =====
//
// A test titled with the suffix " (regression guard)" already passes on the code before the change it accompanies, and a one-line comment names the mutation that makes it fail. Every test that
// passes against main 4fa5bdf carries the suffix, except the tests that exist on main under the same title.
//
// resolveListenHost returns the bind address: DEVOPS_PROXY_HOST, or the deprecated HOST alias when DEVOPS_PROXY_HOST is unset or blank. usesDeprecatedHostAlias is true whenever HOST is a non-blank
// string, whether or not DEVOPS_PROXY_HOST is also set: when both are set, DEVOPS_PROXY_HOST wins the bind value and the warning that names it is still logged. start() calls usesDeprecatedHostAlias
// to decide whether to log that warning, so resolveListenHost stays the one place that decides the bind value.
//
// assertRemoteBindAllowed takes the ALREADY-RESOLVED bind address (resolveListenHost's return value; it does not re-resolve it). It throws an Error naming the three ways forward (bind to a loopback
// address, configure auth, set DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED) when all three hold: the address is not a loopback bind address (isLoopbackBindAddress: the name "localhost", any 127.0.0.0/8
// address, "::1", or "[::1]"), commercialEnabled(env) is false (that predicate is what "auth configured" means), and DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED is not the literal string "1" (REQ-3:
// "is not `1`", so "true" does not count). Otherwise it returns undefined, or the opt-in warning text when only the opt-in allows the bind (see the opt-in warning block below). start() calls it
// before app.listen(). isLoopbackBindAddress classifies an address to bind, so it accepts more than the loopback names app.ts accepts as a Host header (the three fixed names 127.0.0.1, localhost
// and [::1], plus the configured listenHost when that is itself loopback): a different check for a different concern.
//
// The real entry point's refusal, its exit code and its message, is proved by the spawned tests in start-entrypoint.test.ts. The tests here prove the decision logic without spawning a process per case.

/** Calls `fn`; returns the thrown Error's message, or fails the test if `fn` did not throw. */
function messageFromThrow(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the function to throw, but it returned normally");
}

describe("resolveListenHost — DEVOPS_PROXY_HOST (REQ-3)", () => {
  test("DEVOPS_PROXY_HOST is read as the listen address — specs/security/stratum-local-network.md#AC-4", () => {
    expect(resolveListenHost({ DEVOPS_PROXY_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("DEVOPS_PROXY_HOST wins when HOST is also set — specs/security/stratum-local-network.md#AC-4", () => {
    expect(resolveListenHost({ DEVOPS_PROXY_HOST: "0.0.0.0", HOST: "10.0.0.5" })).toBe("0.0.0.0");
  });

  // Mutation: treating a blank or whitespace-only DEVOPS_PROXY_HOST as a literal address instead of falling through to HOST.
  test("a blank DEVOPS_PROXY_HOST falls through to HOST (regression guard) — specs/security/stratum-local-network.md#AC-4", () => {
    expect(resolveListenHost({ DEVOPS_PROXY_HOST: "   ", HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

// A URL spells an IPv6 address in brackets (`[::1]`), but Node can only listen on the bare literal: a listen call with the host "[::1]" fails with getaddrinfo ENOTFOUND.
// So `[::1]` counts as a loopback bind address (isLoopbackBindAddress) and resolveListenHost returns the bare literal, which keeps the address that passes the loopback gate
// the same address that gets bound (REQ-3).
describe("isLoopbackBindAddress — bracketed IPv6 literal (REQ-3)", () => {
  test.each(["[::1]", " [::1] ", "\t[::1]\n"])("the bracketed spelling %j of ::1 is a loopback bind address — specs/security/stratum-local-network.md#AC-4", (host) => {
    expect(isLoopbackBindAddress(host)).toBe(true);
  });

  // Mutation: removing a leading or a trailing bracket on its own, removing every enclosing pair, or matching without anchoring both ends.
  test.each(["[::1", "::1]", "[[::1]]", "[::1]:4080", "x[::1]"])("%j is NOT a loopback bind address (regression guard) — specs/security/stratum-local-network.md#AC-4", (host) => {
    expect(isLoopbackBindAddress(host)).toBe(false);
  });

  // Mutation: removing the brackets without requiring a ':' inside them.
  test.each(["[127.0.0.1]", "[localhost]"])("%j is NOT a loopback bind address (regression guard) — specs/security/stratum-local-network.md#AC-4", (host) => {
    expect(isLoopbackBindAddress(host)).toBe(false);
  });

  // Mutation: treating any bracketed IPv6 literal as loopback, folding an expanded or mapped spelling to ::1, or trimming inside the brackets.
  test.each(["[::2]", "[0:0:0:0:0:0:0:1]", "[::FFFF:127.0.0.1]", "[ ::1 ]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])(
    "%j is NOT a loopback bind address (regression guard) — specs/security/stratum-local-network.md#AC-4",
    (host) => {
      expect(isLoopbackBindAddress(host)).toBe(false);
    },
  );
});

describe("resolveListenHost — bracketed IPv6 literal (REQ-3)", () => {
  test.each(["DEVOPS_PROXY_HOST", "HOST"])("%s=[::1] is returned as ::1, the spelling Node can listen on — specs/security/stratum-local-network.md#AC-4", (name) => {
    expect(resolveListenHost({ [name]: "[::1]" })).toBe("::1");
    expect(resolveListenHost({ [name]: " [::1] " })).toBe("::1");
  });

  test.each([
    ["[::]", "::"],
    ["[::2]", "::2"],
  ])("the bracketed IPv6 literal %s is returned as %s, which is not a loopback bind address — specs/security/stratum-local-network.md#AC-4", (spelling, bare) => {
    const host = resolveListenHost({ DEVOPS_PROXY_HOST: spelling });
    expect(host).toBe(bare);
    expect(isLoopbackBindAddress(host)).toBe(false);
  });

  // Mutation: removing brackets from a value that is not wholly one bracketed IPv6 literal (an unmatched bracket, text outside the brackets, or a name, address or non-literal inside them).
  test.each(["[::1", "::1]", "[[::1]]", "[::1]:4080", "x[::1]", "[127.0.0.1]", "[localhost]", "[ ::1 ]", "[a:b]"])(
    "%j is returned as written (regression guard) — specs/security/stratum-local-network.md#AC-4",
    (value) => {
      expect(resolveListenHost({ DEVOPS_PROXY_HOST: value })).toBe(value);
      expect(resolveListenHost({ HOST: value })).toBe(value);
    },
  );
});

describe("usesDeprecatedHostAlias (REQ-3)", () => {
  // The env bag may carry DEVOPS_PROXY_HOST too: only HOST decides.
  const call = (env: { HOST?: string; DEVOPS_PROXY_HOST?: string }): boolean => usesDeprecatedHostAlias(env);

  test("HOST alone is detected as the deprecated alias — specs/security/stratum-local-network.md#AC-4", () => {
    expect(call({ HOST: "0.0.0.0" })).toBe(true);
  });

  test("DEVOPS_PROXY_HOST alone is NOT the deprecated alias — specs/security/stratum-local-network.md#AC-4", () => {
    expect(call({ DEVOPS_PROXY_HOST: "0.0.0.0" })).toBe(false);
  });

  test("both set: still detected, even though DEVOPS_PROXY_HOST wins the VALUE — specs/security/stratum-local-network.md#AC-4", () => {
    expect(call({ HOST: "0.0.0.0", DEVOPS_PROXY_HOST: "10.0.0.5" })).toBe(true);
  });

  test("neither set — specs/security/stratum-local-network.md#AC-4", () => {
    expect(call({})).toBe(false);
  });

  test("a blank HOST does not count as using the alias — specs/security/stratum-local-network.md#AC-4", () => {
    expect(call({ HOST: "   " })).toBe(false);
  });
});

describe("assertRemoteBindAllowed — the bind decision (REQ-3)", () => {
  const call = (host: string, env: Record<string, string>): void => {
    assertRemoteBindAllowed(host, env);
  };

  test.each(["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"])("loopback bind %s needs no auth or opt-in — specs/security/stratum-local-network.md#AC-4", (host) => {
    expect(() => call(host, {})).not.toThrow();
  });

  test.each(["0.0.0.0", "::", "10.0.0.5"])("a non-loopback bind %s with no auth and no opt-in refuses, naming all three ways forward — specs/security/stratum-local-network.md#AC-4", (host) => {
    const message = messageFromThrow(() => call(host, {}));
    expect(message).toMatch(/loopback/i);
    expect(message).toMatch(/auth/i);
    expect(message).toMatch(/DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED/);
  });

  test('the literal opt-in value "1" allows a non-loopback bind — specs/security/stratum-local-network.md#AC-4', () => {
    expect(() => call("0.0.0.0", { DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: "1" })).not.toThrow();
  });

  test('any other opt-in value, e.g. "true", does NOT allow it (REQ-3: "is not 1") — specs/security/stratum-local-network.md#AC-4', () => {
    const message = messageFromThrow(() => call("0.0.0.0", { DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: "true" }));
    expect(message).toMatch(/loopback/i);
  });

  test("auth configured (commercialEnabled) allows a non-loopback bind — specs/security/stratum-local-network.md#AC-4", () => {
    expect(() => call("0.0.0.0", { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).not.toThrow();
  });

  test("CQ_COMMERCIAL alone, without Supabase credentials, is NOT auth configured — specs/security/stratum-local-network.md#AC-4", () => {
    const message = messageFromThrow(() => call("0.0.0.0", { CQ_COMMERCIAL: "true" }));
    expect(message).toMatch(/loopback/i);
  });
});

// A bind that only the DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 opt-in allows makes assertRemoteBindAllowed return the warning text that start() logs (REQ-3, AC-4). A loopback bind,
// or a bind that auth allows, returns undefined; a bind nothing allows throws. The warning says what the opt-in does and nothing more: it allows the bind, and with no auth REQ-2 still answers
// 403 to any request whose Host header is not a loopback name.
describe("assertRemoteBindAllowed — the opt-in warning (REQ-3)", () => {
  const optIn = { DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: "1" };
  const auth = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" };

  test("a non-loopback bind that only the opt-in allows is allowed and yields the warning — specs/security/stratum-local-network.md#AC-4", () => {
    const warning = assertRemoteBindAllowed("0.0.0.0", optIn);
    expect(warning).toBeTypeOf("string");
    // It names the opt-in and says the opt-in only allows the bind.
    expect(warning).toContain("DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED");
    expect(warning).toMatch(/only allows/i);
    // It says a request whose Host header is not a loopback name still gets 403 (REQ-2).
    expect(warning).toMatch(/403/);
    expect(warning).toMatch(/Host header/);
    // It says another device needs auth, and that DEVOPS_PROXY_ALLOWED_HOSTS pins the Host names accepted.
    expect(warning).toContain("CQ_COMMERCIAL");
    expect(warning).toContain("DEVOPS_PROXY_ALLOWED_HOSTS");
    // It does not claim the opt-in makes the proxy reachable from other machines.
    expect(warning).not.toMatch(/reachable from other machines/i);
  });

  // Mutation: returning the warning whenever the opt-in is set, without asking whether the bind needs it.
  test.each(["127.0.0.1", "localhost", "::1"])("a loopback bind %s yields no warning, with or without the opt-in (regression guard) — specs/security/stratum-local-network.md#AC-4", (host) => {
    expect(assertRemoteBindAllowed(host, {})).toBeUndefined();
    expect(assertRemoteBindAllowed(host, optIn)).toBeUndefined();
  });

  // Mutation: returning the warning for every non-loopback bind, or whenever the opt-in is set, although auth allows the bind.
  test("a non-loopback bind that auth allows yields no warning, with or without the opt-in (regression guard) — specs/security/stratum-local-network.md#AC-4", () => {
    expect(assertRemoteBindAllowed("0.0.0.0", auth)).toBeUndefined();
    expect(assertRemoteBindAllowed("0.0.0.0", { ...auth, ...optIn })).toBeUndefined();
  });

  // Mutation: returning the warning, instead of throwing, for a bind the opt-in does not allow; or changing the refusal's opening words.
  test("a bind that nothing allows still throws the refusal instead of returning a warning (regression guard) — specs/security/stratum-local-network.md#AC-4", () => {
    expect(() => assertRemoteBindAllowed("0.0.0.0", {})).toThrow(/^Refusing to bind 0\.0\.0\.0: it is not a loopback address, and no authentication is configured\./);
    expect(() => assertRemoteBindAllowed("0.0.0.0", { DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: "true" })).toThrow(/^Refusing to bind 0\.0\.0\.0/);
  });
});

// ===== specs/security/stratum-local-network.md — AC-5 (REQ-4: numeric settings fail closed) =====
//
// resolvePort and resolveRateLimitMax are the pure checks behind REQ-4. Each takes an env bag and throws an Error when the value is invalid. start() calls both before it constructs a provider or
// database client, so an invalid PORT or RATE_LIMIT_MAX is refused at startup; start-entrypoint.test.ts spawns the real entry point for PORT=0 and RATE_LIMIT_MAX=abc. buildProxy() calls
// resolveRateLimitMax too, on its per-IP rate-limit fallback, which local-network.test.ts covers.
//   resolvePort(env): 4080 when PORT is unset; otherwise the integer from 1 to 65535 inclusive that PORT spells, else an Error naming PORT and the exact raw string it rejected.
//   resolveRateLimitMax(env): 100 when RATE_LIMIT_MAX is unset; otherwise the positive integer (>= 1) it spells, else an Error naming RATE_LIMIT_MAX and the exact raw string it rejected.
//
// PORT=70000 and PORT=x are unit-tested here rather than spawned. An out-of-range or NaN port also makes Node's own listen() fail, with a message that begins "options.port should be >= 0 and < 65536", so
// a spawn that asserted only a non-zero exit could not tell resolvePort's refusal from that failure. The tests below pin the message instead: it must match the case-sensitive, word-bounded /\bPORT\b/
// (the lowercase "options.port" does not match it) and the exact raw value. The boundary and non-numeric values are decision-logic facts, so they get no process per case.
describe("resolvePort (REQ-4)", () => {
  const call = (env: Record<string, string>): number => resolvePort(env);

  test("PORT unset defaults to 4080 — specs/security/stratum-local-network.md#AC-5", () => {
    expect(call({})).toBe(4080);
  });

  test.each(["0", "70000", "x"])("PORT=%s refuses, naming PORT and the rejected value — specs/security/stratum-local-network.md#AC-5", (value) => {
    const message = messageFromThrow(() => call({ PORT: value }));
    // Case-sensitive and word-bounded: Node's own listen() failure names the lowercase "options.port", which a case-insensitive /PORT/i would also match.
    expect(message).toMatch(/\bPORT\b/);
    // The exact raw string rejected, not a re-derived NaN or a silently truncated or coerced number.
    // Word-bounded so "0" cannot spuriously match inside an unrelated longer digit run (such as "70000",
    // a pid, or a timestamp) elsewhere in the message.
    expect(message).toMatch(new RegExp(`\\b${value}\\b`));
  });

  test("PORT=1 and PORT=65535, the inclusive range boundaries, are both accepted — specs/security/stratum-local-network.md#AC-5", () => {
    expect(call({ PORT: "1" })).toBe(1);
    expect(call({ PORT: "65535" })).toBe(65535);
  });
});

describe("resolveRateLimitMax (REQ-4)", () => {
  const call = (env: Record<string, string>): number => resolveRateLimitMax(env);

  test("RATE_LIMIT_MAX unset defaults to 100 — specs/security/stratum-local-network.md#AC-5", () => {
    expect(call({})).toBe(100);
  });

  test.each(["abc", "0"])("RATE_LIMIT_MAX=%s refuses, naming RATE_LIMIT_MAX and the rejected value — specs/security/stratum-local-network.md#AC-5", (value) => {
    const message = messageFromThrow(() => call({ RATE_LIMIT_MAX: value }));
    expect(message).toMatch(/RATE_LIMIT_MAX/);
    expect(message).toMatch(new RegExp(`\\b${value}\\b`));
  });

  test("RATE_LIMIT_MAX=1, the lower boundary ('positive' means >= 1), is accepted — specs/security/stratum-local-network.md#AC-5", () => {
    expect(call({ RATE_LIMIT_MAX: "1" })).toBe(1);
  });
});

// ===== specs/security/stratum-local-network.md — AC-6 (REQ-5: upstream transport) =====
//
// assertUpstreamAllowed(listenHost, listenPort, env, networkInterfaces?) takes the ALREADY-RESOLVED bind values (resolveListenHost's and resolvePort's return values; it does not re-resolve them) and reads
// the five REQ-5 base-URL settings (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, OPENROUTER_BASE_URL, GEMINI_BASE_URL, CQ_LOCAL_BASE_URL) and the DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM opt-in from env. start()
// calls it after assertRemoteBindAllowed and before assertCommercialStartup() and buildStartOptions() (which can construct provider or Supabase clients), so a rejected upstream setting is refused
// before any network or database connection is attempted.
//
// For each of the five base-URL settings that is a non-empty string, it throws an Error naming that variable when EITHER:
//   (a) the URL uses the "http:" protocol to a host that is not a loopback bind address (isLoopbackBindAddress) and env.DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM is not the literal string "1" (REQ-5's first
//       bullet; the same "is not `1`" wording as assertRemoteBindAllowed's opt-in); or
//   (b) it is a self-loop: its port equals listenPort AND EITHER (1) its host equals listenHost case-insensitively, OR (2) its host is a loopback bind address and listenHost is loopback or bind-all
//       ("0.0.0.0" or "::"), OR (3) listenHost is bind-all and its host is one of this machine's own interface addresses (os.networkInterfaces). Case (3) is exercised at the end of this block: those
//       tests pass a stub interface table as the optional fourth argument, so they never read this machine's real interfaces.
// Rule (b)'s refusal is unconditional: DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM does not bypass it (REQ-5's self-loop bullet states no opt-out, unlike its insecure-http bullet).
//
// The check reads the env values alone, whether or not that provider's own API key is also set: REQ-5 says "any provider base URL ... that uses plain http", with no "and is otherwise configured"
// qualifier, and AC-6's examples set no API key alongside the base URL. An "https:" URL is exempt from rule (a) but can still be a self-loop under rule (b); the https test below uses a non-loopback
// host that is not a self-loop, matching the AC's wording.
describe("assertUpstreamAllowed (REQ-5, AC-6)", () => {
  const call = (listenHost: string, listenPort: number, env: Record<string, string>, interfaces?: typeof networkInterfaces): void => {
    assertUpstreamAllowed(listenHost, listenPort, env, interfaces);
  };

  test("ANTHROPIC_BASE_URL=http://10.0.0.5:8080 (plain http, non-loopback host) refuses, naming the variable and the opt-in — specs/security/stratum-local-network.md#AC-6", () => {
    const message = messageFromThrow(() => call("127.0.0.1", 4080, { ANTHROPIC_BASE_URL: "http://10.0.0.5:8080" }));
    expect(message).toMatch(/ANTHROPIC_BASE_URL/);
    expect(message).toMatch(/DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM/);
  });

  test("the same with DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1 starts — specs/security/stratum-local-network.md#AC-6", () => {
    expect(() => call("127.0.0.1", 4080, { ANTHROPIC_BASE_URL: "http://10.0.0.5:8080", DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: "1" })).not.toThrow();
  });

  test("CQ_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 (loopback http, a different port than the listener) starts — specs/security/stratum-local-network.md#AC-6", () => {
    expect(() => call("127.0.0.1", 4080, { CQ_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" })).not.toThrow();
  });

  test("an https URL to a non-loopback host starts — specs/security/stratum-local-network.md#AC-6", () => {
    expect(() => call("127.0.0.1", 4080, { ANTHROPIC_BASE_URL: "https://10.0.0.5:8080" })).not.toThrow();
  });

  test("ANTHROPIC_BASE_URL=http://127.0.0.1:4080 with the proxy on port 4080 refuses as a self-loop (the upstream host equals the listen host) — specs/security/stratum-local-network.md#AC-6", () => {
    const message = messageFromThrow(() => call("127.0.0.1", 4080, { ANTHROPIC_BASE_URL: "http://127.0.0.1:4080" }));
    expect(message).toMatch(/ANTHROPIC_BASE_URL/);
    expect(message).toMatch(/self.?loop|listen/i);
  });

  test("a bind-all listener (0.0.0.0) treats a loopback upstream on the same port as a self-loop — specs/security/stratum-local-network.md#AC-6", () => {
    const message = messageFromThrow(() => call("0.0.0.0", 4080, { ANTHROPIC_BASE_URL: "http://127.0.0.1:4080" }));
    expect(message).toMatch(/ANTHROPIC_BASE_URL/);
    expect(message).toMatch(/self.?loop|listen/i);
  });

  test("a different port is not a self-loop, so the loopback http upstream still starts — specs/security/stratum-local-network.md#AC-6", () => {
    expect(() => call("0.0.0.0", 4080, { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" })).not.toThrow();
  });

  test("the self-loop refusal has no DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM opt-out (REQ-5's self-loop bullet states none, unlike its insecure-http bullet) — specs/security/stratum-local-network.md#AC-6", () => {
    const message = messageFromThrow(() => call("127.0.0.1", 4080, { ANTHROPIC_BASE_URL: "http://127.0.0.1:4080", DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: "1" }));
    expect(message).toMatch(/ANTHROPIC_BASE_URL/);
  });

  // A stand-in for os.networkInterfaces reporting one interface that owns `address`. The cases below use RFC 5737 documentation addresses (192.0.2.0/24), which a real interface does not
  // normally hold, so they behave the same on any machine.
  const interfaceOwning =
    (address: string): typeof networkInterfaces =>
    () => ({ en0: [{ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` }] });

  test.each(["0.0.0.0", "::"])(
    "a bind-all listener (%s) refuses an upstream on one of this machine's own interface addresses as a self-loop, even with DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1 (REQ-5) — specs/security/stratum-local-network.md#AC-6",
    (listenHost) => {
      const env = { ANTHROPIC_BASE_URL: "http://192.0.2.50:4080", DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: "1" };
      const message = messageFromThrow(() => call(listenHost, 4080, env, interfaceOwning("192.0.2.50")));
      expect(message).toMatch(/ANTHROPIC_BASE_URL/);
      expect(message).toMatch(/self-loop/);
    },
  );

  // Mutation: the bind-all case answering true for any host, without asking whether the interface list owns it.
  test("a bind-all listener does not treat an address its interface list lacks as itself (regression guard) — specs/security/stratum-local-network.md#AC-6", () => {
    const env = { ANTHROPIC_BASE_URL: "http://192.0.2.50:4080", DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: "1" };
    expect(() => call("0.0.0.0", 4080, env, interfaceOwning("192.0.2.51"))).not.toThrow();
  });

  // Mutation: dropping the bind-all condition, so any listener treats an interface address as itself.
  test("a listener that is not bind-all never treats an interface address as itself (regression guard) — specs/security/stratum-local-network.md#AC-6", () => {
    const env = { ANTHROPIC_BASE_URL: "http://192.0.2.50:4080", DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: "1" };
    expect(() => call("127.0.0.1", 4080, env, interfaceOwning("192.0.2.50"))).not.toThrow();
  });
});

// ===== specs/security/stratum-local-network.md — AC-2 (REQ-2): baseOptions carries the listen address =====
//
// baseOptions({ port, host, sessionsDir, messages }) assembles the always-on BuildProxyOptions base: the message-route deps, the dashboard's session reader, and the resolved listenPort and listenHost,
// which app.ts's Host check uses to hold a Host's port to the listening port and to accept a loopback listenHost as a Host name (REQ-2). start() builds `base` only through it. It takes `messages` as a
// parameter instead of calling createDefaultMessagesDeps() itself, which throws "no LLM provider configured" when no provider is configured, so it stays pure: start() passes
// createDefaultMessagesDeps(), and the tests below pass a stub.
describe("baseOptions (REQ-2)", () => {
  const call = (args: Parameters<typeof baseOptions>[0]): BuildProxyOptions => baseOptions(args);

  test("wires listenPort from `port` — specs/security/stratum-local-network.md#AC-2", () => {
    expect(call({ port: 4080, host: "127.0.0.1", sessionsDir: "/tmp/base-options-test-sessions", messages: {} as never }).listenPort).toBe(4080);
  });

  test("wires listenHost from `host`, and passes `messages` through unchanged — specs/security/stratum-local-network.md#AC-2", () => {
    const messages = {} as never;
    const opts = call({ port: 4080, host: "127.0.0.1", sessionsDir: "/tmp/base-options-test-sessions", messages });
    expect(opts.listenHost).toBe("127.0.0.1");
    expect(opts.messages).toBe(messages);
  });

  test("start() builds `base` only through baseOptions() (source check) — specs/security/stratum-local-network.md#AC-2", () => {
    // A regex over start()'s own body in index.ts, not a behavioral test: start() boots a real server, so nothing else in this file exercises it directly. It fails when start() builds `base` from an
    // inline `BuildProxyOptions` object literal, which would leave out listenPort and listenHost and so give REQ-2's Host check no port to compare and no listenHost to accept.
    const source = readFileSync(join(process.cwd(), "src/proxy/index.ts"), "utf8");
    const match = /export async function start\(\): Promise<void> \{([\s\S]*?)\n\}\n/.exec(source);
    expect(match, "could not locate start()'s function body in index.ts").not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/\bbaseOptions\s*\(/);
    expect(body).not.toMatch(/const base\s*:\s*BuildProxyOptions\s*=\s*\{/);
  });
});

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

describe("assertCommercialStartup", () => {
  test("requires database credentials and signing secret only for commercial runtime", () => {
    expect(() => assertCommercialStartup({})).not.toThrow();
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true" })).toThrow(/database|Supabase/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toThrow(/signing secret/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "   " })).toThrow(/signing secret/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "s" })).not.toThrow();
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "s", VERCEL: "1" })).toThrow(/ephemeral|Vercel/i);
  });
});

describe("resolveListenHost — HOST (deprecated one-release alias, REQ-3) with no DEVOPS_PROXY_HOST set", () => {
  // Mutation: a resolveListenHost that drops the HOST fallback when DEVOPS_PROXY_HOST is unset.
  test("defaults to loopback; the deprecated HOST alias still overrides (regression guard) — specs/security/stratum-local-network.md#AC-4", () => {
    expect(resolveListenHost({})).toBe("127.0.0.1"); // private by default
    expect(resolveListenHost({ HOST: "" })).toBe("127.0.0.1"); // empty ⇒ default
    expect(resolveListenHost({ HOST: "  " })).toBe("127.0.0.1"); // whitespace ⇒ default
    expect(resolveListenHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0"); // deprecated alias: still honored for one release
    expect(resolveListenHost({ HOST: " 0.0.0.0 " })).toBe("0.0.0.0"); // trimmed
  });
});

describe("buildStartOptions", () => {
  test("commercial billing wires a project-local outbox and rejects ephemeral Vercel runtime", async () => {
    mkdirSync(join(process.cwd(), "data"), { recursive: true }); // gitignored: absent in a fresh checkout
    const dir = mkdtempSync(join(process.cwd(), "data", "usage-start-test-"));
    const env = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "test-secret", CQ_USAGE_OUTBOX_DIR: dir };
    try {
      const opts = buildStartOptions(env, { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory);
      expect(opts.messages?.usageOutbox?.enqueue).toBeTypeOf("function");
      expect(opts.messages?.recordUsage).toBeUndefined();
      await opts.messages?.usageOutbox?.close();
      expect(() => buildStartOptions({ ...env, VERCEL: "1" }, { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory)).toThrow(/persistent|serverless|Vercel/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("local memory extraction is explicitly configured and rejects a non-loopback endpoint", () => {
    const messages = {} as NonNullable<BuildProxyOptions["messages"]>;
    const env = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k",
      CQ_MEMORY_EXTRACT_MODEL: "local/check", CQ_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" };
    const configured = buildStartOptions(env, { messages }, (() => fakeClient) as ClientFactory);
    expect(configured.messages?.recordMemory).toBeTypeOf("function");
    const unconfigured = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" },
      { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory);
    expect(unconfigured.messages?.recordMemory).toBeUndefined();
    expect(() => buildStartOptions({ ...env, CQ_LOCAL_BASE_URL: "https://example.com/v1" },
      { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory)).toThrow();
  });

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
    expect(opts.rateLimitByPlan).toBeDefined();
    expect(opts.messages).toBe(base.messages); // base preserved
    expect(opts.dashboard).toBe(base.dashboard);
  });

  test("Stripe webhook is wired ONLY when STRIPE_WEBHOOK_SECRET is set", () => {
    const commercial = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" };
    const without = buildStartOptions(commercial, base, (() => fakeClient) as unknown as ClientFactory);
    expect(without.stripeWebhook).toBeUndefined(); // no endpoint secret ⇒ no route

    const withSecret = buildStartOptions({ ...commercial, STRIPE_WEBHOOK_SECRET: "whsec_x" }, base, (() => fakeClient) as unknown as ClientFactory);
    expect(withSecret.stripeWebhook).toBeDefined();
    expect(withSecret.stripeWebhook?.signingSecret).toBe("whsec_x");

    // personal mode never wires it even if the secret is present
    const personal = buildStartOptions({ STRIPE_WEBHOOK_SECRET: "whsec_x" }, base, (() => fakeClient) as unknown as ClientFactory);
    expect(personal.stripeWebhook).toBeUndefined();
  });
});
