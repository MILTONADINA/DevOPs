import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { configureGitHooks, detectPlatform, listActiveHooks, main } from "../scripts/setup-local.mjs";

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
  assert.match(output, /DEVOPS_LOCAL_INSTANCE.*DEVOPS_LOCAL_PORT/);
});

test("Stratum setup uses the same local workflow without a dotenv-writing legacy script", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../stratum/package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.setup, "node ../scripts/setup-local.mjs");
  assert.equal(existsSync(new URL("../stratum/scripts/setup.ts", import.meta.url)), false);
});

// A fake git for configureGitHooks: records each call. `top` answers rev-parse --show-toplevel
// (throwing, as git does, outside a checkout); `hooksPath` answers config --get core.hooksPath
// (throwing, as git exits 1, when it is unset).
function fakeGit({ top, hooksPath } = {}) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (top === undefined) throw new Error("fatal: not a git repository");
      return top;
    }
    if (args[0] === "rev-parse" && args[1] === "--git-path") return ".git/hooks";
    if (args[0] === "config" && args[1] === "--get") {
      if (hooksPath === undefined) throw new Error("exit status 1");
      return hooksPath;
    }
    return "";
  };
  return { calls, runGit };
}

function withTempDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "setup-hooks-")));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configure(dir, git, activeHooks = () => []) {
  let output = "";
  const result = configureGitHooks({ dir, runGit: git.runGit, activeHooks, write: (text) => { output += text; } });
  return { result, output };
}

test("setup points git at the secret-scanning hooks when core.hooksPath is unset and no hooks are installed", () => withTempDir((dir) => {
  const git = fakeGit({ top: dir });
  const { result, output } = configure(dir, git);
  assert.equal(result, "set");
  assert.deepEqual(git.calls, ["rev-parse --show-toplevel", "config --get core.hooksPath", "rev-parse --git-path hooks", "config core.hooksPath .githooks"]);
  assert.match(output, /core\.hooksPath set to \.githooks/);
}));

test("setup leaves a checkout whose core.hooksPath points elsewhere alone and says how to opt in", () => withTempDir((dir) => {
  const git = fakeGit({ top: dir, hooksPath: ".husky" });
  const { result, output } = configure(dir, git);
  assert.equal(result, "kept");
  assert.equal(git.calls.includes("config core.hooksPath .githooks"), false);
  assert.match(output, /already \.husky/);
  assert.match(output, /git config core\.hooksPath \.githooks/);
}));

test("setup leaves hooks already installed in .git/hooks running", () => withTempDir((dir) => {
  const git = fakeGit({ top: dir });
  const seen = [];
  const { result, output } = configure(dir, git, (hooksDir) => { seen.push(hooksDir); return ["pre-commit"]; });
  assert.equal(result, "kept");
  assert.deepEqual(seen, [join(dir, ".git", "hooks")]);
  assert.equal(git.calls.includes("config core.hooksPath .githooks"), false);
  assert.match(output, /already installed in \.git\/hooks \(pre-commit\)/);
  assert.match(output, /git config core\.hooksPath \.githooks/);
}));

test("setup does not rewrite core.hooksPath when it already points at .githooks", () => withTempDir((dir) => {
  const git = fakeGit({ top: dir, hooksPath: ".githooks" });
  assert.equal(configure(dir, git).result, "unchanged");
  assert.deepEqual(git.calls, ["rev-parse --show-toplevel", "config --get core.hooksPath"]);
}));

test("setup skips the hook outside a git checkout", () => withTempDir((dir) => {
  const git = fakeGit();
  const { result, output } = configure(dir, git);
  assert.equal(result, "skipped");
  assert.deepEqual(git.calls, ["rev-parse --show-toplevel"]);
  assert.match(output, /Not a git checkout/);
}));

test("setup never configures an enclosing repository when the tree is not its own checkout", () => withTempDir((dir) => {
  const inner = join(dir, "unpacked-archive");
  mkdirSync(inner);
  const git = fakeGit({ top: dir });
  const { result, output } = configure(inner, git);
  assert.equal(result, "skipped");
  assert.deepEqual(git.calls, ["rev-parse --show-toplevel"]);
  assert.match(output, /inside the git repository/);
}));

test("listActiveHooks returns executable hooks and ignores samples, plain files and a missing directory", () => withTempDir((dir) => {
  for (const [name, mode] of [["pre-commit", 0o755], ["commit-msg.sample", 0o755], ["post-merge", 0o644]]) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), mode);
  }
  assert.deepEqual(listActiveHooks(dir), ["pre-commit"]);
  assert.deepEqual(listActiveHooks(join(dir, "missing")), []);
}));

test("listActiveHooks counts an unreadable entry as installed, so a dangling symlink never hides a real hook", () => withTempDir((dir) => {
  writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\n");
  chmodSync(join(dir, "pre-commit"), 0o755);
  symlinkSync(join(dir, "moved-away"), join(dir, "post-merge"));
  assert.deepEqual(listActiveHooks(dir).sort(), ["post-merge", "pre-commit"]);
}));

// The pre-commit hook, run the way git runs it, with PATH limited to a directory we control.
const HOOK = fileURLToPath(new URL("../.githooks/pre-commit", import.meta.url));

function runHook(dir, stubExit) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const argsFile = join(dir, "gitleaks-args");
  if (stubExit !== undefined) {
    writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\nprintf '%s ' "$@" > "$ARGS_FILE"\nexit ${stubExit}\n`);
    chmodSync(join(bin, "gitleaks"), 0o755);
  }
  const run = spawnSync("/bin/bash", [HOOK], { cwd: dir, encoding: "utf8", env: { PATH: bin, ARGS_FILE: argsFile } });
  return { ...run, args: existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim() : null };
}

test("the pre-commit hook is executable, warns and lets the commit through when gitleaks is missing", () => withTempDir((dir) => {
  assert.notEqual(statSync(HOOK).mode & 0o111, 0);
  const run = runHook(dir);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /gitleaks is not installed/);
}));

test("the pre-commit hook blocks the commit when gitleaks finds a secret and says what to do", () => withTempDir((dir) => {
  const run = runHook(dir, 99);
  assert.equal(run.status, 99);
  assert.equal(run.args, "git --pre-commit --staged --redact --no-banner --verbose --exit-code 99 --config governance/gitleaks-ci.toml");
  assert.match(run.stderr, /possible secret/);
  assert.match(run.stderr, /gitleaks:allow/);
  // A commitless file:rule:line fingerprint in .gitleaksignore would silence that location in
  // every later scan (specs/security/history-secret-scan-baseline.md REQ-HSB-1), so never suggest it.
  assert.doesNotMatch(run.stderr, /Fingerprint/);
}));

test("the pre-commit hook blocks the commit, without claiming a secret, when gitleaks cannot run", () => withTempDir((dir) => {
  for (const code of [1, 127]) {
    const run = runHook(join(dir, String(code)), code);
    assert.equal(run.status, code);
    assert.match(run.stderr, new RegExp(`could not run \\(exit ${code}\\)`));
    assert.doesNotMatch(run.stderr, /possible secret/);
  }
}));

test("the pre-commit hook lets a clean commit through", () => withTempDir((dir) => {
  const run = runHook(dir, 0);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
}));
