/**
 * Production webhook transport: node:http(s) with the connect pinned to an address the caller already
 * vetted. Only `lookup` sees the IP, so TLS SNI, certificate validation and the Host header all stay the
 * hostname. http.request never follows redirects, so a 3xx is returned as-is and never chased.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Transport } from "./deliver";

/** Build the transport; the response body is drained and discarded, only status + Retry-After are read. */
export function createHttpTransport(): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const pinned = req.address;
      const hostHeader = req.secure ? (req.port === 443 ? req.hostname : `${req.hostname}:${req.port}`) : req.port === 80 ? req.hostname : `${req.hostname}:${req.port}`;
      const send = req.secure ? httpsRequest : httpRequest;
      const r = send(
        {
          // Only names the connect target; `lookup` below pins the real address. The sent Host header is `hostHeader`.
          host: req.hostname,
          ...(req.secure ? { servername: req.hostname } : {}),
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
          res.resume();
          const done = (): void => resolve({ status: res.statusCode ?? 0, ...(typeof ra === "string" ? { retryAfter: ra } : {}) });
          res.once("end", done);
          res.once("error", reject);
        },
      );
      r.once("error", reject);
      r.end(req.body);
    });
}
