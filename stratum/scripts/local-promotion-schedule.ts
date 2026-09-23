/** Project-local launchd job for nightly Tier-2 → Tier-3 promotion on macOS. */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const label = "com.devops.stratum.local-promotion";
const name = "stratum-promotion.plist";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderPlist({ root, node, path }: { root: string; node: string; path: string }): string {
  const stratum = join(root, "stratum");
  const cli = join(stratum, "node_modules/tsx/dist/cli.mjs");
  const args = [node, cli, join(stratum, "scripts/local-compose.ts"), "with-env",
    node, cli, join(stratum, "scripts/promote-tier2-to-tier3.ts")];
  const strings = args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const log = join(root, ".workflow/state");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${strings}
  </array>
  <key>WorkingDirectory</key><string>${xml(stratum)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(join(log, "stratum-promotion.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(log, "stratum-promotion-error.log"))}</string>
</dict></plist>\n`;
}

function launchctl(args: string[]): string {
  return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function main(argv: string[] = process.argv.slice(2)): void {
  if (process.platform !== "darwin") throw new Error("the local promotion schedule requires macOS launchd");
  const root = realpathSync(join(process.cwd(), ".."));
  if (realpathSync(process.cwd()) !== join(root, "stratum")) throw new Error("run from stratum/");
  const target = `gui/${process.getuid!()}/${label}`;
  const plist = join(root, ".workflow/state", name);
  switch (argv[0]) {
    case "install": {
      mkdirSync(join(root, ".workflow/state"), { recursive: true });
      const node = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
      const path = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".docker/bin"), "/usr/bin", "/bin"].join(":");
      writeFileSync(plist, renderPlist({ root, node, path }));
      execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "pipe" });
      try { launchctl(["bootout", target]); } catch { /* first install */ }
      try { launchctl(["bootstrap", `gui/${process.getuid!()}`, plist]); }
      catch (error) {
        try { launchctl(["bootout", target]); } catch { /* no job was registered */ }
        throw error;
      }
      process.stdout.write(`Installed ${label} for 02:00 local time; plist: ${plist}\n`);
      return;
    }
    case "status": process.stdout.write(launchctl(["print", target])); return;
    case "remove":
      launchctl(["bootout", target]);
      rmSync(plist, { force: true });
      process.stdout.write(`Removed ${label}\n`);
      return;
    default: throw new Error("usage: local-promotion-schedule.ts install|status|remove");
  }
}

if ((process.argv[1] ?? "").endsWith("local-promotion-schedule.ts")) {
  try { main(); } catch (error) {
    process.stderr.write(`Promotion schedule failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
