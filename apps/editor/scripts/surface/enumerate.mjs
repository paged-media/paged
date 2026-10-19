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

// THE SURFACE, enumerated from the code that declares it.
//
// One list of `{ kind, id, origin, owner, source }` per surface kind, read
// statically (no build, no wasm, no browser) so the gate runs in the
// editor's `checks` job and in a second locally:
//
//   command      host: every object literal shaped like a command
//                (`id` + `title` + `handler`) in the editor's sources;
//                plugins: manifest `contributes.commands` and the typed
//                `contributes.objectModel.commands`
//   panel        host: `BUILT_IN_PANELS`; plugins: manifest `panels`
//   tool         host: `BUILT_IN_TOOLS` (minus `status: "planned"`);
//                plugins: manifest `tools`
//   menu         host: every `{ path, command }` literal; plugins: every
//                `contribute.menu(…)` call, through its loops and tables
//   keybinding   host: every `{ key, command }` literal; plugins: every
//                `contribute.keybinding(…)` call
//   setting      `apps/editor/scripts/settings-inventory.json` (editor
//                settings) plus every tool option (`{ toolId, fields }`)
//   cli          `engine/core/crates/paged-cli/cli.json` (the Rust `paged`),
//                `paged-run`, the TS `paged-node` verbs, `paged-plugin`
//   script       the catalog's `hostFunctions` and the editor's
//                `editor.*` / `demo.*` automation functions
//   importer / exporter   manifest `importers` / `exporters`
//
// Ids derived per registered item by a loop the evaluator cannot unroll
// (a show / hide command per panel, an activation command per tool) are
// FAMILIES: one surface id with a `*`, its members listed beside it.
//
// Anything the evaluator cannot resolve is returned in `unresolved`; the
// gate fails on every site that is neither resolved, a family, nor listed
// in DYNAMIC_SITES with a reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  Choice,
  Evaluator,
  Pattern,
  UNKNOWN,
  force,
  plain,
  propKey,
  unwrap,
  walkAst,
} from "./static-eval.mjs";

// ── the families ─────────────────────────────────────────────────────

/** Derived ids, keyed by the pattern the evaluator produces at their
 *  declaration site. A pattern that maps to no family is unresolved. */
export const FAMILY_OF_PATTERN = new Map([
  ["command paged.panel.show.*", "paged.panel.show.*"],
  ["command paged.panel.hide.*", "paged.panel.hide.*"],
  ["command paged.tool.activate.*", "paged.tool.activate.*"],
  ["keybinding *→paged.tool.activate.*", "*→paged.tool.activate.*"],
  ["menu Window/*", "Window/*"],
  ["menu Window/*/*", "Window/*"],
  ["menu Plugins/*/*", "Plugins/*"],
]);

/** Sites the evaluator cannot resolve, on purpose. Keyed by
 *  `<kind> <file>`; each says why the site is not a static surface. */
export const DYNAMIC_SITES = new Map([
  [
    "command apps/editor/packages/shell/src/bundles/loader.ts",
    "the worker-bundle protocol's passthrough: it registers whatever command a sandboxed " +
      "bundle sends over postMessage; the bundles' own ids are enumerated from their manifests.",
  ],
  [
    "keybinding apps/editor/packages/shell/src/bundles/loader.ts",
    "the worker-bundle protocol's passthrough for a sandboxed bundle's keybindings; no " +
      "first-party bundle uses the worker protocol, so there is nothing static to enumerate.",
  ],
  [
    "menu apps/editor/packages/shell/src/bundles/loader.ts",
    "the worker-bundle protocol's passthrough for a sandboxed bundle's menu entries; no " +
      "first-party bundle uses the worker protocol, so there is nothing static to enumerate.",
  ],
  [
    "keybinding apps/editor/packages/shell/src/PagedShell.tsx",
    "not a registration: the journal's state snapshot maps registries.keybindings.list() " +
      "to { key, command } pairs, which has the shape of a binding but registers nothing.",
  ],
  [
    "setting modules/draw/packages/draw-bundle/src/tool-options.ts",
    "toolOptionsSpecOf(def) only strips the defaults from a definition; the definitions " +
      "themselves are defineToolOptions({ toolId, fields }) literals, which the gate reads directly.",
  ],
]);

// ── files ────────────────────────────────────────────────────────────

export function listFiles(root, paths) {
  try {
    const out = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...paths,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return out
      .split("\0")
      .filter(Boolean)
      .filter((f) => existsSync(join(root, f)));
  } catch {
    // No git (a source tarball): walk instead.
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir))) {
        if (["node_modules", ".git", "target", "dist", ".moon"].includes(entry))
          continue;
        const p = join(dir, entry);
        const st = statSync(join(root, p));
        if (st.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    for (const p of paths) if (existsSync(join(root, p))) walk(p);
    return out;
  }
}

const isSourceFile = (f) =>
  /\.(ts|tsx)$/.test(f) &&
  !/\.d\.ts$/.test(f) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) &&
  !/(^|\/)(test|tests|__tests__|e2e)\//.test(f);

// ── workspace packages (for bare imports) ────────────────────────────

export function workspacePackages(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const globs = rootPkg.workspaces?.packages ?? rootPkg.workspaces ?? [];
  const dirs = [];
  // `dir/*`, `modules/*/packages/*`: one `*` per path segment.
  const expand = (segments, base) => {
    if (segments.length === 0) {
      if (existsSync(join(root, base, "package.json"))) dirs.push(base);
      return;
    }
    const [head, ...rest] = segments;
    if (head === "*") {
      if (!existsSync(join(root, base))) return;
      for (const e of readdirSync(join(root, base))) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const d = base ? join(base, e) : e;
        if (statSync(join(root, d)).isDirectory()) expand(rest, d);
      }
    } else expand(rest, base ? join(base, head) : head);
  };
  for (const g of globs) expand(g.split("/"), "");
  const map = new Map();
  for (const d of dirs) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(root, d, "package.json"), "utf8"),
      );
      if (pkg.name) map.set(pkg.name, { dir: d, pkg });
    } catch {
      /* not a package */
    }
  }
  return map;
}

function packageResolver(root, packages) {
  const entryOf = (target) => {
    if (typeof target === "string") return target;
    if (target && typeof target === "object")
      return (
        entryOf(target.source) ??
        entryOf(target.import) ??
        entryOf(target.default) ??
        entryOf(target.types) ??
        null
      );
    return null;
  };
  return (spec) => {
    const m = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(spec);
    if (!m) return null;
    const entry = packages.get(m[1]);
    if (!entry) return null;
    const sub = m[2] ? `.${m[2]}` : ".";
    const exp = entry.pkg.exports;
    let target = null;
    if (exp && typeof exp === "object" && !Array.isArray(exp)) {
      if (sub in exp) target = entryOf(exp[sub]);
      else if (sub === "." && !Object.keys(exp).some((k) => k.startsWith(".")))
        target = entryOf(exp);
    } else if (typeof exp === "string" && sub === ".") target = exp;
    if (!target && sub === ".") target = entry.pkg.main ?? entry.pkg.module;
    const cands = [];
    if (target) cands.push(join(root, entry.dir, target));
    if (sub === ".") cands.push(join(root, entry.dir, "src/index.ts"));
    for (const c of cands) {
      // A built entry (dist/…js) maps back onto its source when there is one.
      const src = c.replace(/\/dist\//, "/src/").replace(/\.m?js$/, ".ts");
      for (const cand of [c, src, src.replace(/\.ts$/, ".tsx")]) {
        if (
          existsSync(cand) &&
          statSync(cand).isFile() &&
          /\.(ts|tsx|mjs|js)$/.test(cand)
        )
          return cand;
      }
    }
    return null;
  };
}

// ── helpers ──────────────────────────────────────────────────────────

const objectProps = (n) => {
  const props = new Map();
  for (const p of n.properties ?? []) {
    if (p.type !== "ObjectProperty" && p.type !== "ObjectMethod") continue;
    const k = propKey(p);
    if (k) props.set(k, p);
  }
  return props;
};

/** Every value the given property nodes take, per binding context. */
function valuesOf(ev, nodes, parent) {
  const arr = { type: "ArrayExpression", elements: nodes, parent };
  const out = [];
  for (const { value } of ev.evalAll(arr)) {
    const row = Array.isArray(value)
      ? value.map((v) => force(v))
      : nodes.map(() => UNKNOWN);
    // A `?:` with an unknown test is a Choice: one row per branch.
    let rows = [[]];
    for (const v of row) {
      const options = v instanceof Choice ? v.options : [v];
      rows = rows.flatMap((r) => options.map((o) => [...r, o]));
    }
    out.push(...rows);
  }
  return out;
}

const asText = (v) =>
  typeof v === "string"
    ? { id: v }
    : v instanceof Pattern
      ? { pattern: v.glob }
      : { unknown: true };

// ── host (the editor itself) ─────────────────────────────────────────

const HOST_ROOTS = ["apps/editor/apps/canvas/src", "apps/editor/packages"];

function hostSources(root) {
  return listFiles(root, HOST_ROOTS).filter(
    (f) =>
      isSourceFile(f) &&
      (/\/src\//.test(f) || f.startsWith("apps/editor/apps/canvas/src/")),
  );
}

/** Shape-matched registrations across a set of files. */
function scanShapes(ev, root, files, origin, owner) {
  const found = { command: [], menu: [], keybinding: [], toolOptions: [] };
  for (const f of files) {
    const program = ev.program(join(root, f));
    if (!program) {
      found.parseErrors = [...(found.parseErrors ?? []), f];
      continue;
    }
    walkAst(program, (n) => {
      if (n.type !== "ObjectExpression") return;
      const props = objectProps(n);
      const at = `${f}:${n.loc?.start.line ?? 0}`;
      const val = (k) => {
        const p = props.get(k);
        return p?.type === "ObjectProperty" ? p.value : null;
      };
      if (
        props.has("id") &&
        props.has("title") &&
        props.has("handler") &&
        val("id")
      ) {
        for (const [id] of valuesOf(ev, [val("id")], n))
          found.command.push({ ...asText(id), at, file: f, origin, owner });
      }
      if (
        props.has("path") &&
        props.has("command") &&
        val("path") &&
        val("command")
      ) {
        for (const [path, command] of valuesOf(
          ev,
          [val("path"), val("command")],
          n,
        ))
          found.menu.push({
            ...asText(path),
            command:
              typeof command === "string"
                ? command
                : command instanceof Pattern
                  ? command.glob
                  : null,
            at,
            file: f,
            origin,
            owner,
          });
      }
      if (
        props.has("key") &&
        props.has("command") &&
        val("key") &&
        val("command")
      ) {
        for (const [key, command] of valuesOf(
          ev,
          [val("key"), val("command")],
          n,
        )) {
          const k =
            typeof key === "string"
              ? key
              : key instanceof Pattern
                ? key.glob
                : "*";
          const c =
            typeof command === "string"
              ? command
              : command instanceof Pattern
                ? command.glob
                : null;
          if (c === null || (k === "*" && !(command instanceof Pattern)))
            found.keybinding.push({
              unknown: true,
              at,
              file: f,
              origin,
              owner,
            });
          else if (k.includes("*") || c.includes("*"))
            found.keybinding.push({
              pattern: `${k}→${c}`,
              at,
              file: f,
              origin,
              owner,
            });
          else
            found.keybinding.push({
              id: `${k}→${c}`,
              at,
              file: f,
              origin,
              owner,
            });
        }
      }
      if (
        props.has("toolId") &&
        props.has("fields") &&
        val("toolId") &&
        val("fields")
      ) {
        for (const [toolId, fields] of valuesOf(
          ev,
          [val("toolId"), val("fields")],
          n,
        )) {
          const keys = Array.isArray(fields)
            ? fields
                .map((x) => plain(x)?.key)
                .filter((k) => typeof k === "string")
            : [];
          found.toolOptions.push({
            toolId: typeof toolId === "string" ? toolId : null,
            keys,
            fieldCount: Array.isArray(fields) ? fields.length : 0,
            at,
            file: f,
            origin,
            owner,
          });
        }
      }
    });
  }
  return found;
}

/** The value `NAME` has at the top level of `file`: a `const` there, or
 *  an import followed to its definition. */
function constValue(ev, root, file, name) {
  const program = ev.program(join(root, file));
  if (!program) return UNKNOWN;
  for (const s of program.body) {
    const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (d?.type === "VariableDeclaration") {
      for (const v of d.declarations)
        if (v.id.type === "Identifier" && v.id.name === name && v.init)
          return plain(ev.eval(v.init, new Map()));
    }
    if (s.type === "ImportDeclaration")
      for (const spec of s.specifiers)
        if (spec.type === "ImportSpecifier" && spec.local.name === name) {
          const target = ev.resolveImport(join(root, file), s.source.value);
          const imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          return target ? plain(ev.exportOf(target, imported)) : UNKNOWN;
        }
  }
  return UNKNOWN;
}

// ── plugins (the bundles the editor loads) ───────────────────────────

const BUNDLE_TABLE = "apps/editor/apps/canvas/src/plugin-bundle-table.ts";

function loadedBundles(root, packages) {
  const src = readFileSync(join(root, BUNDLE_TABLE), "utf8");
  const names = [
    ...src.matchAll(/import\(\s*"(@paged-media\/[^"]+)"\s*\)/g),
  ].map((m) => m[1]);
  return [...new Set(names)].map((name) => {
    const entry = packages.get(name);
    return { name, dir: entry?.dir ?? null };
  });
}

function pluginScan(ev, root, bundle) {
  const out = {
    command: [],
    menu: [],
    keybinding: [],
    toolOptions: [],
    unresolved: [],
  };
  const files = listFiles(root, [join(bundle.dir, "src")]).filter(isSourceFile);
  for (const f of files) {
    const program = ev.program(join(root, f));
    if (!program) continue;
    walkAst(program, (n) => {
      if (n.type !== "CallExpression") return;
      const callee = unwrap(n.callee);
      if (callee?.type !== "MemberExpression" || callee.computed) return;
      const obj = unwrap(callee.object);
      const isContribute =
        (obj?.type === "MemberExpression" &&
          !obj.computed &&
          obj.property.name === "contribute") ||
        (obj?.type === "Identifier" && obj.name === "contribute");
      if (!isContribute) return;
      const method = callee.property.name;
      if (method !== "menu" && method !== "keybinding") return;
      const arg = unwrap(n.arguments[0]);
      const at = `${f}:${n.loc?.start.line ?? 0}`;
      if (arg?.type !== "ObjectExpression") {
        out.unresolved.push({ kind: method, at, file: f });
        return;
      }
      const props = objectProps(arg);
      const v = (k) =>
        props.get(k)?.type === "ObjectProperty" ? props.get(k).value : null;
      if (method === "menu") {
        if (!v("path") || !v("command")) {
          out.unresolved.push({ kind: "menu", at, file: f });
          return;
        }
        for (const [path, command] of valuesOf(
          ev,
          [v("path"), v("command")],
          arg,
        )) {
          if (typeof path !== "string" || typeof command !== "string")
            out.unresolved.push({ kind: "menu", at, file: f });
          else out.menu.push({ id: path, command, at, file: f });
        }
      } else {
        if (!v("key") || !v("command")) {
          out.unresolved.push({ kind: "keybinding", at, file: f });
          return;
        }
        for (const [key, command] of valuesOf(
          ev,
          [v("key"), v("command")],
          arg,
        )) {
          if (typeof key !== "string" || typeof command !== "string")
            out.unresolved.push({ kind: "keybinding", at, file: f });
          else
            out.keybinding.push({
              id: `${key}→${command}`,
              command,
              at,
              file: f,
            });
        }
      }
    });
  }
  const shapes = scanShapes(ev, root, files, "plugin", bundle.name);
  out.toolOptions = shapes.toolOptions;
  return out;
}

// ── cli ──────────────────────────────────────────────────────────────

function cliSurface(ev, root) {
  const items = [];
  const cliJson = "engine/core/crates/paged-cli/cli.json";
  const surface = JSON.parse(readFileSync(join(root, cliJson), "utf8"));
  const bin = surface.binary ?? "paged";
  items.push({ id: bin, source: cliJson, about: surface.about });
  const walk = (cmds, prefix) => {
    for (const c of cmds ?? []) {
      const path = `${prefix} ${c.name}`;
      items.push({ id: path, source: cliJson, about: c.about });
      walk(c.subcommands ?? c.commands, path);
    }
  };
  walk(surface.commands, bin);
  // paged-run: the NDJSON session binary, no argv.
  if (existsSync(join(root, "engine/core/crates/paged-run/Cargo.toml")))
    items.push({ id: "paged-run", source: "engine/core/crates/paged-run" });
  // paged-node: the TS CLI's verb table.
  const verbsFile = "platform/extensions/packages/cli/src/verbs.ts";
  const verbs = constValue(ev, root, verbsFile, "VERBS");
  const verbNames = Array.isArray(verbs)
    ? verbs.map((v) => v?.name).filter((x) => typeof x === "string")
    : [];
  const cliPkg = JSON.parse(
    readFileSync(
      join(root, "platform/extensions/packages/cli/package.json"),
      "utf8",
    ),
  );
  const nodeBin = Object.keys(cliPkg.bin ?? {})[0] ?? "paged-node";
  items.push({ id: nodeBin, source: verbsFile });
  for (const v of verbNames)
    items.push({ id: `${nodeBin} ${v}`, source: verbsFile });
  // paged-plugin: plugin-sdk's bin, dispatching on argv[0].
  const pluginBinFile =
    "platform/extensions/packages/plugin-sdk/bin/paged-plugin.mjs";
  const pluginBin = readFileSync(join(root, pluginBinFile), "utf8");
  const subs = [
    ...pluginBin.matchAll(/command [!=]== "([a-z][a-z0-9-]*)"/g),
  ].map((m) => m[1]);
  items.push({ id: "paged-plugin", source: pluginBinFile });
  for (const s of new Set(subs))
    items.push({ id: `paged-plugin ${s}`, source: pluginBinFile });
  return { items, verbCount: verbNames.length, pluginSubs: new Set(subs).size };
}

// ── script ───────────────────────────────────────────────────────────

const CATALOG = "engine/core/crates/paged-introspect/catalog.json";
const AUTOMATION = "apps/editor/packages/shell/src/demo/automation.ts";

function scriptSurface(ev, root) {
  const items = [];
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), "utf8"));
  const hostFunctions = catalog.hostFunctions ?? catalog.host_functions ?? [];
  for (const h of hostFunctions) {
    const name = typeof h === "string" ? h : (h.name ?? h.path ?? h.id);
    if (typeof name === "string") items.push({ id: name, source: CATALOG });
  }
  const catalogCount = items.length;
  for (const b of bootstrapFunctions(root))
    items.push({ id: b, source: "engine/core/crates/paged-script/src" });
  // The editor's automation layer: `paged.run`, `editor.*`, `demo.*`.
  const automation = automationFunctions(ev, root);
  for (const a of automation) items.push({ id: a, source: AUTOMATION });
  return { items, catalogCount, automationCount: automation.length };
}

/** The automation layer's globals, from its declarations: `DemoGlobals`
 *  maps each global (`paged`, `editor`, `demo`) to an interface, whose
 *  members (through `extends`, across files) are the functions. */
function automationFunctions(ev, root) {
  if (!existsSync(join(root, AUTOMATION))) return [];
  const file = join(root, AUTOMATION);
  const program = ev.program(file);
  if (!program) return [];
  const interfaceIn = (prog, name) => {
    for (const s of prog.body) {
      const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
      if (d?.type === "TSInterfaceDeclaration" && d.id.name === name) return d;
    }
    return null;
  };
  const membersOf = (prog, progFile, name, seen = new Set()) => {
    if (seen.has(`${progFile}#${name}`)) return [];
    seen.add(`${progFile}#${name}`);
    let decl = interfaceIn(prog, name);
    let declFile = progFile;
    if (!decl) {
      // Imported: follow the import to its file.
      for (const s of prog.body) {
        if (s.type !== "ImportDeclaration") continue;
        for (const spec of s.specifiers)
          if (spec.local.name === name) {
            const target = ev.resolveImport(progFile, s.source.value);
            const tp = target && ev.program(target);
            if (tp)
              return membersOf(tp, target, spec.imported?.name ?? name, seen);
          }
      }
      return [];
    }
    const out = [];
    for (const m of decl.body.body) {
      if (
        (m.type === "TSMethodSignature" || m.type === "TSPropertySignature") &&
        !m.computed &&
        m.key.type === "Identifier"
      )
        out.push(m.key.name);
    }
    for (const h of decl.extends ?? [])
      if (h.expression.type === "Identifier")
        out.push(...membersOf(prog, declFile, h.expression.name, seen));
    return out;
  };
  const globals = interfaceIn(program, "DemoGlobals");
  if (!globals) return [];
  const names = new Set();
  for (const m of globals.body.body) {
    if (m.type !== "TSPropertySignature" || m.key.type !== "Identifier")
      continue;
    const t = m.typeAnnotation?.typeAnnotation;
    if (t?.type !== "TSTypeReference" || t.typeName.type !== "Identifier")
      continue;
    for (const fn of membersOf(program, file, t.typeName.name))
      names.add(`${m.key.name}.${fn}`);
  }
  return [...names].sort();
}

/** Functions a JS bootstrap adds to the Boa `paged` object outside the
 *  catalog (`paged.frame = function (id) …`). */
function bootstrapFunctions(root) {
  const dir = "engine/core/crates/paged-script/src";
  const out = new Set();
  for (const f of listFiles(root, [dir]).filter((x) => x.endsWith(".rs"))) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/\bpaged\.([A-Za-z_]\w*)\s*=\s*function\b/g))
      out.add(`paged.${m[1]}`);
  }
  return [...out].sort();
}

// ── settings ─────────────────────────────────────────────────────────

export const SETTINGS_INVENTORY = "apps/editor/scripts/settings-inventory.json";

function settingsInventory(root) {
  if (!existsSync(join(root, SETTINGS_INVENTORY))) return null;
  const data = JSON.parse(readFileSync(join(root, SETTINGS_INVENTORY), "utf8"));
  const list = Array.isArray(data) ? data : (data.settings ?? []);
  return list
    .map((s) => (typeof s === "string" ? { id: s } : s))
    .filter((s) => typeof s?.id === "string")
    .map((s) => ({ id: s.id, source: s.source ?? SETTINGS_INVENTORY }));
}

// ── the whole surface ────────────────────────────────────────────────

/**
 * Enumerate every surface id. Returns
 * `{ items, families, unresolved, sentinels, bundles, notes }`.
 */
export function enumerateSurface(root) {
  const packages = workspacePackages(root);
  const ev = new Evaluator({
    root,
    resolvePackage: packageResolver(root, packages),
  });
  const items = [];
  const unresolved = [];
  const notes = [];
  const seen = new Set();
  const add = (kind, id, rest) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, id, ...rest });
  };
  const patterns = [];

  // Host panels and tools.
  const panelsFile = "apps/editor/apps/canvas/src/main.tsx";
  const hostPanels = constValue(ev, root, panelsFile, "BUILT_IN_PANELS");
  const hostPanelIds = Array.isArray(hostPanels)
    ? hostPanels.map((p) => p?.id).filter((x) => typeof x === "string")
    : [];
  for (const id of hostPanelIds)
    add("panel", id, { origin: "host", owner: "editor", source: panelsFile });

  const toolsFile = "apps/editor/packages/tools/src/built-in-tools.ts";
  const hostTools = constValue(ev, root, toolsFile, "BUILT_IN_TOOLS");
  const liveHostTools = Array.isArray(hostTools)
    ? hostTools.filter(
        (t) => typeof t?.id === "string" && t.status !== "planned",
      )
    : [];
  for (const t of liveHostTools)
    add("tool", t.id, { origin: "host", owner: "editor", source: toolsFile });

  // Host shapes.
  const host = scanShapes(ev, root, hostSources(root), "host", "editor");
  const takeShapes = (shapes, kind) => {
    for (const s of shapes[kind]) {
      if (s.id !== undefined)
        add(kind, s.id, {
          origin: s.origin,
          owner: s.owner,
          source: s.at,
          command: s.command,
        });
      else if (s.pattern !== undefined) patterns.push({ kind, ...s });
      else unresolved.push({ kind, at: s.at, file: s.file });
    }
  };
  takeShapes(host, "command");
  takeShapes(host, "menu");
  takeShapes(host, "keybinding");

  // Plugins.
  const bundles = loadedBundles(root, packages);
  const pluginPanels = [];
  const pluginTools = [];
  const plumbing = [];
  const toolOptions = [...host.toolOptions];
  for (const b of bundles) {
    if (!b.dir) {
      notes.push(
        `bundle ${b.name} is in the bundle table but not a workspace package`,
      );
      continue;
    }
    const manifestPath = join(b.dir, "manifest.json");
    if (!existsSync(join(root, manifestPath))) {
      notes.push(`bundle ${b.name} has no manifest.json`);
      b.missingManifest = true;
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    b.id = manifest.id;
    const c = manifest.contributes ?? {};
    const ids = (list) =>
      (list ?? [])
        .map((e) => (typeof e === "string" ? e : (e?.id ?? e?.type)))
        .filter((x) => typeof x === "string");
    const rest = { origin: "plugin", owner: manifest.id, source: manifestPath };
    for (const id of ids(c.commands)) add("command", id, rest);
    for (const id of ids(c.objectModel?.commands)) add("command", id, rest);
    for (const id of ids(c.panels)) {
      add("panel", id, rest);
      pluginPanels.push(id);
    }
    for (const e of c.tools ?? []) {
      const id = typeof e === "string" ? e : e?.id;
      if (typeof id !== "string") continue;
      if (typeof e === "object" && e.status === "planned") continue;
      add("tool", id, rest);
      pluginTools.push({
        id,
        shortcut: typeof e === "object" ? e.shortcut : undefined,
      });
    }
    for (const id of ids(c.importers)) add("importer", id, rest);
    for (const id of ids(c.exporters)) add("exporter", id, rest);
    for (const [type, list] of [
      ["editContext", c.editContexts],
      ["objectType", c.objectTypes],
      ["partType", c.partTypes],
    ])
      for (const id of ids(list))
        plumbing.push({
          kind: type,
          id,
          owner: manifest.id,
          source: manifestPath,
        });
    const scan = pluginScan(ev, root, b);
    for (const m of scan.menu)
      add("menu", m.id, { ...rest, source: m.at, command: m.command });
    for (const k of scan.keybinding)
      add("keybinding", k.id, { ...rest, source: k.at, command: k.command });
    for (const u of scan.unresolved) unresolved.push(u);
    toolOptions.push(...scan.toolOptions);
    b.counts = {
      commands: ids(c.commands).length + ids(c.objectModel?.commands).length,
      panels: ids(c.panels).length,
      tools: (c.tools ?? []).length,
      importers: ids(c.importers).length,
      exporters: ids(c.exporters).length,
      menus: scan.menu.length,
      keybindings: scan.keybinding.length,
    };
  }

  // Settings: the editor's inventory plus every tool option.
  const inventory = settingsInventory(root);
  if (inventory)
    for (const s of inventory)
      add("setting", s.id, {
        origin: "host",
        owner: "editor",
        source: s.source,
      });
  for (const o of toolOptions) {
    if (!o.toolId) {
      unresolved.push({ kind: "setting", at: o.at, file: o.file });
      continue;
    }
    if (o.keys.length < o.fieldCount)
      unresolved.push({
        kind: "setting",
        at: o.at,
        file: o.file,
        partial: true,
      });
    for (const k of o.keys)
      add("setting", `${o.toolId}.${k}`, {
        origin: o.origin,
        owner: o.owner,
        source: o.at,
      });
  }

  // CLI and script.
  const cli = cliSurface(ev, root);
  for (const c of cli.items)
    add("cli", c.id, {
      origin: "host",
      owner: c.id.split(" ")[0],
      source: c.source,
    });
  const script = scriptSurface(ev, root);
  for (const s of script.items)
    add("script", s.id, {
      origin: "host",
      owner: s.id.split(".")[0],
      source: s.source,
    });

  // Families: map each pattern onto a declared family, with its members.
  const allPanels = [...hostPanelIds, ...pluginPanels];
  const allTools = [
    ...liveHostTools.map((t) => ({ id: t.id, shortcut: t.shortcut })),
    ...pluginTools,
  ];
  const membersOf = new Map([
    [
      "command paged.panel.show.*",
      allPanels.map((p) => `paged.panel.show.${p}`),
    ],
    [
      "command paged.panel.hide.*",
      allPanels.map((p) => `paged.panel.hide.${p}`),
    ],
    [
      "command paged.tool.activate.*",
      allTools.map((t) => `paged.tool.activate.${t.id}`),
    ],
    [
      "keybinding *→paged.tool.activate.*",
      allTools
        .filter((t) => typeof t.shortcut === "string")
        .map((t) => `${t.shortcut}→paged.tool.activate.${t.id}`),
    ],
    ["menu Window/*", hostPanelIds.map((p) => `Window/…/${p}`)],
    ["menu Plugins/*", pluginPanels.map((p) => `Plugins/…/${p}`)],
  ]);
  const families = new Map();
  for (const p of patterns) {
    const family = FAMILY_OF_PATTERN.get(`${p.kind} ${p.pattern}`);
    if (!family) {
      unresolved.push({
        kind: p.kind,
        at: p.at,
        file: p.file,
        pattern: p.pattern,
      });
      continue;
    }
    const key = `${p.kind} ${family}`;
    if (!families.has(key))
      families.set(key, {
        kind: p.kind,
        id: family,
        members: membersOf.get(key) ?? [],
        sources: [],
      });
    families.get(key).sources.push(p.at);
  }
  for (const f of families.values())
    add(f.kind, f.id, {
      origin: "host",
      owner: "editor",
      source: f.sources[0],
      family: true,
      members: f.members,
    });

  const count = (kind, origin) =>
    items.filter((i) => i.kind === kind && (!origin || i.origin === origin))
      .length;
  const sentinels = [
    ["host panels (BUILT_IN_PANELS)", hostPanelIds.length, 60],
    ["host live tools (BUILT_IN_TOOLS)", liveHostTools.length, 15],
    ["host commands", count("command", "host"), 60],
    ["host menu items", count("menu", "host"), 40],
    ["host keybindings", count("keybinding", "host"), 40],
    [
      "loaded bundles (plugin-bundle-table.ts)",
      bundles.filter((b) => b.counts).length,
      9,
    ],
    ["plugin commands", count("command", "plugin"), 150],
    ["plugin panels", count("panel", "plugin"), 25],
    ["plugin tools", count("tool", "plugin"), 40],
    ["plugin menu items", count("menu", "plugin"), 100],
    ["plugin keybindings", count("keybinding", "plugin"), 5],
    ["importers", count("importer"), 8],
    ["exporters", count("exporter"), 6],
    ["tool options", toolOptions.reduce((n, o) => n + o.keys.length, 0), 30],
    [
      "paged CLI commands (cli.json)",
      cli.items.filter((c) => c.id.startsWith("paged ")).length,
      40,
    ],
    ["paged-node verbs", cli.verbCount, 12],
    ["catalog host functions", script.catalogCount, 120],
    ["editor automation functions", script.automationCount, 15],
    ["families", families.size, 6],
  ];

  return {
    items,
    families: [...families.values()],
    unresolved,
    sentinels,
    bundles,
    plumbing,
    settingsInventory: inventory ? inventory.length : null,
    notes,
    parseErrors: host.parseErrors ?? [],
  };
}

export { relative };
