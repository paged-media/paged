/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// A small static evaluator over TypeScript sources, for the surface gate.
//
// The editor and the bundles register most of their surface through
// tables: `ENTRIES.map((e) => ({ path: e.path, command: … }))`, a
// `for (const [path, suffix] of ENTRIES)` loop, a local `cmd(id, title,
// run)` helper. A regex reads none of those, and a regex that silently
// reads less than is there is the fail-open the gate exists to prevent.
// This evaluates the expressions that name an id, statically:
//
// - literals, template literals, `+`, `??` / `||` / `&&`, `?:` with a
//   known test, member access, object and array literals with spreads;
// - identifiers through the lexical scope: a `const` in any enclosing
//   block, a loop variable, a function parameter, an import (relative or
//   a workspace package, through `export … from` chains);
// - calls of local functions (expression body or one `return`), and
//   `map` / `filter` / `flatMap` / `concat` / string methods on known values.
//
// A FREE PARAMETER (a function's argument, a loop variable) is resolved by
// enumerating the contexts that bind it: the array a `.map(fn)` runs over,
// every call site of a named local function, the iterable of a `for…of`.
// What cannot be known evaluates to UNKNOWN, and a template literal with an
// unknown part becomes a Pattern (`paged.panel.show.*`), which the gate
// either maps onto a declared family or reports as unresolved.

import { parse } from "@babel/parser";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const UNKNOWN = Symbol("unknown");

/** A string with unknown parts: each `*` stands for one. */
export class Pattern {
  constructor(glob) {
    this.glob = glob;
  }
  toString() {
    return this.glob;
  }
}

/** The value of a `?:` whose test is unknown: either branch. */
export class Choice {
  constructor(options) {
    this.options = options;
  }
}

const isKnown = (v) =>
  v !== UNKNOWN && !(v instanceof Pattern) && !(v instanceof Choice);

class Closure {
  constructor(node, env = null) {
    this.node = node;
    this.env = env;
  }
}

/** Thrown when an identifier is a free parameter of `scope`. */
class NeedBinding {
  constructor(scope) {
    this.scope = scope;
  }
}

const PARSE_PLUGINS = ["typescript", "jsx", "importAttributes"];

export function parseSource(src, file) {
  return parse(src, {
    sourceType: "module",
    plugins: PARSE_PLUGINS,
    errorRecovery: false,
    sourceFilename: file,
  });
}

/** Attach `parent` links, so lookups can walk the lexical scope. */
function link(node, parent) {
  if (!node || typeof node.type !== "string") return;
  Object.defineProperty(node, "parent", { value: parent, writable: true });
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "parent")
      continue;
    if (key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) link(c, node);
    else if (v && typeof v.type === "string") link(v, node);
  }
}

export function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "parent")
      continue;
    if (key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walkAst(c, visit);
    else if (v && typeof v.type === "string") walkAst(v, visit);
  }
}

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
]);

const unwrap = (n) => {
  while (
    n &&
    (n.type === "TSAsExpression" ||
      n.type === "TSNonNullExpression" ||
      n.type === "TSSatisfiesExpression" ||
      n.type === "TSTypeAssertion" ||
      n.type === "ParenthesizedExpression")
  )
    n = n.expression;
  return n;
};

const propKey = (p) => {
  if (p.computed) return null;
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "StringLiteral") return p.key.value;
  if (p.key.type === "NumericLiteral") return String(p.key.value);
  return null;
};

/** Names a binding pattern declares (for scope lookups). */
function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "ArrayPattern")
    for (const e of p.elements) patternNames(e, out);
  else if (p.type === "ObjectPattern")
    for (const prop of p.properties)
      patternNames(prop.type === "RestElement" ? prop : prop.value, out);
  else if (p.type === "TSParameterProperty") patternNames(p.parameter, out);
  return out;
}

/**
 * One evaluator over a set of files. `resolvePackage(name)` maps a bare
 * import to a source file (a workspace package's entry), or null.
 */
export class Evaluator {
  constructor({ root, resolvePackage }) {
    this.root = root;
    this.resolvePackage = resolvePackage;
    this.programs = new Map();
    this.depth = 0;
  }

  /** The parsed, linked program of `file` (absolute), or null. */
  program(file) {
    if (this.programs.has(file)) return this.programs.get(file);
    let program = null;
    try {
      const src = readFileSync(file, "utf8");
      const ast = parseSource(src, file);
      link(ast.program, null);
      program = ast.program;
      Object.defineProperty(program, "file", { value: file });
    } catch {
      program = null;
    }
    this.programs.set(file, program);
    return program;
  }

  rel(file) {
    return relative(this.root, file);
  }

  // ── scope ────────────────────────────────────────────────────────

  /** Find the declaration of `name` visible from `node`. */
  lookup(name, node) {
    for (let n = node; n; n = n.parent) {
      if (FUNCTION_TYPES.has(n.type)) {
        for (const p of n.params)
          if (patternNames(p).includes(name))
            return { kind: "param", scope: n, pattern: p };
        if (n.id?.name === name && n.type === "FunctionExpression")
          return { kind: "function", node: n };
      }
      if (
        (n.type === "ForOfStatement" || n.type === "ForInStatement") &&
        n.left.type === "VariableDeclaration"
      ) {
        for (const d of n.left.declarations)
          if (patternNames(d.id).includes(name))
            return { kind: "loop", scope: n, pattern: d.id };
      }
      if (
        n.type === "CatchClause" &&
        n.param &&
        patternNames(n.param).includes(name)
      )
        return { kind: "unknown" };
      const body =
        n.type === "BlockStatement" || n.type === "Program"
          ? n.body
          : n.type === "SwitchCase"
            ? n.consequent
            : null;
      if (body) {
        for (const s of body) {
          const decl =
            s.type === "ExportNamedDeclaration" && s.declaration
              ? s.declaration
              : s;
          if (decl.type === "VariableDeclaration") {
            for (const d of decl.declarations)
              if (patternNames(d.id).includes(name))
                return { kind: "var", declarator: d };
          } else if (
            (decl.type === "FunctionDeclaration" ||
              decl.type === "TSDeclareFunction") &&
            decl.id?.name === name
          ) {
            return { kind: "function", node: decl };
          } else if (
            decl.type === "ClassDeclaration" &&
            decl.id?.name === name
          ) {
            return { kind: "unknown" };
          } else if (
            (decl.type === "TSEnumDeclaration" ||
              decl.type === "TSModuleDeclaration") &&
            decl.id?.name === name
          ) {
            return { kind: "unknown" };
          } else if (s.type === "ImportDeclaration") {
            for (const spec of s.specifiers)
              if (spec.local.name === name)
                return { kind: "import", decl: s, spec };
          }
        }
      }
    }
    return null;
  }

  /** The value an export `name` of `file` has (following re-exports). */
  exportOf(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return UNKNOWN;
    seen.add(key);
    const program = this.program(file);
    if (!program) return UNKNOWN;
    for (const s of program.body) {
      if (s.type === "ExportNamedDeclaration") {
        if (s.declaration) {
          const d = s.declaration;
          if (d.type === "VariableDeclaration") {
            for (const v of d.declarations)
              if (patternNames(v.id).includes(name))
                return this.declaratorValue(v, name, new Map());
          } else if (d.type === "FunctionDeclaration" && d.id?.name === name) {
            return new Closure(d);
          }
        }
        for (const spec of s.specifiers ?? []) {
          const exported =
            spec.exported.type === "Identifier"
              ? spec.exported.name
              : spec.exported.value;
          if (exported !== name) continue;
          if (s.source) {
            const target = this.resolveImport(file, s.source.value);
            if (!target) return UNKNOWN;
            const local =
              spec.type === "ExportNamespaceSpecifier" ? null : spec.local.name;
            return local ? this.exportOf(target, local, seen) : UNKNOWN;
          }
          return this.identifier(spec.local.name, spec, new Map());
        }
      } else if (s.type === "ExportAllDeclaration") {
        const target = this.resolveImport(file, s.source.value);
        if (!target) continue;
        const v = this.exportOf(target, name, seen);
        if (v !== UNKNOWN) return v;
      }
    }
    return UNKNOWN;
  }

  resolveImport(fromFile, spec) {
    if (spec.startsWith(".")) {
      const base = resolve(dirname(fromFile), spec);
      const stripped = base.replace(/\.(js|mjs|jsx)$/, "");
      for (const cand of [
        base,
        `${stripped}.ts`,
        `${stripped}.tsx`,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mjs`,
        `${base}.js`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ]) {
        if (existsSync(cand) && statSync(cand).isFile()) return cand;
      }
      return null;
    }
    return this.resolvePackage?.(spec) ?? null;
  }

  // ── evaluation ───────────────────────────────────────────────────

  declaratorValue(d, name, env) {
    if (!d.init) return UNKNOWN;
    if (d.id.type === "Identifier") return this.eval(d.init, env);
    // `const { a, b } = obj` / `const [a, b] = arr`
    const value = this.eval(d.init, env);
    const bound = new Map();
    this.bindPattern(d.id, value, bound, env);
    return bound.has(name) ? bound.get(name) : UNKNOWN;
  }

  bindPattern(p, value, out, env) {
    if (!p) return;
    if (p.type === "Identifier") out.set(p.name, value);
    else if (p.type === "AssignmentPattern") {
      const v =
        value === undefined || value === UNKNOWN
          ? value === undefined
            ? this.eval(p.right, env)
            : UNKNOWN
          : value;
      this.bindPattern(p.left, v, out, env);
    } else if (p.type === "TSParameterProperty")
      this.bindPattern(p.parameter, value, out, env);
    else if (p.type === "ArrayPattern") {
      p.elements.forEach((e, i) => {
        if (!e) return;
        if (e.type === "RestElement")
          this.bindPattern(
            e.argument,
            Array.isArray(value) ? value.slice(i) : UNKNOWN,
            out,
            env,
          );
        else
          this.bindPattern(
            e,
            Array.isArray(value) ? value[i] : UNKNOWN,
            out,
            env,
          );
      });
    } else if (p.type === "ObjectPattern") {
      for (const prop of p.properties) {
        if (prop.type === "RestElement") {
          this.bindPattern(prop.argument, UNKNOWN, out, env);
          continue;
        }
        const k = propKey(prop);
        const v =
          value && typeof value === "object" && !Array.isArray(value) && k
            ? value[k]
            : UNKNOWN;
        this.bindPattern(prop.value, v, out, env);
      }
    }
  }

  identifier(name, node, env) {
    if (name === "undefined") return undefined;
    const found = this.lookup(name, node);
    if (!found) return UNKNOWN;
    if (found.kind === "param" || found.kind === "loop") {
      const bound = env.get(found.scope);
      if (!bound) throw new NeedBinding(found.scope);
      return bound.has(name) ? bound.get(name) : UNKNOWN;
    }
    if (found.kind === "var")
      return this.declaratorValue(found.declarator, name, env);
    if (found.kind === "function") {
      return new Closure(found.node, env);
    }
    if (found.kind === "import") {
      let p = found.decl;
      while (p.parent) p = p.parent;
      const target = this.resolveImport(p.file, found.decl.source.value);
      if (!target) return UNKNOWN;
      if (found.spec.type === "ImportSpecifier") {
        const imported =
          found.spec.imported.type === "Identifier"
            ? found.spec.imported.name
            : found.spec.imported.value;
        return this.exportOf(target, imported);
      }
      return UNKNOWN;
    }
    return UNKNOWN;
  }

  eval(node, env) {
    if (this.depth > 60) return UNKNOWN;
    this.depth++;
    try {
      return this.evalInner(unwrap(node), env);
    } finally {
      this.depth--;
    }
  }

  evalInner(n, env) {
    if (!n) return UNKNOWN;
    switch (n.type) {
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
        return n.value;
      case "NullLiteral":
        return null;
      case "RegExpLiteral":
        return new RegExp(n.pattern, n.flags);
      case "TemplateLiteral": {
        let s = "";
        let pattern = false;
        n.quasis.forEach((q, i) => {
          s += q.value.cooked ?? q.value.raw;
          if (i < n.expressions.length) {
            const v = this.eval(n.expressions[i], env);
            if (v instanceof Pattern) {
              s += v.glob;
              pattern = true;
            } else if (
              v === UNKNOWN ||
              v instanceof Choice ||
              (typeof v === "object" && v !== null)
            ) {
              s += "*";
              pattern = true;
            } else s += String(v);
          }
        });
        return pattern ? new Pattern(s) : s;
      }
      case "Identifier":
        return this.identifier(n.name, n, env);
      case "BinaryExpression": {
        if (n.operator !== "+") return UNKNOWN;
        const a = this.eval(n.left, env);
        const b = this.eval(n.right, env);
        if (typeof a === "number" && typeof b === "number") return a + b;
        const str = (v) =>
          v instanceof Pattern
            ? v.glob
            : v === UNKNOWN || (typeof v === "object" && v !== null)
              ? "*"
              : String(v);
        if (
          isKnown(a) &&
          isKnown(b) &&
          typeof a !== "object" &&
          typeof b !== "object"
        )
          return String(a) + String(b);
        if (
          typeof a === "string" ||
          typeof b === "string" ||
          a instanceof Pattern ||
          b instanceof Pattern
        )
          return new Pattern(str(a) + str(b));
        return UNKNOWN;
      }
      case "LogicalExpression": {
        const a = this.eval(n.left, env);
        if (a === UNKNOWN || a instanceof Pattern) return a;
        if (n.operator === "??")
          return a === null || a === undefined ? this.eval(n.right, env) : a;
        if (n.operator === "||") return a ? a : this.eval(n.right, env);
        if (n.operator === "&&") return a ? this.eval(n.right, env) : a;
        return UNKNOWN;
      }
      case "ConditionalExpression": {
        const t = this.eval(n.test, env);
        if (isKnown(t)) return this.eval(t ? n.consequent : n.alternate, env);
        const options = [];
        for (const branch of [n.consequent, n.alternate]) {
          const v = this.eval(branch, env);
          if (v instanceof Choice) options.push(...v.options);
          else options.push(v);
        }
        if (options.every((o) => typeof o === "string" || o instanceof Pattern))
          return new Choice(options);
        // A feature gate (`supports(x) ? table : null`): the surface is
        // what exists when the feature is there.
        const present = options.filter(
          (o) =>
            o !== null &&
            o !== undefined &&
            !(
              o &&
              typeof o === "object" &&
              !Array.isArray(o) &&
              Object.keys(o).length === 0
            ),
        );
        return present.length === 1 ? present[0] : UNKNOWN;
      }
      case "UnaryExpression": {
        const v = this.eval(n.argument, env);
        if (!isKnown(v)) return UNKNOWN;
        if (n.operator === "!") return !v;
        if (n.operator === "-") return -v;
        return UNKNOWN;
      }
      case "ObjectExpression": {
        const out = {};
        for (const p of n.properties) {
          if (p.type === "SpreadElement") {
            const v = this.eval(p.argument, env);
            if (v && typeof v === "object" && !Array.isArray(v))
              Object.assign(out, v);
            continue;
          }
          let k = propKey(p);
          if (k === null && p.computed) {
            const kv = this.eval(p.key, env);
            if (typeof kv === "string" || typeof kv === "number")
              k = String(kv);
          }
          if (k === null) continue;
          out[k] =
            p.type === "ObjectMethod"
              ? new Closure(p, env)
              : this.lazy(p.value, env);
        }
        return out;
      }
      case "ArrayExpression": {
        const out = [];
        for (const e of n.elements) {
          if (!e) {
            out.push(undefined);
            continue;
          }
          if (e.type === "SpreadElement") {
            const v = this.eval(e.argument, env);
            if (Array.isArray(v)) out.push(...v);
            else out.push(UNKNOWN);
            continue;
          }
          out.push(this.eval(e, env));
        }
        return out;
      }
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const obj = this.eval(n.object, env);
        if (obj === null || obj === undefined)
          return n.optional ? undefined : UNKNOWN;
        if (!isKnown(obj)) return UNKNOWN;
        let key;
        if (n.computed) {
          key = this.eval(n.property, env);
          if (!isKnown(key)) return UNKNOWN;
        } else key = n.property.name;
        if (typeof obj === "string" && key === "length") return obj.length;
        if (Array.isArray(obj) && key === "length") return obj.length;
        if (typeof obj === "object" && key in obj) return force(obj[key]);
        return typeof obj === "object" ? undefined : UNKNOWN;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return new Closure(n, env);
      case "CallExpression":
      case "OptionalCallExpression":
        return this.call(n, env);
      case "NewExpression":
        return UNKNOWN;
      default:
        return UNKNOWN;
    }
  }

  /** Object property values are evaluated on first read. */
  lazy(node, env) {
    return new Lazy(() => this.eval(node, env));
  }

  call(n, env) {
    const callee = unwrap(n.callee);
    // Method calls on known values.
    if (
      (callee.type === "MemberExpression" ||
        callee.type === "OptionalMemberExpression") &&
      !callee.computed
    ) {
      const method = callee.property.name;
      const target = this.eval(callee.object, env);
      const args = () => n.arguments.map((a) => this.eval(a, env));
      if (Array.isArray(target)) {
        const fn = n.arguments[0] ? this.eval(n.arguments[0], env) : UNKNOWN;
        const apply = (item, i) =>
          fn instanceof Closure ? this.invoke(fn, [item, i], env) : UNKNOWN;
        switch (method) {
          case "map":
            return target.map((x, i) => apply(force(x), i));
          case "flatMap":
            return target.flatMap((x, i) => {
              const r = apply(force(x), i);
              return Array.isArray(r) ? r : [r];
            });
          case "filter":
            return target.filter((x, i) => {
              const r = apply(force(x), i);
              return r === UNKNOWN || r instanceof Pattern ? true : Boolean(r);
            });
          case "concat":
            return target.concat(...args());
          case "slice":
            return target.slice(...args());
          case "flat":
            return target.flat();
          default:
            return UNKNOWN;
        }
      }
      if (typeof target === "string") {
        const a = args();
        if (!a.every((x) => isKnown(x))) return UNKNOWN;
        const fn = String.prototype[method];
        if (
          typeof fn === "function" &&
          [
            "toLowerCase",
            "toUpperCase",
            "replace",
            "replaceAll",
            "split",
            "trim",
            "slice",
            "concat",
            "padStart",
            "padEnd",
          ].includes(method)
        )
          return fn.apply(target, a);
        return UNKNOWN;
      }
      if (target && typeof target === "object" && method in target) {
        const fn = force(target[method]);
        if (fn instanceof Closure)
          return this.invoke(
            fn,
            n.arguments.map((a) => this.eval(a, env)),
            env,
          );
      }
      if (
        callee.object.type === "Identifier" &&
        callee.object.name === "Object"
      ) {
        const a = args();
        if (method === "keys" && a[0] && typeof a[0] === "object")
          return Object.keys(a[0]);
        if (method === "values" && a[0] && typeof a[0] === "object")
          return Object.values(a[0]).map(force);
        if (method === "entries" && a[0] && typeof a[0] === "object")
          return Object.entries(a[0]).map(([k, v]) => [k, force(v)]);
        if (method === "freeze") return a[0];
      }
      return UNKNOWN;
    }
    const fn = this.eval(callee, env);
    if (fn instanceof Closure)
      return this.invoke(
        fn,
        n.arguments.map((a) =>
          a.type === "SpreadElement" ? UNKNOWN : this.eval(a, env),
        ),
        env,
      );
    return UNKNOWN;
  }

  /** Call a closure: bind its parameters, evaluate its result. */
  invoke(fn, args, env) {
    const node = fn.node;
    if (!FUNCTION_TYPES.has(node.type) || node.async || node.generator)
      return UNKNOWN;
    const bound = new Map();
    node.params.forEach((p, i) => this.bindPattern(p, args[i], bound, env));
    const inner = new Map(fn.env ?? env);
    for (const [k, v] of env) inner.set(k, v);
    inner.set(node, bound);
    const body = node.body;
    if (body.type !== "BlockStatement") return this.eval(body, inner);
    const ret = body.body.find((s) => s.type === "ReturnStatement");
    if (!ret?.argument) return UNKNOWN;
    return this.eval(ret.argument, inner);
  }

  // ── contexts: evaluate a node under every binding of its free params ──

  /**
   * Every value `node` takes, one per binding context. A free parameter
   * of an enclosing function or loop is bound by enumerating the
   * function's call sites (a `.map(fn)` over a known array, or calls of
   * its name) or the loop's iterable. Returns `[{ value, env }]`.
   */
  evalAll(node, env = new Map(), budget = { n: 0 }) {
    for (;;) {
      try {
        return [{ value: force(this.eval(node, env)), env }];
      } catch (e) {
        if (!(e instanceof NeedBinding)) throw e;
        if (++budget.n > 2000) return [{ value: UNKNOWN, env }];
        const contexts = this.contexts(e.scope, env, budget);
        if (contexts.length === 0) {
          const next = new Map(env);
          next.set(e.scope, new Map());
          env = next;
          continue;
        }
        const out = [];
        for (const c of contexts) out.push(...this.evalAll(node, c, budget));
        return out;
      }
    }
  }

  /** The binding contexts of `scope` (a function or a for…of). */
  contexts(scope, env, budget) {
    const out = [];
    const withBinding = (outerEnv, bound) => {
      const next = new Map(outerEnv);
      next.set(scope, bound);
      return next;
    };
    if (scope.type === "ForOfStatement") {
      for (const { value: iter, env: e } of this.evalAll(
        scope.right,
        env,
        budget,
      )) {
        if (!Array.isArray(iter)) continue;
        for (const item of iter) {
          const bound = new Map();
          this.bindPattern(
            scope.left.declarations[0].id,
            force(item),
            bound,
            e,
          );
          out.push(withBinding(e, bound));
        }
      }
      return out;
    }
    if (!FUNCTION_TYPES.has(scope.type)) return out;
    const parent = scope.parent;
    // `arr.map(fn)` / `arr.flatMap(fn)` / `arr.forEach(fn)` / `arr.filter(fn)`
    if (
      parent &&
      (parent.type === "CallExpression" ||
        parent.type === "OptionalCallExpression") &&
      parent.arguments[0] === scope &&
      (parent.callee.type === "MemberExpression" ||
        parent.callee.type === "OptionalMemberExpression") &&
      ["map", "flatMap", "forEach", "filter", "some", "every", "find"].includes(
        parent.callee.property?.name,
      )
    ) {
      for (const { value: arr, env: e } of this.evalAll(
        parent.callee.object,
        env,
        budget,
      )) {
        if (!Array.isArray(arr)) continue;
        arr.forEach((item, i) => {
          const bound = new Map();
          scope.params.forEach((p, j) =>
            this.bindPattern(
              p,
              j === 0 ? force(item) : j === 1 ? i : UNKNOWN,
              bound,
              e,
            ),
          );
          out.push(withBinding(e, bound));
        });
      }
      return out;
    }
    // A named function: every call of its name in its scope.
    let name = null;
    let within = null;
    if (scope.type === "FunctionDeclaration" && scope.id) {
      name = scope.id.name;
      within = scope.parent;
    } else if (
      parent?.type === "VariableDeclarator" &&
      parent.init === scope &&
      parent.id.type === "Identifier"
    ) {
      name = parent.id.name;
      within = parent.parent?.parent;
    }
    if (!name || !within) return out;
    const calls = [];
    walkAst(within, (c) => {
      if (
        (c.type === "CallExpression" || c.type === "OptionalCallExpression") &&
        unwrap(c.callee)?.type === "Identifier" &&
        unwrap(c.callee).name === name
      )
        calls.push(c);
    });
    for (const c of calls) {
      // Arguments are evaluated where the call is: each argument may have
      // contexts of its own.
      const argNodes = c.arguments;
      const perCall = this.evalAll(
        { type: "ArrayExpression", elements: argNodes, parent: c },
        env,
        budget,
      );
      for (const { value: args, env: e } of perCall) {
        const bound = new Map();
        scope.params.forEach((p, j) =>
          this.bindPattern(
            p,
            Array.isArray(args) ? force(args[j]) : UNKNOWN,
            bound,
            e,
          ),
        );
        out.push(withBinding(e, bound));
      }
    }
    return out;
  }
}

class Lazy {
  constructor(thunk) {
    this.thunk = thunk;
    this.done = false;
    this.value = undefined;
  }
  get() {
    if (!this.done) {
      this.done = true;
      this.value = UNKNOWN;
      this.value = this.thunk();
    }
    return this.value;
  }
}

/** Resolve a lazy property value (deeply for arrays/objects on demand). */
export function force(v) {
  return v instanceof Lazy ? v.get() : v;
}

/** A plain-data copy: lazies forced, closures dropped. */
export function plain(v, depth = 0) {
  v = force(v);
  if (depth > 8) return UNKNOWN;
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (
    v &&
    typeof v === "object" &&
    !(v instanceof Pattern) &&
    !(v instanceof RegExp)
  ) {
    if (v instanceof Closure) return UNKNOWN;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x, depth + 1);
    return out;
  }
  return v;
}

export { isKnown, unwrap, propKey };
