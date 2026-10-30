/**
 * Production webhook transport: node:http(s) with the connect pinned to an address the caller already
 * vetted. Only `lookup` sees the IP, so TLS SNI, certificate validation and the Host header all stay the
 * hostname. http.request never follows redirects, so a 3xx is returned as-is and never chased.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Transport } from "./deliver";

/** Build the transport; the attempt is judged on the status line and headers (status + Retry-After). The body is never read: the response is destroyed once they arrive, so a slow or endless body cannot hold or fail a delivery. */
export function createHttpTransport(): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const pinned = req.address;
      const hostPart = isIP(req.hostname) === 6 ? `[${req.hostname}]` : req.hostname;
      const hostHeader = req.port === (req.secure ? 443 : 80) ? hostPart : `${hostPart}:${req.port}`;
      const send = req.secure ? httpsRequest : httpRequest;
      const r = send(
        {
          // Only names the connect target; `lookup` below pins the real address. The sent Host header is `hostHeader`.
          host: req.hostname,
          // Node rejects an IP literal as a TLS server name; certificate checks then use `host` (the IP).
          ...(req.secure && isIP(req.hostname) === 0 ? { servername: req.hostname } : {}),
          // One connection per attempt: never reuse a keep-alive socket opened for an earlier attempt.
          agent: false,
          port: req.port,
          path: req.path,
          method: "POST",
          headers: { ...req.headers, host: hostHeader, "content-length": String(Buffer.byteLength(req.body)) },
          signal: req.signal,
          autoSelectFamily: false,
          lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            if (opts.all) cb(null, [{ address: pinned, family: req.family }]);
            else cb(null, pinned, req.family);
          },
        } as unknown as Parameters<typeof httpRequest>[0],
        (res) => {
          const ra = res.headers["retry-after"];
          resolve({ status: res.statusCode ?? 0, ...(typeof ra === "string" ? { retryAfter: ra } : {}) });
          // agent:false means no pooled socket to return; drop the connection instead of reading the body.
          res.destroy();
        },
      );
      r.once("error", reject);
      r.end(req.body);
    });
}
