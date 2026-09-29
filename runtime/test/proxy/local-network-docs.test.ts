// Tests for specs/security/stratum-local-network.md — AC-8 (REQ-6: docs and packaging match the
// behaviour): runtime/Dockerfile and runtime/Dockerfile.dockerignore are gone, no doc tells a user to
// `docker run` the proxy image or set HOST=0.0.0.0, and runtime/docs/API_REFERENCE.md states the
// per-mode auth rule.
//
// Reads the filesystem DIRECTLY (node:fs — existsSync/readFileSync/readdirSync), not git: AC-8's own
// spec text names `git ls-files`/`git grep`, but a plain fs read needs no subprocess, answers for the
// working tree whether or not a change has been committed, and matches what REQ-6 actually cares
// about — what a user reading the doc, or listing the directory, sees — rather than git's index state
// specifically.
//
// test/setup.ts (vitest's global setupFiles entry) mocks BOTH `fs` and `node:fs` for every test file by
// default (the capture-session.ts harness's mkdirSync/writeFileSync spies). The two `vi.unmock(...)`
// calls below opt this file out of that, matching start-options.test.ts's own precedent for a test that
// reads real files from disk. (The wrapped mock spreads the real module for every other export, so
// existsSync/readFileSync/readdirSync would in practice still reach the real filesystem either way —
// the unmock is for explicitness and consistency with start-options.test.ts, not because those three
// specific functions are themselves overridden there.)

import { describe, test, expect, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// vitest runs with cwd = runtime/ (`npm run test` -> `vitest run`, runtime/package.json's own script) —
// the same convention audit-repo-boundary.test.ts already relies on (`resolve(process.cwd(), "..")`
// for the repo root).
const RUNTIME_ROOT = process.cwd();
const REPO_ROOT = resolve(RUNTIME_ROOT, "..");

/** AC-8's own second bullet, as a real RegExp — see the detector self-test below for why this is not a hardcoded pass. */
const FORBIDDEN_DOCKER_PATTERN = /docker run.*stratum-proxy|HOST=0\.0\.0\.0/;

/** Recursively collect every `*.md` file under `dir`, as absolute paths. */
function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

describe("REQ-6 — docs and packaging match the behaviour (specs/security/stratum-local-network.md#AC-8)", () => {
  test("runtime/Dockerfile and runtime/Dockerfile.dockerignore do not exist on disk — specs/security/stratum-local-network.md#AC-8", () => {
    // REQ-6: "runtime/Dockerfile SHALL be removed" — the project does not deploy, and Compose already
    // covers local use. This reads disk existence rather than `git ls-files` (AC-8's own literal
    // wording), so a deletion in the working tree counts whether or not it has been committed.
    expect(existsSync(join(RUNTIME_ROOT, "Dockerfile"))).toBe(false);
    expect(existsSync(join(RUNTIME_ROOT, "Dockerfile.dockerignore"))).toBe(false);
  });

  // Mutation: editing FORBIDDEN_DOCKER_PATTERN so that it cannot match the line it exists to catch.
  test("the docker-doc detector itself matches the exact pre-change line it exists to catch (regression guard) — specs/security/stratum-local-network.md#AC-8", () => {
    // Not a filesystem read — a self-test of FORBIDDEN_DOCKER_PATTERN, proving the walk-based check
    // below is a real regex match and not `expect([]).toEqual([])` over an accidentally-empty list. The
    // sample is a LITERAL `docker run` line of the kind REQ-6 removes from the docs: it names the
    // `stratum-proxy` image and sets HOST=0.0.0.0. It reads no repo file, so it proves nothing about
    // the docs; it guards the walk test below: with a pattern that never matches, this test fails while
    // the walk test still passes, vacuously, even with a real forbidden line planted in a doc.
    const preChangeDeploymentMdLine73 = "docker run -p 4080:4080 -e HOST=0.0.0.0 -e ANTHROPIC_API_KEY=sk-ant-… stratum-proxy";
    expect(FORBIDDEN_DOCKER_PATTERN.test(preChangeDeploymentMdLine73)).toBe(true);
  });

  test("no .md file under runtime/docs or docs, and neither README.md nor runtime/README.md, tells a user to `docker run` the proxy image or set HOST=0.0.0.0 — specs/security/stratum-local-network.md#AC-8", () => {
    // AC-8's own bullet greps only `runtime/docs docs README.md`; this ALSO checks runtime/README.md
    // (broader than the spec's literal command) — runtime/README.md documents Compose-based local
    // setup and is exactly the kind of doc that could reintroduce this pattern.
    const files = [...listMarkdownFiles(join(RUNTIME_ROOT, "docs")), ...listMarkdownFiles(join(REPO_ROOT, "docs")), join(REPO_ROOT, "README.md"), join(RUNTIME_ROOT, "README.md")];

    // Sentinel check: proves the walk actually reached the real project directories (not an empty or
    // wrong root, e.g. a cwd drift), so `matches` below can't pass vacuously over an empty file list.
    expect(files).toContain(join(RUNTIME_ROOT, "docs", "API_REFERENCE.md"));
    expect(files).toContain(join(RUNTIME_ROOT, "docs", "DEPLOYMENT.md"));
    expect(files).toContain(join(REPO_ROOT, "docs", "runbooks", "INCIDENT_RESPONSE.md"));
    expect(files.length).toBeGreaterThan(50); // a loose floor for runtime/docs + docs + the 2 READMEs, not pinned to an exact count

    const matches: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      content.split("\n").forEach((lineText, idx) => {
        if (FORBIDDEN_DOCKER_PATTERN.test(lineText)) matches.push(`${file}:${idx + 1}: ${lineText.trim()}`);
      });
    }
    // A real check: `matches` is built from FORBIDDEN_DOCKER_PATTERN (proven live by the detector
    // self-test above) actually run against actual file content read above (proven non-empty by the
    // sentinel check above) — not hardcoded to `[]`. A future regression makes `matches` non-empty and
    // THIS assertion fails, naming the exact file, line number and text — that failure message is the
    // "stop and report" signal for a human to act on; this test only asserts, it never edits a file.
    //
    // Note: `HOST=0\.0\.0\.0` is an unanchored substring match, so it also matches a doc mentioning the
    // CANONICAL `DEVOPS_PROXY_HOST=0.0.0.0` — a future legitimate doc about binding beyond loopback that
    // uses that exact spelling would trip this too. No doc matches either spelling; AC-8's own text
    // specifies exactly this pattern, so it is applied as written rather than narrowed.
    expect(matches).toEqual([]);
  });

  test("runtime/docs/API_REFERENCE.md states the per-mode auth rule under its own '## Authentication' heading — specs/security/stratum-local-network.md#AC-8", () => {
    // REQ-6: "runtime/docs/API_REFERENCE.md SHALL state which requests need auth in each mode."
    const content = readFileSync(join(RUNTIME_ROOT, "docs", "API_REFERENCE.md"), "utf8");
    expect(content).toMatch(/^## Authentication$/m);
    // The two sentences below are copied from the file, one per mode, so a future edit that keeps the
    // heading but drops or waters down either mode's own rule still fails this.
    expect(content).toContain("**Personal mode:** no request needs an API key, on any path, including");
    expect(content).toContain("**Commercial mode:** every request under `/v1/*` requires the header");
  });
});
