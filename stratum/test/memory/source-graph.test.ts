import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { indexSourceFiles } from "../../src/memory/source-graph";

describe("source graph parser", () => {
  test("records files, declared functions, and relative dependencies", () => {
    const graph = indexSourceFiles([
      { path: "src/entry.ts", source: 'import { helper } from "./helper";\n/** Convert a value. */\nexport function convert(x: string) { return helper(x); }' },
      { path: "src/helper.ts", source: "/** Return a value. */\nexport function helper(x: string) { return x; }" },
    ]);
    expect(graph.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "File", name: "src/entry.ts", filePath: "src/entry.ts", summary: "Source file src/entry.ts; declares convert" }),
        expect.objectContaining({ kind: "Function", name: "src/entry.ts#convert", filePath: "src/entry.ts", summary: "Convert a value." }),
        expect.objectContaining({ kind: "Function", name: "src/helper.ts#helper", filePath: "src/helper.ts" }),
      ]),
    );
    expect(graph.entities).toHaveLength(4);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { fromName: "src/entry.ts", toName: "src/entry.ts#convert", edgeType: "DECLARES" },
        { fromName: "src/helper.ts", toName: "src/helper.ts#helper", edgeType: "DECLARES" },
        { fromName: "src/entry.ts", toName: "src/helper.ts", edgeType: "DEPENDS_ON" },
      ]),
    );
    expect(graph.edges).toHaveLength(3);
  });
});

describe("Rust source graph parser", () => {
  test("indexes top-level functions and module dependencies without comment, string, or body decoys", () => {
    const graph = indexSourceFiles([
      {
        path: "rust/src/lib.rs",
        source: `// fn ghost() {}\n/* nested /* fn hidden() {} */ mod absent; */\nconst TEXT: &str = r##"fn fake() {} mod absent;"##;\nmod helper;\n/// Does work\npub fn entry() { let s = "fn string_decoy() {}"; fn nested() {} }`,
      },
      { path: "rust/src/helper.rs", source: "fn helper() {}" },
    ]);
    expect(graph.entities.map((entity) => entity.name)).toEqual(["rust/src/helper.rs", "rust/src/helper.rs#helper", "rust/src/lib.rs", "rust/src/lib.rs#entry"]);
    expect(graph.edges).toEqual([
      { fromName: "rust/src/helper.rs", toName: "rust/src/helper.rs#helper", edgeType: "DECLARES" },
      { fromName: "rust/src/lib.rs", toName: "rust/src/helper.rs", edgeType: "DEPENDS_ON" },
      { fromName: "rust/src/lib.rs", toName: "rust/src/lib.rs#entry", edgeType: "DECLARES" },
    ]);
  });

  test("recognizes the repository's real Rust function", () => {
    const source = readFileSync(new URL("../../rust/hot-path/src/lib.rs", import.meta.url), "utf8");
    const graph = indexSourceFiles([{ path: "stratum/rust/hot-path/src/lib.rs", source }]);
    expect(graph.entities.some((entity) => entity.name === "stratum/rust/hot-path/src/lib.rs#sha256_hex")).toBe(true);
  });
});

describe("Python source graph parser", () => {
  test("indexes top-level sync and async functions and known local imports without decoys", () => {
    const graph = indexSourceFiles([
      {
        path: "py/entry.py",
        source: `# def ghost(): pass\nTEXT = '''😀 def fake(): pass\nimport missing'''\nfrom .helper import helper\nfrom . import helper\nimport helper as h\ndef run():\n    def nested(): pass\n    return h.helper()\nasync def fetch(): pass\ndef run(): pass\nclass Box:\n    def method(self): pass`,
      },
      { path: "py/helper.py", source: "def helper(): pass" },
    ]);
    expect(graph.entities.map((entity) => entity.name)).toEqual(["py/entry.py", "py/entry.py#run", "py/entry.py#fetch", "py/helper.py", "py/helper.py#helper"]);
    expect(graph.edges).toEqual([
      { fromName: "py/entry.py", toName: "py/helper.py", edgeType: "DEPENDS_ON" },
      { fromName: "py/entry.py", toName: "py/entry.py#run", edgeType: "DECLARES" },
      { fromName: "py/entry.py", toName: "py/entry.py#fetch", edgeType: "DECLARES" },
      { fromName: "py/helper.py", toName: "py/helper.py#helper", edgeType: "DECLARES" },
    ]);
  });

  test("recognizes the repository's real Python callback and sibling import", () => {
    const root = new URL("../../../tests/fixtures/agents/asi01-failing/", import.meta.url);
    const graph = indexSourceFiles([
      { path: "tests/fixtures/agents/asi01-failing/harness.py", source: readFileSync(new URL("harness.py", root), "utf8") },
      { path: "tests/fixtures/agents/asi01-failing/test_harness.py", source: readFileSync(new URL("test_harness.py", root), "utf8") },
    ]);
    expect(graph.entities.some((entity) => entity.name === "tests/fixtures/agents/asi01-failing/harness.py#model_callback")).toBe(true);
    expect(graph.edges).toContainEqual({
      fromName: "tests/fixtures/agents/asi01-failing/test_harness.py",
      toName: "tests/fixtures/agents/asi01-failing/harness.py",
      edgeType: "DEPENDS_ON",
    });
    expect(graph.entities.some((entity) => entity.name.endsWith("#test_canonical_injection_probe_hijacks_goal"))).toBe(false);
  });
});
