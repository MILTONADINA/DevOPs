import { expect, test } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAuditRepoRoot } from "../../src/proxy/index";

test("audit repository stays below project root without following symlink escapes", () => {
  const root = resolve(process.cwd(), "..");
  const scratch = mkdtempSync(join(root, ".workflow/state/audit-boundary-"));
  try {
    symlinkSync("/", join(scratch, "escape"));
    expect(resolveAuditRepoRoot(scratch, root)).toBe(scratch);
    expect(() => resolveAuditRepoRoot("../", root)).toThrow("outside project root");
    expect(() => resolveAuditRepoRoot(join(scratch, "escape"), root)).toThrow("symbolic link");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
