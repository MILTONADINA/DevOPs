import { describe, expect, test } from "vitest";
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
