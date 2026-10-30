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
  test.each([302, 307, 308])("a %i redirect to an internal target is not followed (exactly one request)", async (code) => {
    const f = await start(() => ({ status: code, headers: { location: "http://127.0.0.1:1/internal" } }));
    const r = await createHttpTransport()(base(f.port));
    expect(r.status).toBe(code);
    expect(f.seen).toHaveLength(1);
  });
  test("returns the Retry-After header and aborts on the signal", async () => {
    const f = await start(() => ({ status: 429, headers: { "retry-after": "7" } }));
    expect((await createHttpTransport()(base(f.port))).retryAfter).toBe("7");
    const ac = new AbortController();
    ac.abort();
    await expect(createHttpTransport()({ ...base(f.port), signal: ac.signal })).rejects.toThrow();
  });
});
