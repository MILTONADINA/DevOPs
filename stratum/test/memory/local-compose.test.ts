import { describe, expect, test } from "vitest";
import { assertLocalPorts, serviceJwt } from "../../scripts/local-compose";

describe("project-local Compose boundary", () => {
  test("accepts one loopback API port and no published DB or REST ports", () => {
    expect(() => assertLocalPorts({ db: {}, rest: {}, gateway: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } })).not.toThrow();
  });

  test("rejects wildcard, IPv6, and published database ports", () => {
    for (const ip of ["0.0.0.0", "::", "", "192.168.1.5"]) {
      expect(() => assertLocalPorts({ db: {}, rest: {}, gateway: { "8000/tcp": [{ HostIp: ip, HostPort: "54321" }] } })).toThrow();
    }
    expect(() => assertLocalPorts({ db: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54322" }] }, rest: {}, gateway: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } })).toThrow();
  });

  test("service token is signed for the service_role", () => {
    const token = serviceJwt("a".repeat(64), 1_800_000_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ role: "service_role", exp: 1_800_000_000 });
    expect(signature).toBeTruthy();
  });
});
