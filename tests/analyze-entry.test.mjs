import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("root npm analyzer resolves this checkout without DEVOPS_ROOT", () => {
  const root = new URL("..", import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.analyze, "bash scripts/analyze.sh");
  const env = { ...process.env };
  delete env.DEVOPS_ROOT;
  const result = spawnSync("bash", ["scripts/analyze.sh"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const profile = readFileSync(new URL("../.workflow/profile.yml", import.meta.url), "utf8");
  assert.ok(profile.includes(`project_root: ${JSON.stringify(fileURLToPath(root).replace(/\/$/, ""))}`));
  assert.ok(statSync(new URL("../.workflow/profile.yml", import.meta.url)).mtimeMs >=
    statSync(new URL("../stratum/package.json", import.meta.url)).mtimeMs);
});
