/** Bring up the project-local Stratum stack from the repository root. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stratum = join(root, "stratum");

export function detectPlatform(name, kernel) {
  if (name === "darwin") return "macOS";
  if (name === "linux") return /microsoft|wsl/i.test(kernel) ? "WSL2" : "Linux";
  throw new Error("Native Windows is unsupported; use WSL2 with Docker integration.");
}

function run(command, args, failure) {
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit", timeout: 300_000 });
  } catch {
    throw new Error(failure);
  }
}

const HOOKS_PATH = ".githooks";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim();
}

const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The executable, non-sample hooks installed in a hooks directory. An entry
 * that cannot be read (a dangling symlink, say) counts as installed, so setup
 * errs toward leaving existing hooks alone. A missing directory has none.
 */
export function listActiveHooks(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.endsWith(".sample"))
    .filter((name) => {
      try {
        const stats = statSync(join(dir, name));
        return stats.isFile() && (stats.mode & 0o111) !== 0;
      } catch {
        return true;
      }
    });
}

/**
 * Point this checkout's git hooks at .githooks/, whose pre-commit hook scans
 * staged changes for secrets. Leaves alone a tree that is not its own checkout
 * (an unpacked archive inside another repository, say) and a checkout that
 * already uses other hooks, through core.hooksPath or installed in .git/hooks.
 * Every dependency is injectable so tests never spawn git.
 */
export function configureGitHooks({
  dir = root,
  runGit = (args) => git(args, dir),
  activeHooks = listActiveHooks,
  write = (text) => process.stdout.write(text),
} = {}) {
  let top;
  try {
    top = runGit(["rev-parse", "--show-toplevel"]);
  } catch {
    write("Not a git checkout: skipped the secret-scanning pre-commit hook.\n");
    return "skipped";
  }
  if (realPath(top) !== realPath(dir)) {
    write(`This tree sits inside the git repository at ${top} and is not its own checkout: skipped the secret-scanning pre-commit hook.\n`);
    return "skipped";
  }
  let current = "";
  try {
    current = runGit(["config", "--get", "core.hooksPath"]);
  } catch {
    // git config --get exits 1 when the key is unset.
  }
  if (current === HOOKS_PATH) return "unchanged";
  const optIn = `To use the secret-scanning pre-commit hook, run: git config core.hooksPath ${HOOKS_PATH}`;
  if (current) {
    write(`core.hooksPath is already ${current}; left unchanged. ${optIn}\n`);
    return "kept";
  }
  const installed = activeHooks(resolve(dir, runGit(["rev-parse", "--git-path", "hooks"])));
  if (installed.length) {
    write(`Hooks are already installed in .git/hooks (${installed.join(", ")}); core.hooksPath left unset so they keep running. ${optIn}\n`);
    return "kept";
  }
  runGit(["config", "core.hooksPath", HOOKS_PATH]);
  write(`Git hooks: core.hooksPath set to ${HOOKS_PATH}; the pre-commit hook scans staged changes with gitleaks.\n`);
  return "set";
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write("Usage: npm run setup\nRequires Node >=22.12, Docker Compose and a running Docker engine on macOS, Linux, or WSL2.\nStarts local Supabase and smoke-tests the proxy. Configure a provider before sending messages.\nFor an isolated checkout, set DEVOPS_LOCAL_INSTANCE and DEVOPS_LOCAL_PORT together.\n");
    return;
  }
  const system = detectPlatform(platform(), release());
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node >=22.12 is required.");
  process.stdout.write(`Local setup on ${system}\n`);
  configureGitHooks();
  run("docker", ["compose", "version"], "Docker Compose is required. Install/start Docker Desktop or Docker Engine with Compose.");
  run("docker", ["info", "--format", "{{.ServerVersion}}"], "Docker is not running. Start Docker and rerun npm run setup.");
  if (!existsSync(join(stratum, "node_modules", ".bin", "tsx"))) {
    run("npm", ["ci", "--prefix", "stratum"], "Stratum dependency installation failed. Check npm registry access, then rerun npm run setup.");
  }
  run("npm", ["run", "db:start", "--prefix", "stratum"], "The local Supabase stack did not start. Check Docker and the configured loopback port.");
  run("npm", ["run", "db:with-env", "--prefix", "stratum", "--", "tsx", "scripts/smoke-setup.ts"], "The proxy/database startup smoke check failed.");
  process.stdout.write("Local database and proxy startup smoke passed. Run `cd stratum && npm run dev` after configuring a provider to send messages.\n");
  process.stdout.write("This machine check does not satisfy clean-machine, cross-platform, or real-data recovery release gates.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
