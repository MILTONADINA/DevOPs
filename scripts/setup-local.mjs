/** Bring up the project-local Stratum stack from the repository root. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write("Usage: npm run setup\nRequires Node >=20.11, Docker Compose and a running Docker engine on macOS, Linux, or WSL2.\nStarts local Supabase and smoke-tests the proxy. Configure a provider before sending messages.\n");
    return;
  }
  const system = detectPlatform(platform(), release());
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 11)) throw new Error("Node >=20.11 is required.");
  process.stdout.write(`Local setup on ${system}\n`);
  run("docker", ["compose", "version"], "Docker Compose is required. Install/start Docker Desktop or Docker Engine with Compose.");
  run("docker", ["info", "--format", "{{.ServerVersion}}"], "Docker is not running. Start Docker and rerun npm run setup.");
  if (!existsSync(join(stratum, "node_modules", ".bin", "tsx"))) {
    run("npm", ["ci", "--prefix", "stratum"], "Stratum dependency installation failed. Check npm registry access, then rerun npm run setup.");
  }
  run("npm", ["run", "db:start", "--prefix", "stratum"], "The local Supabase stack did not start. Check Docker and loopback port 54321.");
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
