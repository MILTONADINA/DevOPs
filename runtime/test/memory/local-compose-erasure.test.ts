import { afterEach, describe, expect, test, vi } from "vitest";
const processCalls = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: processCalls.exec, spawnSync: processCalls.spawn }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("REQ-5 reserved credential boundary", () => {
  test("reserved instance rejects generic credentials even while disabled, before Docker or spawn", async () => {
    vi.stubEnv("DEVOPS_LOCAL_INSTANCE", "erasure-api-1");
    vi.stubEnv("DEVOPS_LOCAL_PORT", "54329");
    processCalls.exec.mockReturnValue("PGRST_JWT_SECRET=synthetic-local-secret\n");
    processCalls.spawn.mockReturnValue({ status: 0 });
    const { main } = await import("../../scripts/local-compose");
    await expect(main(["with-env", "node", "-e", "unrestricted"])).rejects.toThrow(/reserved|erasure/);
    expect(processCalls.exec).not.toHaveBeenCalled();
    expect(processCalls.spawn).not.toHaveBeenCalled();
  });
  test("enabled ordinary instance refuses before secret extraction or child launch", async () => {
    vi.stubEnv("DEVOPS_LOCAL_INSTANCE", "legacy-unit");
    vi.stubEnv("DEVOPS_LOCAL_PORT", "54329");
    processCalls.exec.mockImplementation((_command, args) => (args.includes("inspect") ? "PGRST_JWT_SECRET=synthetic-local-secret\n" : '{"enabled":true}\n'));
    processCalls.spawn.mockReturnValue({ status: 0 });
    const { main } = await import("../../scripts/local-compose");
    await expect(main(["with-env", "node", "-e", "unrestricted"])).rejects.toThrow(/erasure/);
    expect(processCalls.spawn).not.toHaveBeenCalled();
    expect(processCalls.exec.mock.calls.every((call) => !call[1].includes("inspect"))).toBe(true);
  });
  test.each(["shell", "create-org", "create-api-key"])("restricted launch rejects unsupported %s selector before credentials", async (selector) => {
    vi.stubEnv("DEVOPS_LOCAL_INSTANCE", "erasure-api-1");
    vi.stubEnv("DEVOPS_LOCAL_PORT", "54329");
    const { main } = await import("../../scripts/local-compose");
    await expect(main(["erasure-launch", "absent-manifest", selector])).rejects.toThrow(/selector/);
    expect(processCalls.exec).not.toHaveBeenCalled();
    expect(processCalls.spawn).not.toHaveBeenCalled();
  });
});
