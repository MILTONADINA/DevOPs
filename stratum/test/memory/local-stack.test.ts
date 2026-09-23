import { describe, expect, test } from "vitest";
import { startLocalStack } from "../../scripts/start-local-stack";

type Call = { command: string; args: string[] };

function fakeRunner(hostIp: string): { run: (command: string, args: string[]) => string; calls: Call[] } {
  const calls: Call[] = [];
  const run = (command: string, args: string[]): string => {
    calls.push({ command, args });
    if (command === "docker" && args[0] === "network") return JSON.stringify({ "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" });
    if (command === "docker" && args[0] === "inspect") return JSON.stringify({ "5432/tcp": [{ HostIp: hostIp, HostPort: "54322" }] });
    return "";
  };
  return { run, calls };
}

describe("local Supabase startup boundary", () => {
  test("accepts loopback port bindings", () => {
    const { run, calls } = fakeRunner("127.0.0.1");
    startLocalStack(run);
    expect(calls.filter((c) => c.command === "docker" && c.args[0] === "inspect")).toHaveLength(2);
    expect(calls.some((c) => c.command === "supabase" && c.args[0] === "stop")).toBe(false);
  });

  test("stops the project stack when Docker publishes on all interfaces", () => {
    const { run, calls } = fakeRunner("");
    expect(() => startLocalStack(run)).toThrow(/non-loopback/);
    expect(calls.some((c) => c.command === "supabase" && c.args[0] === "stop")).toBe(true);
  });
});
