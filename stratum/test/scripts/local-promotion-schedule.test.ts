import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderPlist } from "../../scripts/local-promotion-schedule";

describe("local promotion launchd schedule", () => {
  it("renders a valid 02:00 project-local job with a fresh credential wrapper", () => {
    const plist = renderPlist({
      root: "/tmp/project & memory",
      node: "/usr/local/bin/node",
      path: "/usr/local/bin:/usr/bin:/bin",
    });
    if (process.platform === "darwin") {
      const lint = spawnSync("plutil", ["-lint", "-"], { input: plist, encoding: "utf8" });
      expect(lint.status).toBe(0);
    }
    expect(plist).toContain("<integer>2</integer>");
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).toContain("local-compose.ts");
    expect(plist).toContain("<string>with-env</string>");
    expect(plist).toContain("promote-tier2-to-tier3.ts");
    expect(plist).toContain("/tmp/project &amp; memory/.workflow/state/");
  });
});
