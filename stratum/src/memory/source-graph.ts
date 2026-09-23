/** Deterministic JS/TS source declarations and relative file dependencies. */
import { posix } from "node:path";
import ts from "typescript";

export interface SourceFileInput {
  path: string;
  source: string;
}
export interface SourceEntity {
  kind: "File" | "Function";
  name: string;
  filePath: string;
  summary: string;
}
export interface SourceEdge {
  fromName: string;
  toName: string;
  edgeType: "DECLARES" | "DEPENDS_ON";
}

const extensions = [".ts", ".tsx", ".js", ".jsx"];

function resolveImport(importer: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  for (const candidate of [base, ...extensions.map((ext) => base + ext), ...extensions.map((ext) => `${base}/index${ext}`)]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

export function indexSourceFiles(files: SourceFileInput[]): { entities: SourceEntity[]; edges: SourceEdge[] } {
  const known = new Set(files.map((file) => file.path));
  const entities: SourceEntity[] = [];
  const edges: SourceEdge[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : file.path.endsWith(".jsx") ? ts.ScriptKind.JSX : file.path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
    const declarations = parsed.statements
      .filter(ts.isFunctionDeclaration)
      .map((statement) => statement.name?.text)
      .filter((name): name is string => name !== undefined);
    const summary = `Source file ${file.path}${declarations.length ? `; declares ${declarations.join(", ")}` : ""}`;
    entities.push({ kind: "File", name: file.path, filePath: file.path, summary });
    for (const statement of parsed.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = `${file.path}#${statement.name.text}`;
        const doc = (statement as ts.FunctionDeclaration & { jsDoc?: ts.JSDoc[] }).jsDoc?.[0]?.comment;
        const summary = typeof doc === "string" && doc.trim() ? doc.trim() : `Function ${statement.name.text} in ${file.path}`;
        entities.push({ kind: "Function", name, filePath: file.path, summary });
        edges.push({ fromName: file.path, toName: name, edgeType: "DECLARES" });
      } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveImport(file.path, statement.moduleSpecifier.text, known);
        if (target && target !== file.path) edges.push({ fromName: file.path, toName: target, edgeType: "DEPENDS_ON" });
      }
    }
  }
  return { entities, edges };
}
