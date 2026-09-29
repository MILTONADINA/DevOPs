// Tests for specs/security/stratum-local-network.md — buildProxy()'s REQ-1 (CORS) and REQ-2 (Host)
// behavior, in personal mode and with auth configured (AC-1, AC-2, AC-3). The file also holds the
// parts of AC-5 (REQ-4: buildProxy()'s own RATE_LIMIT_MAX handling) and AC-7 (the default local
// path is still served) that are about buildProxy() itself, and the REQ-2 tests for baseOptions()
// carrying listenPort and listenHost into the real proxy, for a loopback listenHost also being an
// accepted Host name, for a malformed bracketed IPv6 Host never spoofing a loopback name, and for
// more than one Host header getting 400.
//
// A test titled with the suffix " (regression guard)" already passes on the code before the change it
// accompanies (every test that passes against main 4fa5bdf carries it), and a one-line comment names
// the mutation that makes it fail.
//
// buildProxy() registers @fastify/cors itself (`cors` defaults to true): with `{ origin: false }` in
// personal mode, and with the DEVOPS_PROXY_CORS_ORIGINS list as `origin` when auth is configured. Do
// NOT pass `cors: false` anywhere in this file: that would skip registering the plugin and swap out
// part of the behavior under test.
//
// `listenPort` and `listenHost` are `BuildProxyOptions` fields. `start()` always passes both, through
// baseOptions(); a test using `app.inject()` sets them explicitly to pin REQ-2's Definitions entry
// for a loopback name: each name with or without the listening port, and the configured
// DEVOPS_PROXY_HOST when it is itself a loopback address. In personal mode the Host NAME check
// applies in full whether or not `listenPort` is set, and only the port comparison is skipped when
// it is absent (see "a request with no Host header at all", which omits it on purpose). With auth
// configured any Host is accepted unless DEVOPS_PROXY_ALLOWED_HOSTS is set.
//
// DEVOPS_PROXY_CORS_ORIGINS / DEVOPS_PROXY_ALLOWED_HOSTS are read directly from
// `process.env` (mirroring how buildProxy reads RATE_LIMIT_MAX), NOT as buildProxy options — set per
// test below and cleared in afterEach.

import { describe, test, expect, afterEach, vi } from "vitest";
import net, { type AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { createCaptureStore } from "../../src/proxy/capture";
import type { ApiKeyResolver } from "../../src/proxy/auth";
import type { MessagesDeps, ForwardResult, TokenCountResult } from "../../src/proxy/forward";

// Same opt-out as test/proxy/app.test.ts + auth.test.ts: test/setup.ts mocks
// `fastify` globally (for the capture-session handler tests); these tests need
// the REAL Fastify + the REAL @fastify/cors so app.inject() and the CORS
// plugin's actual behavior are both exercised.
vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");

// The proxy's default port (resolvePort's default in runtime/src/proxy/network-settings.ts)
// and the port every worked example in the spec itself uses.
const LISTEN_PORT = 4080;

// "Auth configured" per the spec's own Definitions section: buildProxy is given
// `auth.resolve`. Every test below hits the public /health path (registerAuth's
// default `publicPaths`), so the key never actually needs to resolve.
const authResolve: ApiKeyResolver = () => Promise.resolve(null);

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  delete process.env["DEVOPS_PROXY_CORS_ORIGINS"];
  delete process.env["DEVOPS_PROXY_ALLOWED_HOSTS"];
  delete process.env["RATE_LIMIT_MAX"]; // AC-5 (REQ-4): both RATE_LIMIT_MAX-setting describe blocks below rely on this
});

/**
 * Send raw bytes over a TCP socket to a real listener started from `server`, and resolve with the
 * response's status code and body text. Used for request shapes `app.inject()` cannot produce at
 * all — light-my-request builds `rawHeaders` by iterating `Object.keys()` of a plain `headers`
 * object (node_modules/light-my-request/lib/request.js), which structurally cannot hold the same
 * header name twice, and it ALWAYS synthesizes `headers.host` — `this.headers.host =
 * this.headers.host || options.authority || hostHeaderFromURL(parsedURL)` — even when `headers: {
 * host: "" }` is passed, since an empty string is falsy and falls through to the default
 * (`localhost:80`). Both `statusForRequestWithNoHostHeader` (no Host at all) and the
 * duplicate-Host-header tests below need a genuine socket for exactly this reason.
 *
 * @param server - a not-yet-listening instance from buildProxy(); this
 *   function listens on an ephemeral loopback port and closes it afterward.
 * @param requestText - the full raw request (request line + headers + trailing blank line, CRLF
 *   already applied).
 */
async function rawRequest(server: FastifyInstance, requestText: string): Promise<{ status: number; body: string }> {
  await server.listen({ port: 0, host: "127.0.0.1" });
  try {
    const { port } = server.server.address() as AddressInfo;
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let raw = "";
      let settled = false;

      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(requestText);
      });

      const timer = setTimeout(() => {
        settled = true;
        socket.destroy();
        reject(new Error(`timed out waiting for a response; received so far: ${JSON.stringify(raw)}`));
      }, 2_000);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const headEnd = raw.indexOf("\r\n\r\n");
        const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
        const body = headEnd === -1 ? "" : raw.slice(headEnd + 4);
        const statusLine = head.split("\r\n")[0] ?? "";
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
        if (!match?.[1]) {
          reject(new Error(`no HTTP status line in response: ${JSON.stringify(raw)}`));
          return;
        }
        resolve({ status: Number(match[1]), body });
      };

      socket.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await server.close();
  }
}

/**
 * Send a real HTTP/1.0 request with NO `Host` header over a raw TCP socket, and resolve with the
 * response's status code. A genuine HTTP/1.1 request missing `Host` fares no better over a real
 * socket either: Node's OWN http server rejects it with its own 400 Bad Request BEFORE Fastify's
 * hooks ever run (verified against this checkout's Node — do not "modernize" this to HTTP/1.1; that
 * stops testing REQ-2 and starts testing Node's parser instead). HTTP/1.0 has no such requirement,
 * so Node dispatches it through to Fastify with a genuinely `undefined` `req.headers.host` — the one
 * path that reaches the proxy's own Host check. See {@link rawRequest} for why a real socket is
 * needed at all.
 *
 * @param server - a not-yet-listening instance from buildProxy(); this
 *   function listens on an ephemeral loopback port and closes it afterward.
 * @param path - the request path (e.g. "/health").
 */
async function statusForRequestWithNoHostHeader(server: FastifyInstance, path: string): Promise<number> {
  const { status } = await rawRequest(server, `GET ${path} HTTP/1.0\r\nConnection: close\r\n\r\n`);
  return status;
}

describe("REQ-1 CORS default — no auth configured (specs/security/stratum-local-network.md#AC-1)", () => {
  test("a CORS preflight from a foreign Origin is refused with no Access-Control-Allow-Origin — specs/security/stratum-local-network.md#AC-1", async () => {
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    // A preflight per the spec's own definition: OPTIONS carrying BOTH Origin
    // AND Access-Control-Request-Method. The Host is loopback + on-port so a
    // 403 here is attributable to REQ-1 alone, not to REQ-2's Host check.
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
        host: `localhost:${LISTEN_PORT}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a simple GET carrying a foreign Origin is still served, with no Access-Control-Allow-Origin header — specs/security/stratum-local-network.md#AC-1", async () => {
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    // Preflight-vs-simple split (REQ-1: a preflight is an OPTIONS request
    // carrying both Origin and Access-Control-Request-Method): a plain GET
    // carrying an Origin is NOT a preflight, so REQ-1 does not refuse the
    // request itself — it only withholds the header a browser needs to read
    // the response cross-origin. One test, two checks: the 200 shows the
    // request is served, the missing header shows no origin is allowed.
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example", host: `localhost:${LISTEN_PORT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("REQ-2 Host default — no auth configured (specs/security/stratum-local-network.md#AC-2)", () => {
  test("a non-loopback Host is refused before routing — specs/security/stratum-local-network.md#AC-2", async () => {
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `evil.example:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: a Host check that drops the bracketed IPv6 literal from the loopback names, or that requires a port even for the portless form REQ-2's Definitions entry allows.
  test.each(["127.0.0.1:4080", "localhost:4080", "[::1]:4080", "localhost"])(
    "Host %s on the listening port is accepted (regression guard) — specs/security/stratum-local-network.md#AC-2",
    async (host) => {
      app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/health", headers: { host } });
      expect(res.statusCode).toBe(200);
    },
  );

  test("a loopback Host whose port does not match the listening port is refused — specs/security/stratum-local-network.md#AC-2", async () => {
    // REQ-2's Definitions entry allows a loopback name "with or without the
    // listening port": once `listenPort` is set, a present port must equal
    // it, even though the NAME (127.0.0.1) is a valid loopback name on its own.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:9999" } });
    expect(res.statusCode).toBe(403);
  });

  test("a request with no Host header at all is refused — specs/security/stratum-local-network.md#AC-2", async () => {
    // `listenPort` is deliberately OMITTED here: when it is unset, the Host
    // NAME check still applies in full and only the port comparison is
    // skipped — this test is entirely about the missing NAME, not about a
    // port. Not assigned to the shared `app` (closed by the
    // top-level afterEach): the helper already listens + closes it itself, and
    // closing an already-closed Fastify instance a second time is needless risk.
    const localApp = buildProxy({ rateLimit: false });
    const status = await statusForRequestWithNoHostHeader(localApp, "/health");
    expect(status).toBe(403);
  });

  test("a loopback-looking non-canonical address (127.0.0.2) is refused on the default bind — specs/security/stratum-local-network.md#AC-2", async () => {
    // REQ-2's Definitions entry for a loopback name is the three fixed names
    // (127.0.0.1, localhost, [::1]) PLUS the configured listenHost's own literal
    // when that literal is itself loopback — not the whole 127.0.0.0/8 block —
    // so a 127.0.0.2 Host must be refused on the default (127.0.0.1) bind. No
    // `listenHost` is passed here, which is the default bind, so only the three
    // fixed names are accepted and 127.0.0.2 is correctly refused. The
    // "listenHost extends the loopback allow-list" block below covers the case
    // where listenHost itself IS 127.0.0.2.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `127.0.0.2:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(403);
  });
});

// A malformed bracketed-IPv6 Host must never collapse to the bare bracket form and spoof a valid
// loopback name (REQ-2: without auth only a loopback name is accepted). Each malformed case is run
// twice — once with listenPort unset, once with it set — because splitHostPort parses the NAME
// independently of whether a port is even being compared: a malformed remainder has to keep the
// whole original string as the name in both configurations.
describe("REQ-2 splitHostPort — a malformed bracketed IPv6 Host never spoofs a bare loopback name, listenPort unset — specs/security/stratum-local-network.md#AC-2", () => {
  test.each(["[::1]:abc", "[::1]:9999:x", "[::1]x", "[::1]:"])(
    "Host %s is refused — specs/security/stratum-local-network.md#AC-2",
    async (host) => {
      // A mutation in splitHostPort's bracketed branch that discards a malformed remainder and returns
      // just the bracket-only `{ name }` ("[::1]") instead of `{ name: host }` when the remainder isn't
      // exactly `:<digits>` lets isLoopbackHost see the bare loopback name, so the request gets 200
      // instead of 403 and this test fails.
      app = buildProxy({ rateLimit: false });
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/health", headers: { host } });
      expect(res.statusCode).toBe(403);
    },
  );

  // Mutation: a splitHostPort malformed-remainder fallback that returns anything but the whole Host as the name (for example an empty name), which also rejects the well-formed, portless [::1].
  test("Host [::1] is accepted (regression guard) — specs/security/stratum-local-network.md#AC-2", async () => {
    // A portless `[::1]` has an empty remainder (rest === ""), which takes the same fallback branch
    // as a malformed remainder; there name === host, since there is no trailing text at all.
    app = buildProxy({ rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "[::1]" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("REQ-2 splitHostPort — a malformed bracketed IPv6 Host never spoofs a bare loopback name, listenPort set — specs/security/stratum-local-network.md#AC-2", () => {
  test.each(["[::1]:abc", "[::1]:9999:x", "[::1]x", "[::1]:"])(
    "Host %s is refused with listenPort set — specs/security/stratum-local-network.md#AC-2",
    async (host) => {
      // Same check as the listenPort-unset run above; repeated here because the malformed Host must
      // also be refused with the port-equality rule active, not only when the port comparison is skipped.
      app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/health", headers: { host } });
      expect(res.statusCode).toBe(403);
    },
  );

  // Mutation: a splitHostPort malformed-remainder fallback that returns anything but the whole Host as the name (for example an empty name), which also rejects the well-formed, portless [::1].
  test("Host [::1] is accepted with listenPort set (regression guard) — specs/security/stratum-local-network.md#AC-2", async () => {
    // Same reason as the unset-listenPort case above: the portless `[::1]` takes the fallback branch.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "[::1]" } });
    expect(res.statusCode).toBe(200);
  });

  // Mutation: treating a well-formed `[addr]:<digits>` remainder like a malformed one, so the whole Host, port included, becomes the name and is not a loopback name.
  test(`Host [::1]:${LISTEN_PORT} is accepted with listenPort set (regression guard) — specs/security/stratum-local-network.md#AC-2`, async () => {
    // The well-formed `[addr]:<digits>` branch and the malformed-remainder fallback are separate
    // branches of splitHostPort; this pins the well-formed one.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `[::1]:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(200);
  });
});

// REQ-2 (RFC 9112 §3.2): a request carrying more than one Host header line is refused with 400,
// independent of mode and of which of the two values a loopback-name check would have picked. Needs a
// real socket (see rawRequest's own doc): app.inject() cannot represent two Host header lines at all.
describe("REQ-2 duplicate Host headers are refused in every mode — specs/security/stratum-local-network.md#AC-2 (duplicate Host headers)", () => {
  test.each([
    ["loopback first", "localhost", "evil.example"],
    ["foreign first", "evil.example", "localhost"],
  ])(
    "two Host header lines (%s) get 400, not whatever req.headers.host's own folding would have produced — specs/security/stratum-local-network.md#AC-2 (duplicate Host headers)",
    async (_order, first, second) => {
      // Node's http parser folds a repeated Host header in req.headers.host down to the FIRST Host
      // line, discarding the second, so a hook that read only req.headers.host would serve the
      // loopback-first order with 200 (Node keeps "localhost", a valid loopback name) instead of RFC
      // 9112 §3.2's required 400. A mutation that reads req.headers.host instead of counting
      // req.raw.rawHeaders, or that matches the header name case-sensitively ("Host" vs "host"), lets a
      // duplicate-Host request through with something other than 400 + invalid_host, failing this test.
      const localApp = buildProxy({ rateLimit: false });
      const { status, body } = await rawRequest(localApp, `GET /health HTTP/1.1\r\nHost: ${first}\r\nHost: ${second}\r\nConnection: close\r\n\r\n`);
      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({
        type: "error",
        error: { type: "invalid_host", message: "Request has more than one Host header." },
      });
    },
  );

  // An OPTIONS preflight (Origin plus Access-Control-Request-Method) whose request carries two Host header lines.
  const preflightWithTwoHostLines = "OPTIONS /health HTTP/1.1\r\nHost: localhost\r\nHost: evil.example\r\nOrigin: https://app.example\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n";

  test("an OPTIONS preflight with two Host header lines gets 400 invalid_host when auth is configured, even from a listed Origin — specs/security/stratum-local-network.md#AC-2 (duplicate Host headers)", async () => {
    // With auth configured, @fastify/cors answers a preflight itself with 204 as soon as its own
    // onRequest hook runs, so this 400 reaches a preflight only because buildProxy() registers its Host
    // hook before the plugin. The Origin is listed in DEVOPS_PROXY_CORS_ORIGINS, so the plugin would
    // accept this preflight.
    process.env["DEVOPS_PROXY_CORS_ORIGINS"] = "https://app.example";
    const localApp = buildProxy({ rateLimit: false, auth: { resolve: authResolve } });
    const { status, body } = await rawRequest(localApp, preflightWithTwoHostLines);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({
      type: "error",
      error: { type: "invalid_host", message: "Request has more than one Host header." },
    });
  });

  test("an OPTIONS preflight with two Host header lines gets 400 invalid_host in personal mode (regression guard) — specs/security/stratum-local-network.md#AC-2 (duplicate Host headers)", async () => {
    // A mutation that reads req.headers.host (Node keeps only its first value) instead of counting req.raw.rawHeaders sees one loopback Host and answers 403 forbidden_origin.
    const localApp = buildProxy({ rateLimit: false });
    const { status, body } = await rawRequest(localApp, preflightWithTwoHostLines);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({
      type: "error",
      error: { type: "invalid_host", message: "Request has more than one Host header." },
    });
  });
});

describe("baseOptions + buildProxy — the real start() wiring (REQ-2)", () => {
  test("Host: localhost:<listenPort> is accepted and any other port is refused, once buildProxy runs directly over baseOptions()'s own output — specs/security/stratum-local-network.md#AC-2", async () => {
    // baseOptions() is the only place start() builds its BuildProxyOptions base from, and it carries
    // listenPort and listenHost, so REQ-2's port rule holds in the real proxy and not only in tests
    // that set listenPort themselves. Dynamic import, matching this file's own `buildProxy` import above.
    const { baseOptions } = await import("../../src/proxy/index");
    const opts = baseOptions({ port: LISTEN_PORT, host: "127.0.0.1", sessionsDir: "/tmp/base-options-local-network-test", messages: {} as never });
    app = buildProxy({ ...opts, rateLimit: false });
    await app.ready();

    const wrongPort = await app.inject({ method: "GET", url: "/health", headers: { host: "localhost:9999" } });
    expect(wrongPort.statusCode).toBe(403);

    const rightPort = await app.inject({ method: "GET", url: "/health", headers: { host: `localhost:${LISTEN_PORT}` } });
    expect(rightPort.statusCode).toBe(200);
  });
});

describe("listenHost extends the loopback allow-list (REQ-2)", () => {
  // Mutation: never adding the configured listenHost's own name to the loopback allow-list.
  test('listenHost "127.0.0.2": Host: 127.0.0.2:<listenPort> is accepted (regression guard) — specs/security/stratum-local-network.md#AC-2', async () => {
    // REQ-2's Definitions entry: a configured loopback DEVOPS_PROXY_HOST is also an accepted Host
    // name, so a Host naming the CONFIGURED bind address is accepted even though 127.0.0.2 is not one
    // of the three fixed names.
    app = buildProxy({ listenPort: LISTEN_PORT, listenHost: "127.0.0.2", rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `127.0.0.2:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(200);
  });

  // Mutation: widening acceptance to the whole 127.0.0.0/8 block instead of the exact listenHost literal.
  test('listenHost "127.0.0.1" adds nothing new: Host: 127.0.0.2:<listenPort> stays refused (regression guard) — specs/security/stratum-local-network.md#AC-2', async () => {
    // listenHost 127.0.0.1 is already one of the three fixed names, so it adds nothing and 127.0.0.2
    // stays refused.
    app = buildProxy({ listenPort: LISTEN_PORT, listenHost: "127.0.0.1", rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `127.0.0.2:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: accepting the listenHost literal without gating on isLoopbackBindAddress(listenHost), loopback or not.
  test('listenHost "0.0.0.0" is not itself loopback, so it adds nothing: Host: 0.0.0.0:<listenPort> stays refused (regression guard) — specs/security/stratum-local-network.md#AC-2', async () => {
    app = buildProxy({ listenPort: LISTEN_PORT, listenHost: "0.0.0.0", rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `0.0.0.0:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: replacing the three fixed loopback names with the raw listenHost literal, which for ::1 never equals the bracketed Host spelling [::1].
  test.each(["localhost", "::1"])(
    "listenHost %s behaves as before: the fixed name already accepted it (regression guard) — specs/security/stratum-local-network.md#AC-2",
    async (listenHost) => {
      // LOOPBACK_HOST_NAMES already contains "localhost" and "[::1]" independent of listenHost, so
      // setting listenHost to either changes nothing here.
      const hostHeaderName = listenHost === "::1" ? "[::1]" : listenHost;
      app = buildProxy({ listenPort: LISTEN_PORT, listenHost, rateLimit: false });
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/health", headers: { host: `${hostHeaderName}:${LISTEN_PORT}` } });
      expect(res.statusCode).toBe(200);
    },
  );
});

describe("auth configured — Host + CORS (specs/security/stratum-local-network.md#AC-3)", () => {
  // Mutation: a Host check that ignores REQ-2's auth-configured branch ("WHERE auth is configured, THE PROXY SHALL accept any Host") and refuses non-loopback Hosts even when `auth.resolve` is supplied.
  test("a foreign Host is accepted when auth is configured and no allow-list is set (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `evil.example:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(200);
  });

  test("an Origin not listed in DEVOPS_PROXY_CORS_ORIGINS gets no Access-Control-Allow-Origin — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_CORS_ORIGINS"] = "https://allowed.example";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://not-listed.example", host: `localhost:${LISTEN_PORT}` },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("an Origin listed in DEVOPS_PROXY_CORS_ORIGINS gets its own origin echoed back — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_CORS_ORIGINS"] = "https://allowed.example";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://allowed.example", host: `localhost:${LISTEN_PORT}` },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example");
  });

  // Mutation: an empty DEVOPS_PROXY_CORS_ORIGINS list falling back to `true` or `'*'`, parseCommaList(undefined) returning `undefined` instead of `[]`, or the plugin's preflight handling turned off in auth mode (`preflight: false`).
  test("DEVOPS_PROXY_CORS_ORIGINS unset: a preflight from a foreign Origin gets no Access-Control-Allow-Origin, and a simple GET with that Origin is still served without it (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    // With auth configured, buildProxy() (app.ts) registers @fastify/cors with
    // `{ origin: parseCommaList(process.env["DEVOPS_PROXY_CORS_ORIGINS"]) }`, and `parseCommaList(undefined)`
    // returns `[]` (an empty array, not `undefined` or `false`). @fastify/cors 10.1.0's own
    // `isRequestOriginAllowed` walks an array and returns `false` for every origin when the array is empty
    // (node_modules/@fastify/cors/index.js), so REQ-1's "allow only the origins listed in
    // DEVOPS_PROXY_CORS_ORIGINS (... empty by default)" follows from `parseCommaList` plus the library's own
    // empty-array semantics; nothing special-cases the unset value. `strictPreflight` (default true) sees
    // both required preflight headers present, so the plugin answers the preflight itself with its own
    // default `optionsSuccessStatus` (204). That 204 is asserted explicitly, not just the missing header: a
    // 404 or a 500 also lacks Access-Control-Allow-Origin, so the header check alone would pass on a broken
    // preflight.
    //
    // The three mutations above fail this test in different ways. The first makes
    // Access-Control-Allow-Origin appear on both requests. The second makes BOTH requests get 500: an
    // `origin: undefined` option is falsy, and @fastify/cors's own `addCorsHeadersHandler` rejects it as
    // `Error('Invalid CORS origin option')` (the preflight's 204 assertion trips first). The third sends the
    // OPTIONS to the plugin's own catch-all `OPTIONS *` route, which answers 404 — also with no
    // Access-Control-Allow-Origin, so only the 204 assertion tells it apart from the intended outcome.
    //
    // DEVOPS_PROXY_CORS_ORIGINS is deliberately never set here — this test is about it being UNSET,
    // distinct from the two sibling tests above that set it. The shared afterEach (top of file) already
    // deletes it after every test, so no earlier test in this run can leak it into this one, whatever the
    // run order within this file. A value already exported in the shell BEFORE the run is not cleared here.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://any.example",
        "access-control-request-method": "GET",
        host: `localhost:${LISTEN_PORT}`,
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    const simple = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://any.example", host: `localhost:${LISTEN_PORT}` },
    });
    expect(simple.statusCode).toBe(200);
    expect(simple.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("DEVOPS_PROXY_ALLOWED_HOSTS refuses a Host that is not on the list — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "other.lan" } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: an allow-list check that fails closed even for its own listed entries, for example requiring the listening port on a Host when the entry carries none, or treating a parsed list as empty ("nothing allowed").
  test("DEVOPS_PROXY_ALLOWED_HOSTS accepts a Host that IS on the list (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan" } });
    expect(res.statusCode).toBe(200);
  });

  test("a CORS preflight from a listed Origin is refused when its Host is not on DEVOPS_PROXY_ALLOWED_HOSTS and answered when its Host is — specs/security/stratum-local-network.md#AC-3", async () => {
    // With auth configured, @fastify/cors answers a preflight itself, with 204 and the listed origin
    // in Access-Control-Allow-Origin, as soon as its own onRequest hook runs. REQ-2's Host allow-list
    // therefore refuses a preflight only because buildProxy() registers its Host hook before the
    // plugin. Both requests carry the listed Origin, so the Host is the only difference between them.
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    process.env["DEVOPS_PROXY_CORS_ORIGINS"] = "https://app.example";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const preflightHeaders = { origin: "https://app.example", "access-control-request-method": "POST" };

    const foreignHost = await app.inject({ method: "OPTIONS", url: "/health", headers: { ...preflightHeaders, host: "evil.example" } });
    expect(foreignHost.statusCode).toBe(403);
    expect(foreignHost.json().error.type).toBe("forbidden_host");
    expect(foreignHost.headers["access-control-allow-origin"]).toBeUndefined();

    const listedHost = await app.inject({ method: "OPTIONS", url: "/health", headers: { ...preflightHeaders, host: `proxy.lan:${LISTEN_PORT}` } });
    expect(listedHost.statusCode).toBe(204);
    expect(listedHost.headers["access-control-allow-origin"]).toBe("https://app.example");
  });

  // REQ-2's DEVOPS_PROXY_ALLOWED_HOSTS matching follows a port rule: an entry
  // that carries its own port matches only that exact host+port; a portless
  // entry matches a Host with no port or on the listening port, and refuses
  // any other port; entries and Hosts are compared case-insensitively with one
  // trailing dot stripped from each side. The DEVOPS_PROXY_ALLOWED_HOSTS tests
  // above for a Host that is off the list and a Host that is on it only
  // exercise a portless entry against a portless host. The tests below cover
  // the rest: a port-carrying entry (accepted on its own port, refused on
  // another port and with no port), a portless entry on the listening port and
  // on any other port, and the case-insensitive and trailing-dot comparison
  // rules.

  // Mutation: matching every entry with the portless rule (a Host with no port, or with the listening port), so an entry's own port is ignored.
  test("DEVOPS_PROXY_ALLOWED_HOSTS: an entry with its own port matches only that exact host+port (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan:8443";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan:8443" } });
    expect(res.statusCode).toBe(200);
  });

  test("DEVOPS_PROXY_ALLOWED_HOSTS: an entry with its own port refuses the same host on a different port — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan:8443";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan:9999" } });
    expect(res.statusCode).toBe(403);
  });

  test("DEVOPS_PROXY_ALLOWED_HOSTS: an entry with its own port refuses the same host with no port at all — specs/security/stratum-local-network.md#AC-3", async () => {
    // An entry with its own port matches only that exact host and port — a
    // portless Host is not treated as an implicit match to the entry's own port.
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan:8443";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan" } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: a portless entry matching only a Host that carries no port, dropping the comparison with the listening port.
  test("DEVOPS_PROXY_ALLOWED_HOSTS: a portless entry accepts that host on the listening port (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `proxy.lan:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(200);
  });

  test("DEVOPS_PROXY_ALLOWED_HOSTS: a portless entry refuses that host on any other port — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan:9999" } });
    expect(res.statusCode).toBe(403);
  });

  // Mutation: not lowercasing the DEVOPS_PROXY_ALLOWED_HOSTS entries before they are compared with the (already lowercased) Host.
  test("DEVOPS_PROXY_ALLOWED_HOSTS matches its entry case-insensitively (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "Proxy.LAN";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan" } });
    expect(res.statusCode).toBe(200);
  });

  // Mutation: not stripping a trailing dot from the request's Host name before comparing it with an entry.
  test("DEVOPS_PROXY_ALLOWED_HOSTS matches a Host with one trailing dot stripped (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan." } });
    expect(res.statusCode).toBe(200);
  });

  // Mutation: not stripping a trailing dot from the allow-list entry's name before comparing it with the Host.
  test("DEVOPS_PROXY_ALLOWED_HOSTS matches an entry with one trailing dot against a Host with none (regression guard) — specs/security/stratum-local-network.md#AC-3", async () => {
    // The prior test puts the dot on the Host side; this one puts it on the
    // entry side instead, so stripping one trailing dot from both sides is
    // pinned on both operands, not just the Host operand the other test covers.
    process.env["DEVOPS_PROXY_ALLOWED_HOSTS"] = "proxy.lan.";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, auth: { resolve: authResolve } });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: "proxy.lan" } });
    expect(res.statusCode).toBe(200);
  });
});

// AC-5 (REQ-4: numeric settings fail closed), the parts that are about buildProxy() (app.ts) itself.
// The startup refusal (an invalid RATE_LIMIT_MAX / PORT must make start() exit non-zero) is a
// start()-level (index.ts) concern, proven by the resolvePort/resolveRateLimitMax pure-function tests
// in start-options.test.ts and the spawned entry-point tests in start-entrypoint.test.ts, not here.
// Two pieces are proven here. (1) The explicit-opts.rateLimit bypass, in the describe block just
// below: buildProxy() calls resolveRateLimitMax (network-settings.ts) only on its per-IP fallback
// branch, taken when opts.rateLimit is omitted (neither `false` nor a number) and
// opts.rateLimitByPlan is not set, so a numeric opts.rateLimit never reads RATE_LIMIT_MAX at all —
// which the (regression guard) test right below proves. (2) The fallback itself, in the describe
// block after that one: buildProxy() validates RATE_LIMIT_MAX on that fallback branch, so a caller
// that skips start() gets the same refusal a full boot gets.
describe("REQ-4 numeric settings — buildProxy() opts.rateLimit is untouched by RATE_LIMIT_MAX (specs/security/stratum-local-network.md#AC-5)", () => {
  // Mutation: validating RATE_LIMIT_MAX in buildProxy() unconditionally, before checking whether opts.rateLimit is already an explicit number.
  test("an explicit numeric opts.rateLimit is used as-is even when RATE_LIMIT_MAX is invalid (regression guard) — specs/security/stratum-local-network.md#AC-5", async () => {
    // buildProxy()'s own rate-limit branch (`typeof opts.rateLimit === "number" ? opts.rateLimit :
    // resolveRateLimitMax(process.env)`, runtime/src/proxy/app.ts) never reads RATE_LIMIT_MAX once
    // opts.rateLimit is already a number, which is the `rateLimit` option's contract in
    // BuildProxyOptions when `rateLimitByPlan` is not set: a number sets the max requests per window
    // and bypasses RATE_LIMIT_MAX entirely. The mutation above makes this call throw. x-ratelimit-limit is
    // @fastify/rate-limit's own default response header (v10.3.0: `addHeaders["x-ratelimit-limit"]`
    // is `true` by default, see node_modules/@fastify/rate-limit/index.js), set to the exact `max`
    // value the plugin was given — the most direct, observable proof of which number actually
    // reached it.
    process.env["RATE_LIMIT_MAX"] = "abc";
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: 5 });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health", headers: { host: `localhost:${LISTEN_PORT}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
  });
});

// REQ-4 at buildProxy() itself. buildProxy()'s per-IP rate-limit fallback — reached when
// opts.rateLimit is omitted (neither `false` nor a number) and opts.rateLimitByPlan is not set —
// calls resolveRateLimitMax(process.env), so an invalid value throws at buildProxy() itself: a
// caller that builds a personal-shaped app directly and skips start() entirely (for example a test
// built on `app.inject()` that passes no `rateLimit`) gets the same REQ-4 refusal a full
// `npm run dev` boot gets. @fastify/rate-limit does not reject an invalid `max` itself (a NaN `max`
// falls back to its own default), so the refusal has to come from buildProxy(); the spec's own
// Problem section names the bug: "RATE_LIMIT_MAX=abc turns the rate limiter off, because the value
// parses to NaN." A team-mode app (`rateLimitByPlan`) never reaches this fallback: the org's plan
// sets its limit and RATE_LIMIT_MAX is not read.
describe("REQ-4 numeric settings — buildProxy()'s own RATE_LIMIT_MAX fallback fails closed — specs/security/stratum-local-network.md#AC-5", () => {
  test('RATE_LIMIT_MAX="abc" with no opts.rateLimit makes buildProxy() itself throw, naming RATE_LIMIT_MAX and the rejected value — specs/security/stratum-local-network.md#AC-5', () => {
    // opts.rateLimit is deliberately OMITTED — neither `false` (which would skip this whole block,
    // like most other tests in this file) nor an explicit number (which would take the OTHER branch
    // of the same conditional, the one the (regression guard) test just above pins as bypassing
    // RATE_LIMIT_MAX) — and no `rateLimitByPlan` is passed either. buildProxy() is synchronous and
    // throws synchronously from inside this branch, before ever returning an instance — no
    // `await app.ready()` needed, and `app` (the shared, afterEach-closed variable) is deliberately
    // left unassigned: the throw aborts the assignment.
    process.env["RATE_LIMIT_MAX"] = "abc"; // cleared by the shared afterEach above either way
    expect(() => buildProxy({ listenPort: LISTEN_PORT })).toThrow(/RATE_LIMIT_MAX[^\n]*abc/);
  });
});

// AC-7 — the spec's own "Goal" section, restated as an acceptance criterion: the literal default
// local path (an AI client on the same machine, no new settings) must still be served end-to-end.
// AC-7's OTHER half — the root `npm run setup` smoke boot + `tests/setup-local.test.mjs` — is
// proved against the ROOT `node --test` suite (out of this vitest file's scope) and is not
// repeated here.
describe("REQ-1 + REQ-2 — the default local path is still served (specs/security/stratum-local-network.md#AC-7)", () => {
  // Mutation: a Host check that refuses `localhost:<listenPort>` itself (dropping "localhost" from LOOPBACK_HOST_NAMES, or breaking isLoopbackHost's port-equality comparison), CORS refusing a POST that carries no Origin, or the duplicate-Host check over-firing on a single, well-formed Host header.
  test("a POST /v1/messages with no Origin header and Host: localhost:4080, against an injected fake upstream, is served (regression guard) — specs/security/stratum-local-network.md#AC-7", async () => {
    // The injected fake upstream AC-7 calls for, with no real network: `forward` never touches axios
    // or a real socket — it resolves a canned 200 directly. `forwardCalls` proves the response
    // actually came from THIS route reaching the fake upstream, not a coincidental early 200 (e.g.
    // REQ-2's Host check wrongly no-op'ing and something else answering first).
    //
    // The Host check accepts localhost on the listening port (this test sets listenPort, so it
    // exercises the positive port path), and CORS never refuses a request that never carried an
    // Origin. Each mutation above makes this test fail:
    //   - a Host check that wrongly rejects `localhost:<listenPort>` itself (e.g. dropping "localhost"
    //     from LOOPBACK_HOST_NAMES, or breaking isLoopbackHost's port-equality comparison so a matching
    //     port reads as non-matching);
    //   - CORS that refuses a POST carrying no Origin header at all (over-firing the no-auth "refuse
    //     cross-origin" branch onto a request that was never cross-origin, instead of refusing only an
    //     actual preflight — OPTIONS + Origin + Access-Control-Request-Method);
    //   - the duplicate-Host-header check (hasDuplicateHostHeader), which runs BEFORE the
    //     loopback-name check in the same onRequest hook: if it over-fires on this test's single,
    //     well-formed Host header (e.g. miscounting req.raw.rawHeaders) it returns 400 before the
    //     loopback allow-list is ever consulted.
    let forwardCalls = 0;
    const forward: MessagesDeps["forward"] = async (): Promise<ForwardResult> => {
      forwardCalls++;
      return {
        status: 200,
        data: {
          id: "msg_ac7_fake",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 10, output_tokens: 3 },
          stop_reason: "end_turn",
        },
      };
    };
    const countTokens: MessagesDeps["countTokens"] = async (): Promise<TokenCountResult> => ({
      input_tokens: 10,
      token_count_method: "exact",
      message_breakdown: [{ role: "user", token_count: 10 }],
    });
    const capture = createCaptureStore({
      sessionId: "ac7-default-path-session",
      outputFile: "/tmp/ac7-default-path-session.json",
      // CaptureFs needs only writeFileSync; AC-7 is about the response reaching the client, not
      // about what capture writes, so this is a no-op rather than messages.test.ts's recording fake.
      fs: { writeFileSync: () => undefined },
    });
    const deps: MessagesDeps = { forward, countTokens, capture, apiKey: "sk-test-ac7" };

    // Personal mode is exactly `opts.auth` omitted ("auth configured" === `opts.auth !==
    // undefined`, the same presence check the file's other describe blocks use) — no auth, no
    // DEVOPS_PROXY_CORS_ORIGINS/DEVOPS_PROXY_ALLOWED_HOSTS (afterEach clears both). `listenPort`
    // matches the Host header's port exactly, per REQ-2's Definitions entry for a loopback name.
    app = buildProxy({ listenPort: LISTEN_PORT, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      // Deliberately NO origin header — a command-line client sends none (the spec's own Goal
      // section). Host is the loopback name on the listening port, the worked default-path example.
      headers: { host: `localhost:${LISTEN_PORT}` },
      payload: {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("msg_ac7_fake");
    expect(forwardCalls).toBe(1);
  });
});
