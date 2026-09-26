// PB-66: operator scripts must not report success when they could not reach a database.
// create-org, create-api-key and api-keys used to print SKIPPED and exit 0 with no
// SUPABASE_URL/SUPABASE_SERVICE_KEY, so automation read a no-op as success.
import { describe, test, expect, vi, afterEach } from "vitest";

const SAVED = { url: process.env["SUPABASE_URL"], key: process.env["SUPABASE_SERVICE_KEY"], dotenv: process.env["DOTENV_CONFIG_PATH"] };
afterEach(() => {
  if (SAVED.url === undefined) delete process.env["SUPABASE_URL"]; else process.env["SUPABASE_URL"] = SAVED.url;
  if (SAVED.key === undefined) delete process.env["SUPABASE_SERVICE_KEY"]; else process.env["SUPABASE_SERVICE_KEY"] = SAVED.key;
  if (SAVED.dotenv === undefined) delete process.env["DOTENV_CONFIG_PATH"]; else process.env["DOTENV_CONFIG_PATH"] = SAVED.dotenv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Each script runs `import "dotenv/config"` on load, which would refill the deleted settings from a
// developer's stratum/.env and send a real request (PB-75). Point dotenv at a file that does not exist,
// and make any network call fail the test, so no machine's .env can reach a database from here.
async function runWithoutDatabase(load: () => Promise<{ main: (argv: string[]) => Promise<number> }>, argv: string[]) {
  delete process.env["SUPABASE_URL"];
  delete process.env["SUPABASE_SERVICE_KEY"];
  process.env["DOTENV_CONFIG_PATH"] = "/nonexistent/operator-scripts-config.env";
  const fetchCalls: unknown[] = [];
  vi.stubGlobal("fetch", (...args: unknown[]) => {
    fetchCalls.push(args[0]);
    return Promise.reject(new Error("network is disabled in this test"));
  });
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  const code = await (await load()).main(argv);
  expect(fetchCalls).toEqual([]);
  return { code, output: lines.join("") };
}

describe("operator scripts without database settings", () => {
  test("create-org exits 2 and says nothing was created", async () => {
    const { code, output } = await runWithoutDatabase(() => import("../../scripts/create-org"), ["--name", "Acme"]);
    expect(code).toBe(2);
    expect(output).toMatch(/SUPABASE_URL/);
    expect(output).toMatch(/nothing was created/i);
    expect(output).not.toMatch(/SKIPPED/);
  });

  test("create-api-key exits 2 and says nothing was created", async () => {
    const { code, output } = await runWithoutDatabase(() => import("../../scripts/create-api-key"), ["--org-id", "11111111-1111-1111-1111-111111111111", "--name", "ci"]);
    expect(code).toBe(2);
    expect(output).toMatch(/nothing was created/i);
  });

  test("api-keys exits 2 and says nothing was listed or revoked", async () => {
    const { code, output } = await runWithoutDatabase(() => import("../../scripts/api-keys"), ["--org-id", "11111111-1111-1111-1111-111111111111", "--list"]);
    expect(code).toBe(2);
    expect(output).toMatch(/nothing was listed or revoked/i);
  });
});
