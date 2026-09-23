/** Deterministic JS/TS and Rust source declarations and local file dependencies. */
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

function rustTopLevel(source: string): string {
  const clean = [...source];
  const blank = (start: number, end: number): void => {
    for (let at = start; at < end; at++) if (clean[at] !== "\n") clean[at] = " ";
  };
  for (let i = 0; i < source.length; ) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      blank(start, i);
    } else {
      const raw = /^(?:br|r)(#{0,16})"/.exec(source.slice(i, i + 24));
      if (raw) {
        const end = source.indexOf(`"${raw[1]}`, i + raw[0].length);
        const next = end < 0 ? source.length : end + raw[1]!.length + 1;
        blank(i, next);
        i = next;
      } else if (source[i] === '"') {
        const start = i++;
        while (i < source.length) {
          if (source[i] === "\\") i += 2;
          else if (source[i++] === '"') break;
        }
        blank(start, Math.min(i, source.length));
      } else {
        const character = /^'(?:\\u\{[0-9a-fA-F_]+\}|\\.|[^'\\\n])'/.exec(source.slice(i, i + 32));
        if (character) {
          blank(i, i + character[0].length);
          i += character[0].length;
        } else i++;
      }
    }
  }
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "{") {
      depth++;
      clean[i] = " ";
    } else if (clean[i] === "}") {
      depth = Math.max(0, depth - 1);
      clean[i] = " ";
    } else if (depth > 0 && clean[i] !== "\n") clean[i] = " ";
  }
  return clean.join("");
}

function rustModuleTarget(file: string, module: string, known: Set<string>): string | undefined {
  const base = ["lib.rs", "main.rs", "mod.rs"].includes(posix.basename(file)) ? posix.dirname(file) : file.slice(0, -3);
  return [`${base}/${module}.rs`, `${base}/${module}/mod.rs`].find((candidate) => known.has(candidate));
}

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
    if (file.path.endsWith(".rs")) {
      const source = rustTopLevel(file.source);
      const functions = [...source.matchAll(/\bfn\s+([A-Za-z_][A-Za-z_0-9]*)\s*(?=[(<])/g)].map((match) => match[1]!);
      const summary = `Source file ${file.path}${functions.length ? `; declares ${functions.join(", ")}` : ""}`.slice(0, 300);
      entities.push({ kind: "File", name: file.path, filePath: file.path, summary });
      for (const module of source.matchAll(/\bmod\s+([A-Za-z_][A-Za-z_0-9]*)\s*;/g)) {
        const target = rustModuleTarget(file.path, module[1]!, known);
        if (target) edges.push({ fromName: file.path, toName: target, edgeType: "DEPENDS_ON" });
      }
      for (const name of functions) {
        const entityName = `${file.path}#${name}`;
        entities.push({ kind: "Function", name: entityName, filePath: file.path, summary: `Function ${name} in ${file.path}`.slice(0, 300) });
        edges.push({ fromName: file.path, toName: entityName, edgeType: "DECLARES" });
      }
      continue;
    }
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
