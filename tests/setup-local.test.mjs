import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectPlatform, main } from "../scripts/setup-local.mjs";

test("root setup supports macOS, Linux, and WSL2 but refuses native Windows", () => {
  assert.equal(detectPlatform("darwin", "Darwin Kernel Version 25"), "macOS");
  assert.equal(detectPlatform("linux", "6.8.0-generic"), "Linux");
  assert.equal(detectPlatform("linux", "6.6.87.2-microsoft-standard-WSL2"), "WSL2");
  assert.throws(() => detectPlatform("win32", "Windows 11"), /WSL2/);
});

test("root npm setup help describes the local stack without starting it", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.setup, "node scripts/setup-local.mjs");
  let output = "";
  const original = process.stdout.write;
  try {
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    main(["--help"]);
  } finally {
    process.stdout.write = original;
  }
  assert.match(output, /Docker Compose/);
  assert.match(output, /macOS.*Linux.*WSL2/);
  assert.match(output, /provider/i);
});
