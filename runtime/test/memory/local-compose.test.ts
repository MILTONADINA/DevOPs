import { describe, expect, test } from "vitest";
import { assertLocalPorts, dockerFailureDetail, resolveLocalStackConfig, retryRateLimited, serviceJwt } from "../../scripts/local-compose";

describe("project-local Compose boundary", () => {
  test("isolated verification instance has distinct names and loopback port", () => {
    const primary = resolveLocalStackConfig({});
    expect(primary.project).toBe("devops-stratum-compose");
    expect(primary.names.db).toBe("devops-stratum-local-db");
    expect(primary.port).toBe("54321");
    const isolated = resolveLocalStackConfig({ DEVOPS_LOCAL_INSTANCE: "coldmac", DEVOPS_LOCAL_PORT: "54322" });
    expect(isolated.project).toBe("devops-stratum-isolated-coldmac");
    expect(isolated.names.db).toBe("devops-stratum-isolated-coldmac-db");
    expect(isolated.port).toBe("54322");
    expect(() => assertLocalPorts({ db: {}, rest: {}, gateway: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54322" }] } }, isolated.port)).not.toThrow();
  });

  test("isolated verification rejects incomplete or unsafe override pairs", () => {
    for (const env of [
      { DEVOPS_LOCAL_INSTANCE: "coldmac" },
      { DEVOPS_LOCAL_PORT: "54322" },
      { DEVOPS_LOCAL_INSTANCE: "../escape", DEVOPS_LOCAL_PORT: "54322" },
      { DEVOPS_LOCAL_INSTANCE: "local", DEVOPS_LOCAL_PORT: "54322" },
      { DEVOPS_LOCAL_INSTANCE: "coldmac", DEVOPS_LOCAL_PORT: "54321" },
      { DEVOPS_LOCAL_INSTANCE: "coldmac", DEVOPS_LOCAL_PORT: "054322" },
      { DEVOPS_LOCAL_INSTANCE: "coldmac", DEVOPS_LOCAL_PORT: "0" },
    ]) expect(() => resolveLocalStackConfig(env)).toThrow();
  });
  test("classifies registry throttling without leaking Docker stderr", () => {
    expect(dockerFailureDetail("toomanyrequests: Rate exceeded; secret-token-value")).toBe("public registry rate limit");
    expect(dockerFailureDetail("HTTP 429 Too Many Requests; secret-token-value")).toBe("public registry rate limit");
    expect(dockerFailureDetail("unknown Docker failure; secret-token-value")).toBe("docker command failed");
  });

  test("retries registry throttling twice and fails other errors immediately", async () => {
    let calls = 0;
    const delays: number[] = [];
    await retryRateLimited(() => {
      calls++;
      if (calls < 3) throw new Error("public registry rate limit");
    }, async (ms) => { delays.push(ms); });
    expect(calls).toBe(3);
    expect(delays).toEqual([2000, 4000]);

    calls = 0;
    await expect(retryRateLimited(() => { calls++; throw new Error("port in use"); }, async () => { throw new Error("unexpected delay"); })).rejects.toThrow("port in use");
    expect(calls).toBe(1);

    calls = 0;
    await expect(retryRateLimited(() => { calls++; throw new Error("public registry rate limit"); }, async () => {})).rejects.toThrow("public registry rate limit");
    expect(calls).toBe(3);
  });
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
