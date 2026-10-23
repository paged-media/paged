#!/usr/bin/env node
/**
 * The instance guard (docs/composable-editor-plan.md, E1).
 *
 * The editor mounts as an instance: two editors on one page must not share
 * state, and a disposed one must leave nothing behind. State an editor keeps
 * lives in its instance (`apps/canvas/src/app/instance.tsx`) or in its
 * scope (`packages/shell/src/state/editor-scope.tsx`), never at module
 * scope. This guard fails on NEW module-level mutable state in
 * `apps/canvas/src` and `packages/shell/src`:
 *
 *   · a `let` or `var` at module scope;
 *   · a module-level `const` holding a Map, Set, WeakMap, WeakSet, array or
 *     object literal that the file mutates (`.set(`, `.add(`, `.push(`, an
 *     assignment to one of its members, …);
 *   · a module-level `const` holding an object a factory made
 *     (`createX(…)`, `new X(…)`): a registry, a store, a client.
 *
 * What stays at module scope says why, one entry per name in
 * `instance-guard-allow.json`: state that is the page's by nature (a
 * clipboard, a cache keyed by the object it caches for, a once-per-page
 * install). An entry that no longer matches anything fails too, so the list
 * shrinks with the code.
 *
 *   bun scripts/instance-guard.mjs           # gate
 *   bun scripts/instance-guard.mjs --list    # every finding, allowed or not
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");
const ROOTS = ["apps/canvas/src", "packages/shell/src"];
const ALLOW = join(HERE, "instance-guard-allow.json");

/** Not editor code: host pages, a worker (its own realm, one per editor),
 *  type declarations. */
const SKIP = [
  /^apps\/canvas\/src\/demos\//,
  /^apps\/canvas\/src\/worker\//,
  /\.d\.ts$/,
  /\.test\.tsx?$/,
  /\.worker\.ts$/,
];

const MUTATORS = new Set([
  "set",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/** Factories that make a value, not state: a React context, a message
 *  table, the strings of a locale. */
const PURE_FACTORIES = new Set([
  "createContext",
  "defineMessages",
  "defineTranslations",
  "createStrings",
  "scoped",
  "lazy",
  "memo",
  "forwardRef",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every node of `node`'s subtree. */
function* nodes(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) yield* nodes(c);
    else if (v && typeof v.type === "string") yield* nodes(v);
  }
}

const unwrap = (e) =>
  e &&
  (e.type === "TSAsExpression" ||
    e.type === "TSSatisfiesExpression" ||
    e.type === "TSNonNullExpression" ||
    e.type === "ParenthesizedExpression")
    ? unwrap(e.expression)
    : e;

/** What kind of value a module-level `const` holds, when it can be state. */
function containerKind(init) {
  const e = unwrap(init);
  if (!e) return null;
  if (e.type === "ArrayExpression") return "array";
  if (e.type === "ObjectExpression") return "object";
  if (e.type === "NewExpression" && e.callee.type === "Identifier") {
    if (/^(Map|Set|WeakMap|WeakSet|Array)$/.test(e.callee.name))
      return e.callee.name;
    if (/^(RegExp|Intl\.|URL|TextEncoder|TextDecoder)/.test(e.callee.name))
      return null;
    return `new ${e.callee.name}`;
  }
  if (e.type === "CallExpression") {
    const name =
      e.callee.type === "Identifier"
        ? e.callee.name
        : e.callee.type === "MemberExpression" &&
            e.callee.property.type === "Identifier"
          ? e.callee.property.name
          : null;
    if (name && /^create[A-Z]/.test(name) && !PURE_FACTORIES.has(name))
      return `${name}()`;
  }
  return null;
}

/** Whether the file mutates the value bound to `name`. */
function mutated(ast, name) {
  const isName = (n) => n && n.type === "Identifier" && n.name === name;
  const rootOf = (m) => {
    let o = m;
    while (o && o.type === "MemberExpression") o = o.object;
    return o;
  };
  for (const n of nodes(ast.program)) {
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      isName(n.callee.object) &&
      n.callee.property.type === "Identifier" &&
      MUTATORS.has(n.callee.property.name)
    )
      return true;
    if (
      (n.type === "AssignmentExpression" || n.type === "UpdateExpression") &&
      (n.left ?? n.argument)?.type === "MemberExpression" &&
      isName(rootOf(n.left ?? n.argument))
    )
      return true;
    if (
      n.type === "UnaryExpression" &&
      n.operator === "delete" &&
      n.argument.type === "MemberExpression" &&
      isName(rootOf(n.argument))
    )
      return true;
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.object.type === "Identifier" &&
      n.callee.object.name === "Object" &&
      n.callee.property.name === "assign" &&
      isName(n.arguments[0])
    )
      return true;
  }
  return false;
}

/** The module-level mutable state of one file: `[name, why]`. */
export function findings(source, file) {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", ...(file.endsWith(".tsx") ? ["jsx"] : [])],
  });
  const out = [];
  for (let stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration)
      stmt = stmt.declaration;
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
      if (d.id.type !== "Identifier") continue;
      const name = d.id.name;
      if (stmt.kind === "let" || stmt.kind === "var") {
        out.push([name, `${stmt.kind} at module scope`]);
        continue;
      }
      const kind = containerKind(d.init);
      if (!kind) continue;
      if (kind.endsWith("()") || kind.startsWith("new "))
        out.push([name, `module-level ${kind}`]);
      else if (mutated(ast, name))
        out.push([name, `module-level ${kind}, mutated`]);
    }
  }
  return out;
}

function scan() {
  const found = [];
  for (const root of ROOTS) {
    for (const path of walk(join(EDITOR, root))) {
      const rel = relative(EDITOR, path);
      if (SKIP.some((re) => re.test(rel))) continue;
      for (const [name, why] of findings(readFileSync(path, "utf8"), rel))
        found.push({ file: rel, name, why });
    }
  }
  return found;
}

function main() {
  const allow = JSON.parse(readFileSync(ALLOW, "utf8")).allowed;
  const found = scan();
  if (process.argv.includes("--list")) {
    for (const f of found) {
      const reason = allow[f.file]?.[f.name];
      console.log(
        `${f.file} ${f.name} (${f.why})${reason ? `\n    allowed: ${reason}` : ""}`,
      );
    }
    return;
  }
  const problems = [];
  const seen = new Set();
  for (const f of found) {
    const key = `${f.file} ${f.name}`;
    seen.add(key);
    const reason = allow[f.file]?.[f.name];
    if (!reason)
      problems.push(
        `${f.file}: ${f.name} is ${f.why}. Keep an editor's state in its ` +
          `instance or scope (state/editor-scope.tsx), or list it in ` +
          `scripts/instance-guard-allow.json with the reason it is the page's.`,
      );
    else if (typeof reason !== "string" || reason.trim().length < 20)
      problems.push(`${key}: the allow-list entry needs a reason`);
  }
  for (const [file, names] of Object.entries(allow)) {
    for (const name of Object.keys(names)) {
      if (!seen.has(`${file} ${name}`))
        problems.push(
          `${file}: allow-list entry ${name} matches nothing; remove it`,
        );
    }
  }
  if (problems.length) {
    console.error(`instance guard: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `instance guard OK: ${found.length} module-level state entries, each allowed with a reason`,
  );
}

if (import.meta.main) main();
