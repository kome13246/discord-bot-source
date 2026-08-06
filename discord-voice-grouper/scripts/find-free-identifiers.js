import vm from "node:vm";
import { readFile } from "node:fs/promises";

const nativeSources = process.binding("natives");

function loadInternalCommonJs(name) {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module) { ${nativeSources[name]}\n})`,
    { filename: name },
  );
  wrapper(module.exports, () => {
    throw new Error(`Unexpected require while loading ${name}`);
  }, module);
  return module.exports;
}

const acorn = loadInternalCommonJs("internal/deps/acorn/acorn/dist/acorn");
const walk = loadInternalCommonJs("internal/deps/acorn/acorn-walk/dist/walk");
const filename = process.argv[2];
if (!filename) throw new Error("Usage: node scripts/find-free-identifiers.js <file>");

const source = await readFile(filename, "utf8");
const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
const declared = new Set();
const referenced = new Set();

function declarePattern(node) {
  if (!node) return;
  if (node.type === "Identifier") declared.add(node.name);
  else if (node.type === "RestElement") declarePattern(node.argument);
  else if (node.type === "AssignmentPattern") declarePattern(node.left);
  else if (node.type === "ArrayPattern") node.elements.forEach(declarePattern);
  else if (node.type === "ObjectPattern") {
    node.properties.forEach((property) => declarePattern(property.value ?? property.argument));
  }
}

walk.ancestor(ast, {
  ImportSpecifier(node) { declared.add(node.local.name); },
  ImportDefaultSpecifier(node) { declared.add(node.local.name); },
  ImportNamespaceSpecifier(node) { declared.add(node.local.name); },
  VariableDeclarator(node) { declarePattern(node.id); },
  FunctionDeclaration(node) {
    if (node.id) declared.add(node.id.name);
    node.params.forEach(declarePattern);
  },
  FunctionExpression(node) {
    if (node.id) declared.add(node.id.name);
    node.params.forEach(declarePattern);
  },
  ArrowFunctionExpression(node) { node.params.forEach(declarePattern); },
  ClassDeclaration(node) { if (node.id) declared.add(node.id.name); },
  CatchClause(node) { declarePattern(node.param); },
  Identifier(node, ancestors) {
    const parent = ancestors.at(-2);
    if (!parent) return;
    if (
      (parent.type === "MemberExpression" && parent.property === node && !parent.computed)
      || (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
      || (parent.type === "MethodDefinition" && parent.key === node && !parent.computed)
      || parent.type.startsWith("Import")
      || (parent.type === "LabeledStatement" && parent.label === node)
      || (parent.type === "BreakStatement" && parent.label === node)
      || (parent.type === "ContinueStatement" && parent.label === node)
    ) return;
    referenced.add(node.name);
  },
});

const globals = new Set([
  "AggregateError", "Array", "BigInt", "Boolean", "Buffer", "Date", "Error",
  "Intl", "JSON", "Map", "Math", "Number", "Object", "Promise", "Proxy",
  "Infinity", "Reflect", "RegExp", "Set", "String", "arguments",
  "URL", "clearInterval", "clearTimeout", "console", "process", "setInterval",
  "setTimeout", "structuredClone", "undefined",
]);
console.log([...referenced]
  .filter((name) => !declared.has(name) && !globals.has(name))
  .sort()
  .join("\n"));
