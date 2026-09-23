/** Start only this project's local Supabase services and reject broad port binding. */
import { execFileSync } from "node:child_process";

type Runner = (command: string, args: string[]) => string;

const network = "devops-stratum-local";
const loopbackOption = "com.docker.network.bridge.host_binding_ipv4=127.0.0.1";
const excluded = "realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";

function commandRunner(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    // Supabase startup output can contain local credentials; never echo it.
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  }
}

/** Start, verify both published ports, and stop this project if either is broad. */
export function startLocalStack(run: Runner = commandRunner): void {
  let optionsText: string;
  try {
    optionsText = run("docker", ["network", "inspect", network, "--format", "{{json .Options}}"]).trim();
  } catch {
    run("docker", ["network", "create", "-o", loopbackOption, network]);
    optionsText = run("docker", ["network", "inspect", network, "--format", "{{json .Options}}"]).trim();
  }
  const options = JSON.parse(optionsText) as Record<string, string>;
  if (options["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") {
    throw new Error(`Docker network ${network} is not configured for loopback binding`);
  }

  try {
    run("supabase", ["start", "--network-id", network, "--exclude", excluded]);
    for (const name of ["supabase_db_devops-stratum", "supabase_kong_devops-stratum"]) {
      const text = run("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]);
      const bindings = JSON.parse(text) as Record<string, Array<{ HostIp?: string }>>;
      const ports = Object.values(bindings).flat();
      if (ports.length === 0 || ports.some((port) => port.HostIp !== "127.0.0.1" && port.HostIp !== "::1")) {
        throw new Error(`non-loopback Docker port binding for ${name}`);
      }
    }
  } catch (error) {
    try { run("supabase", ["stop"]); } catch { /* preserve the original failure */ }
    throw error;
  }
}

if ((process.argv[1] ?? "").endsWith("start-local-stack.ts")) {
  try {
    startLocalStack();
    process.stdout.write("Local Supabase stack started with loopback-only ports.\n");
  } catch (error) {
    process.stderr.write(`Local Supabase startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
