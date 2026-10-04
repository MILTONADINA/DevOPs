#!/usr/bin/env node
// Masterpiece REQ-M23: a new test file with no assertion never reads as PASS.
//
//   node scripts/check-assertions.mjs <file> [<file> ...]
//
// Exits 1 when any given test file contains no assert.*(...) / assert(...) / expect(...) call.
// CI passes the test files a pull request adds.
import { readFileSync, realpathSync } from 'node:fs';
import { parse } from 'acorn';
import ts from 'typescript';

function javascriptAssertion(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  function unwrap(node) {
    while (node.type === 'ChainExpression') node = node.expression;
    return node;
  }
  function callee(node) {
    node = unwrap(node);
    if (node.type === 'Identifier') return node.name === 'assert' || node.name === 'expect';
    if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') return false;
    const receiver = unwrap(node.object);
    return receiver.type === 'Identifier' && receiver.name === 'assert' && /^[A-Za-z]+$/.test(node.property.name);
  }
  function visit(node) {
    if (!node || typeof node.type !== 'string') return false;
    if (node.type === 'CallExpression' && callee(node.callee)) return true;
    return Object.values(node).some(value => Array.isArray(value)
      ? value.some(visit) : value && typeof value === 'object' && visit(value));
  }
  return visit(tree);
}

function typescriptAssertion(source) {
  const tree = ts.createSourceFile('assertion-input.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // This parser field is guarded and tied to the root's exact TypeScript pin.
  if (!Array.isArray(tree.parseDiagnostics) || tree.parseDiagnostics.length) return false;
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
        || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
      node = node.expression;
    }
    return node;
  }
  function callee(node) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return node.text === 'assert' || node.text === 'expect';
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name)) return false;
    const receiver = unwrap(node.expression);
    return ts.isIdentifier(receiver) && receiver.text === 'assert' && /^[A-Za-z]+$/.test(node.name.text);
  }
  function visit(node) {
    return (ts.isCallExpression(node) && callee(node.expression)) || ts.forEachChild(node, visit);
  }
  return Boolean(visit(tree));
}

// specs/ops/assertion-syntax.md: syntax evidence only; supplied source never executes.
export function hasAssertion(source, filename = 'input.js') {
  try {
    return filename.endsWith('.ts') ? typescriptAssertion(source) : javascriptAssertion(source);
  } catch {
    // Invalid source (including parser recovery) cannot supply assertion evidence.
    return false;
  }
}

// Compare real paths, so a symlinked invocation runs; an unresolvable argv[1] means "imported".
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const files = process.argv.slice(2);
  const empty = files.filter((f) => !hasAssertion(readFileSync(f, 'utf8'), f));
  for (const f of empty) console.error(`check-assertions: ${f} has no assert(...) or expect(...) call`);
  console.log(`check-assertions: ${files.length} file(s) checked, ${empty.length} without assertions`);
  process.exit(empty.length ? 1 : 0);
}
