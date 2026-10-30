// Webhook egress hardening: resolve once, vet every address, pin the connect, never follow redirects.
// No real network: a stub resolver + fake transport for deliverWebhook, and a loopback server for the real transport.

import { describe, test, expect, afterEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { deliverWebhook, isSafeWebhookUrl, type DeliveryDeps, type TransportRequest } from "../../src/webhooks/deliver";
import { createHttpTransport } from "../../src/webhooks/transport";
import { SIGNATURE_HEADER, signWebhook } from "../../src/webhooks/sign";

const SECRET = "whsec_test_please_rotate_32chars_min";

function harness(answer: Array<{ address: string; family: number }> | Error | "hang", status: number | Error = 200, retryAfter?: string) {
  const lookups: string[] = [];
  const requests: TransportRequest[] = [];
  const deps: DeliveryDeps = {
    lookup: (host) => {
      lookups.push(host);
      if (answer === "hang") return new Promise(() => undefined);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    transport: (req) => {
      requests.push(req);
      return status instanceof Error ? Promise.reject(status) : Promise.resolve({ status, ...(retryAfter !== undefined ? { retryAfter } : {}) });
    },
  };
  return { deps, lookups, requests };
}
const PUB = [{ address: "93.184.216.34", family: 4 }];

describe("deliverWebhook: resolve once, vet every address, pin", () => {
  test("lookup once per attempt; the transport gets exactly the vetted address and the hostname", async () => {
    const h = harness(PUB);
    const r = await deliverWebhook("https://hook.example:8443/cq?x=1", '{"a":1}', SECRET, h.deps);
    expect(r).toMatchObject({ delivered: true, status: 200, retryable: false });
    expect(h.lookups).toEqual(["hook.example"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ hostname: "hook.example", address: "93.184.216.34", family: 4, port: 8443, path: "/cq?x=1", body: '{"a":1}' });
    expect(h.requests[0]!.headers[SIGNATURE_HEADER]).toBe(signWebhook('{"a":1}', SECRET));
    expect(h.requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  test.each([
    ["169.254.169.254", [{ address: "169.254.169.254", family: 4 }]],
    ["public then private", [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]],
    ["private then public", [{ address: "127.0.0.1", family: 4 }, { address: "93.184.216.34", family: 4 }]],
    ["mapped string", [{ address: "::ffff:127.0.0.1", family: 6 }]],
    ["mapped hex", [{ address: "::ffff:a9fe:a9fe", family: 6 }]],
    ["nat64", [{ address: "64:ff9b::7f00:1", family: 6 }]],
    ["6to4", [{ address: "2002:0a00:0001::", family: 6 }]],
    ["teredo", [{ address: "2001:0:4136:e378:8000:63bf:3fff:fdd2", family: 6 }]],
    ["cgnat", [{ address: "100.64.0.1", family: 4 }]],
    ["unspecified", [{ address: "0.0.0.0", family: 4 }]],
    ["broadcast", [{ address: "255.255.255.255", family: 4 }]],
    ["ula", [{ address: "fd00::1", family: 6 }]],
    ["link-local v6", [{ address: "fe80::1", family: 6 }]],
    ["multicast v6", [{ address: "ff02::1", family: 6 }]],
    ["garbage", [{ address: "not-an-ip", family: 4 }]],
  ])("hostname resolving to %s is refused and never connected", async (_n, answer) => {
    const h = harness(answer);
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, h.deps);
    expect(r).toMatchObject({ delivered: false, retryable: false, reasonClass: "ssrf_blocked" });
    expect(h.requests).toHaveLength(0);
  });
  test("DNS rebinding: a second answer is never consulted; transport gets the first (public) answer", async () => {
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    let calls = 0;
    const requests: TransportRequest[] = [];
    const deps: DeliveryDeps = {
      lookup: () => Promise.resolve(answers[Math.min(calls++, 1)]!),
      transport: (req) => {
        requests.push(req);
        return Promise.resolve({ status: 200 });
      },
    };
    await deliverWebhook("https://rebind.example/h", "{}", SECRET, deps);
    expect(calls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.address).toBe("93.184.216.34");
  });
  test("lookup returns [] -> refused, transport never called", async () => {
    const h = harness([]);
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, h.deps);
    expect(r).toMatchObject({ delivered: false, reasonClass: "ssrf_blocked", retryable: false });
    expect(h.requests).toHaveLength(0);
  });
  test("lookup throws -> refused as a retryable network failure, transport never called", async () => {
    const h = harness(new Error("ENOTFOUND"));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, h.deps);
    expect(r).toMatchObject({ delivered: false, reasonClass: "network", retryable: true });
    expect(h.requests).toHaveLength(0);
  });
  test("a hanging lookup is aborted at timeoutMs", async () => {
    const h = harness("hang");
    const t0 = Date.now();
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, h.deps, 50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ delivered: false, reasonClass: "timeout", retryable: true });
    expect(h.requests).toHaveLength(0);
  });
  test.each([
    "http://hook.example:0/", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://172.16.0.1/x", "http://192.168.0.1/x", "http://169.254.169.254/x", "http://[::1]/x", "http://[fc00::1]/x",
    "http://[::ffff:127.0.0.1]/x", "http://[::ffff:7f00:1]/x", "http://[::127.0.0.1]/x", "http://[64:ff9b::7f00:1]/x", "http://[2002:0a00:0001::]/x", "http://100.64.0.1/x",
    "http://0.0.0.0/x", "http://255.255.255.255/x", "http://[ff02::1]/x", "http://LOCALHOST/x", "http://localhost./x", "http://a.localhost/x", "http://2130706433/x",
    "ftp://hook.example/x", "file:///etc/passwd", "data:text/plain,hi", "https://user:pw@hook.example/x", "not a url",
  ])("literal or odd URL %s is refused with no lookup and no connect", async (url) => {
    const h = harness(PUB);
    const r = await deliverWebhook(url, "{}", SECRET, h.deps);
    expect(r).toMatchObject({ delivered: false, retryable: false, reasonClass: "ssrf_blocked" });
    expect(h.lookups).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(isSafeWebhookUrl(url).ok).toBe(false);
  });
  test.each([
    [200, true, undefined, false],
    [302, false, "redirect", false],
    [307, false, "redirect", false],
    [308, false, "redirect", false],
    [400, false, "http_4xx", false],
    [401, false, "http_4xx", false],
    [403, false, "http_4xx", false],
    [404, false, "http_4xx", false],
    [410, false, "http_4xx", false],
    [429, false, "http_429", true],
    [500, false, "http_5xx", true],
    [503, false, "http_5xx", true],
  ])("status %i -> delivered=%s class=%s retryable=%s", async (status, delivered, cls, retryable) => {
    const h = harness(PUB, status);
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, h.deps);
    expect(r.delivered).toBe(delivered);
    expect(r.retryable).toBe(retryable);
    expect(r.reasonClass).toBe(cls);
    expect(r.status).toBe(status);
  });
  test("transport error -> retryable network; abort -> timeout", async () => {
    const a = await deliverWebhook("https://hook.example/x", "{}", SECRET, harness(PUB, new Error("ECONNRESET")).deps);
    expect(a).toMatchObject({ delivered: false, retryable: true, reasonClass: "network" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const b = await deliverWebhook("https://hook.example/x", "{}", SECRET, harness(PUB, abort).deps);
    expect(b).toMatchObject({ delivered: false, retryable: true, reasonClass: "timeout" });
  });
  test("Retry-After is parsed (seconds, HTTP-date) and bad values are ignored", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const run = async (v: string) => (await deliverWebhook("https://hook.example/x", "{}", SECRET, { ...harness(PUB, 429, v).deps, now: () => now })).retryAfterMs;
    expect(await run("120")).toBe(120_000);
    expect(await run("Thu, 01 Jan 2026 00:01:00 GMT")).toBe(60_000);
    expect(await run("Wed, 31 Dec 2025 00:00:00 GMT")).toBe(0);
    expect(await run("-5")).toBeUndefined();
    expect(await run("garbage")).toBeUndefined();
    expect(await run("")).toBeUndefined();
  });
});

describe("deliverWebhook: IPv6 literal URL", () => {
  test("https://[2600::1]/x reaches the transport with the unbracketed address", async () => {
    const h = harness(PUB);
    await deliverWebhook("https://[2600::1]/x", "{}", SECRET, h.deps);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.hostname).toBe("2600::1");
    expect(h.requests[0]!.address).toBe("2600::1");
  });
});

describe("deliverWebhook: failover across vetted addresses", () => {
  const V6A = "2606:4700::1", V6B = "2606:4700::2", V4A = "93.184.216.34", V4B = "93.184.216.35";
  const a = (address: string) => ({ address, family: address.includes(":") ? 6 : 4 });
  const connectErr = (code: string, connectStage = true) => Object.assign(new Error(code), { code, connectStage });
  function multi(answer: string[], respond: (req: TransportRequest, i: number) => Promise<{ status: number }>) {
    const requests: TransportRequest[] = [];
    const deps: DeliveryDeps = {
      lookup: () => Promise.resolve(answer.map(a)),
      transport: (req) => {
        requests.push(req);
        return respond(req, requests.length - 1);
      },
    };
    return { deps, requests };
  }
  test("first address connect-refused, second answers: delivered, tried v6 then v4", async () => {
    const m = multi([V6A, V4A], (_r, i) => (i === 0 ? Promise.reject(connectErr("ECONNREFUSED")) : Promise.resolve({ status: 200 })));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(r).toMatchObject({ delivered: true, status: 200 });
    expect(m.requests.map((q) => q.address)).toEqual([V6A, V4A]);
    expect(m.requests.every((q) => q.hostname === "hook.example")).toBe(true);
  });
  test("families are interleaved in verbatim order, duplicates dropped, all refused -> retryable network", async () => {
    const m = multi([V6A, V6B, V4A, V4B, V6A], () => Promise.reject(connectErr("ECONNREFUSED")));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(m.requests.map((q) => q.address)).toEqual([V6A, V4A, V6B, V4B]);
    expect(r).toMatchObject({ delivered: false, retryable: true, reasonClass: "network", reason: "delivery failed" });
    expect(r.reason).not.toContain(V6A);
  });
  test.each(["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"])("connect-stage %s fails over", async (code) => {
    const m = multi([V6A, V4A], (_r, i) => (i === 0 ? Promise.reject(connectErr(code)) : Promise.resolve({ status: 204 })));
    expect((await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps)).delivered).toBe(true);
    expect(m.requests).toHaveLength(2);
  });
  test("an error without the connect-stage tag (ECONNRESET) does not fail over", async () => {
    const m = multi([V6A, V4A], () => Promise.reject(connectErr("ECONNRESET", false)));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(m.requests).toHaveLength(1);
    expect(r).toMatchObject({ delivered: false, reasonClass: "network", retryable: true });
  });
  test("a connect-tagged but non-allowlisted code (EPROTO) does not fail over", async () => {
    const m = multi([V6A, V4A], () => Promise.reject(connectErr("EPROTO")));
    await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(m.requests).toHaveLength(1);
  });
  test("a first response, even a 500, ends the attempt", async () => {
    const m = multi([V6A, V4A], () => Promise.resolve({ status: 500 }));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(m.requests).toHaveLength(1);
    expect(r).toMatchObject({ reasonClass: "http_5xx", retryable: true });
  });
  test("a hanging first transport times out the whole attempt and the second address is never tried", async () => {
    const m = multi([V6A, V4A], () => new Promise(() => undefined));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps, 60);
    expect(r).toMatchObject({ delivered: false, reasonClass: "timeout", retryable: true });
    expect(m.requests).toHaveLength(1);
  });
  test("each address gets a connect deadline of the remaining budget divided by the addresses left", async () => {
    const m = multi([V6A, V4A], (_r, i) => (i === 0 ? Promise.reject(connectErr("ETIMEDOUT")) : Promise.resolve({ status: 200 })));
    await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps, 10_000);
    const [first, second] = m.requests.map((q) => q.connectTimeoutMs!);
    expect(first).toBeGreaterThan(4000);
    expect(first).toBeLessThanOrEqual(5000);
    expect(second).toBeGreaterThan(first!);
    expect(second).toBeLessThanOrEqual(10_000);
  });
  test("only vetted addresses reach the transport; a mixed answer still connects nowhere", async () => {
    const m = multi([V6A, "10.0.0.5", V4A], () => Promise.resolve({ status: 200 }));
    const r = await deliverWebhook("https://hook.example/x", "{}", SECRET, m.deps);
    expect(r.reasonClass).toBe("ssrf_blocked");
    expect(m.requests).toHaveLength(0);
  });
  test("an IP literal is a single attempt", async () => {
    const m = multi([V4A], () => Promise.reject(connectErr("ECONNREFUSED")));
    const r = await deliverWebhook("https://[2600::1]/x", "{}", SECRET, m.deps);
    expect(m.requests).toHaveLength(1);
    expect(r.reasonClass).toBe("network");
  });
});

describe("real transport: connect-stage tagging", () => {
  test("a closed loopback port rejects ECONNREFUSED tagged connect-stage", async () => {
    const s = createServer();
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((res) => s.close(() => res()));
    const err = await createHttpTransport()({
      hostname: "hook.test", address: "127.0.0.1", family: 4, port, path: "/", secure: false, headers: {}, body: "{}", signal: new AbortController().signal,
    }).then(() => null, (e: unknown) => e as NodeJS.ErrnoException & { connectStage?: boolean });
    expect(err?.code).toBe("ECONNREFUSED");
    expect(err?.connectStage).toBe(true);
  });
});

describe("POST /v1/webhooks/test failover", () => {
  test("delivers when the first address refuses the connection", async () => {
    const { createSupabaseWebhookDeps } = await import("../../src/proxy/routes/webhooks");
    const tried: string[] = [];
    const client = { from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [{ webhook_url: "https://api.customer.com/cq", webhook_secret: "whsec_s" }], error: null }) }) }) }) };
    const deps = createSupabaseWebhookDeps(client as never, {
      lookup: () => Promise.resolve([{ address: "2606:4700::1", family: 6 }, { address: "93.184.216.34", family: 4 }]),
      transport: (req) => {
        tried.push(req.address);
        return tried.length === 1 ? Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED", connectStage: true })) : Promise.resolve({ status: 200 });
      },
    });
    const r = await deps.deliver("https://api.customer.com/cq", "{}", "whsec_s");
    expect(r).toMatchObject({ delivered: true });
    expect(tried).toEqual(["2606:4700::1", "93.184.216.34"]);
  });
});

describe("real transport (loopback fixture, no OS DNS)", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });
  async function start(handler: (headers: IncomingHttpHeaders, body: string, url: string) => { status: number; headers?: Record<string, string> }) {
    const seen: Array<{ headers: IncomingHttpHeaders; body: string; url: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ headers: req.headers, body, url: req.url ?? "" });
        const r = handler(req.headers, body, req.url ?? "");
        res.writeHead(r.status, r.headers).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return { port: addr.port, seen };
  }
  const base = (port: number): TransportRequest => ({
    hostname: "hook.test", address: "127.0.0.1", family: 4, port, path: "/cq?a=b", secure: false,
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: "sha256=abc" }, body: '{"k":1}', signal: new AbortController().signal,
  });

  test("connects to the pinned address while Host stays the hostname", async () => {
    const f = await start(() => ({ status: 204 }));
    const r = await createHttpTransport()(base(f.port));
    expect(r.status).toBe(204);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.headers.host).toBe(`hook.test:${f.port}`);
    expect(f.seen[0]!.body).toBe('{"k":1}');
    expect(f.seen[0]!.url).toBe("/cq?a=b");
    expect(f.seen[0]!.headers[SIGNATURE_HEADER]).toBe("sha256=abc");
  });
  test("a 2xx whose body never ends is judged on the status line and headers, not the body", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.write("partial");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const r = await deliverWebhook(
      `http://hook.test:${addr.port}/cq`,
      "{}",
      SECRET,
      { lookup: async () => PUB, transport: (q) => createHttpTransport()({ ...q, address: "127.0.0.1" }) },
      500,
    );
    // A timeout would give delivered:false with reasonClass "timeout", so this
    // proves the body was not awaited without a wall-clock bound.
    expect(r).toMatchObject({ delivered: true, status: 200 });
    server.closeAllConnections();
  });
  test.each([302, 307, 308])("a %i redirect to an internal target is not followed (exactly one request)", async (code) => {
    const f = await start(() => ({ status: code, headers: { location: "http://127.0.0.1:1/internal" } }));
    const r = await createHttpTransport()(base(f.port));
    expect(r.status).toBe(code);
    expect(f.seen).toHaveLength(1);
  });
  test("an https request to an IP-literal host does not set a TLS server name (no ERR_INVALID_ARG_VALUE)", async () => {
    const f = await start(() => ({ status: 200 }));
    server!.removeAllListeners("connection");
    server!.on("connection", (sock) => sock.destroy());
    const err = await createHttpTransport()({ ...base(f.port), hostname: "127.0.0.1", secure: true }).then(
      () => null,
      (e: unknown) => e as NodeJS.ErrnoException,
    );
    expect(err).not.toBeNull();
    expect(err!.code).not.toBe("ERR_INVALID_ARG_VALUE");
    expect((err as { connectStage?: boolean }).connectStage).not.toBe(true); // post-connect failure: never fail over
  });
  test("an IPv6-literal host keeps its brackets in the Host header", async () => {
    let host = "";
    const v6 = createServer((req, res) => {
      host = req.headers.host ?? "";
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      v6.once("error", reject);
      v6.listen(0, "::1", resolve);
    });
    try {
      const port = (v6.address() as { port: number }).port;
      await createHttpTransport()({ ...base(port), hostname: "::1", address: "::1", family: 6 });
      expect(host).toBe(`[::1]:${port}`);
    } finally {
      v6.close();
    }
  });
  test("each attempt opens its own connection (no keep-alive reuse of an earlier socket)", async () => {
    const f = await start(() => ({ status: 204 }));
    let conns = 0;
    server!.on("connection", () => conns++);
    await createHttpTransport()(base(f.port));
    await createHttpTransport()(base(f.port));
    expect(conns).toBe(2);
  });
  test("returns the Retry-After header and aborts on the signal", async () => {
    const f = await start(() => ({ status: 429, headers: { "retry-after": "7" } }));
    expect((await createHttpTransport()(base(f.port))).retryAfter).toBe("7");
    const ac = new AbortController();
    ac.abort();
    await expect(createHttpTransport()({ ...base(f.port), signal: ac.signal })).rejects.toThrow();
  });
});
