/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The APP-WIDE wasm budget: 100 MB for the whole editor including every
// plugin (maintainer decision, 2026-08-19).
//
// Why this script exists at all: until now every wasm ceiling in the
// platform was PER THING — plugin-sdk's `WASM_BUDGETS.maxArtifactBytes`
// caps one artifact, plugin-cli's gate validates one manifest, each
// plugin's `build-wasm.sh` weighs its own output. Nothing anywhere
// measured the sum. Eight bundles could each pass their own gate and the
// app could still ship a quarter of a gigabyte of WebAssembly, and no
// check in any repo would have noticed. That is the number a user
// downloads, so that is the number worth governing.
//
// What it measures: every `.wasm` the canvas app can resolve through its
// own `node_modules`, deduplicated BY REAL PATH. The dedupe is
// load-bearing — every package that depends on canvas-wasm links the same
// directory, so a naive walk counts the same 19.9 MiB engine five times and
// reports ~286 MiB for an app that ships far less. Distinct files are what
// the bundler emits and what the browser downloads.
//
// Only what a package SHIPS counts: the entries of its package.json `files`
// (a package without `files` is walked whole). The @paged-media packages are
// workspace packages, linked to their source directories, which also hold
// tests and fixtures; the published tarballs never had those. The bundles'
// engine wasm (doc, slide, sheet, data, web) and the engine's packages are
// build outputs, so CI builds them before this runs.
//
// And only what the page LOADS counts: a wasm file that only entries the page
// does not import lead to is left out. Since PM-0008,
// @paged-media/canvas-wasm ships three engines behind three entries (`.`,
// `./repo` and `./introspect`); the editor page loads the first two and the
// devtools page the third. An entry leads to a `.wasm` it names directly, or
// that its JavaScript names (the wasm-bindgen glue's
// `new URL("<stem>_bg.wasm", import.meta.url)`, which is what the bundler
// emits for it). The page's imports are read from the canvas app's `src/` and
// the `src/` of every workspace package it links; type-only imports load
// nothing and are skipped. A package whose entries name no wasm (the bundles,
// whose entries are TypeScript source) counts everything it ships.
//
// Usage:  node scripts/wasm-budget.mjs [--json]
// Exit 1 when over budget; prints the full inventory either way.

import {
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps/canvas");
const REPO = join(ROOT, "..", "..");

/** The app-wide ceiling. 100 MB decimal, as a download is quoted. */
export const APP_WASM_BUDGET_BYTES = 100 * 1000 * 1000;

/** Every `.wasm` under `dir`, following symlinks, depth-limited. */
function wasmFilesUnder(dir, depth = 0, out = []) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    let st;
    try {
      st = statSync(p); // statSync follows symlinks; Bun links every package
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Don't descend into a nested node_modules: those copies are
      // reached through their owning package's own entry instead, and
      // descending doubles the walk for no new distinct files.
      if (e.name === "node_modules") continue;
      wasmFilesUnder(p, depth + 1, out);
    } else if (e.name.endsWith(".wasm")) {
      out.push(p);
    }
  }
  return out;
}

/** The paths a package ships: its `files` entries, or the whole package. */
function shippedPaths(pkgDir) {
  let files;
  try {
    files = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    ).files;
  } catch {
    files = undefined;
  }
  return Array.isArray(files) ? files.map((f) => join(pkgDir, f)) : [pkgDir];
}

/** Every `.wasm` a package ships. */
function shippedWasm(pkgDir) {
  const out = [];
  for (const p of shippedPaths(pkgDir)) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // a listed build output that is not built
    }
    if (st.isDirectory()) wasmFilesUnder(p, 0, out);
    else if (p.endsWith(".wasm")) out.push(p);
  }
  return out;
}

/** The import specifiers of `@paged-media` packages in the JS/TS sources
 *  under `dir` (value imports only: `import type` loads nothing). */
function pagedSpecifiers(dir, out = new Set(), depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      pagedSpecifiers(p, out, depth + 1);
      continue;
    }
    if (!/\.(m?[jt]sx?)$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
    const text = readFileSync(p, "utf8");
    const re =
      /\b(import|export)(\s+type\b)?[^'"`;]*?\bfrom\s*['"](@paged-media\/[^'"]+)['"]|\bimport\s*\(\s*['"](@paged-media\/[^'"]+)['"]|\bimport\s*['"](@paged-media\/[^'"]+)['"]/g;
    for (const m of text.matchAll(re)) {
      if (m[2]) continue; // `import type` / `export type`
      const spec = m[3] ?? m[4] ?? m[5];
      if (spec) out.add(spec.replace(/\?.*$/, ""));
    }
  }
  return out;
}

/** `exports` target of `subpath` ("." or "./x"), for a browser bundle. */
function exportTarget(exportsField, subpath) {
  const pick = (v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      for (const c of ["browser", "import", "default"]) {
        const t = pick(v[c]);
        if (t) return t;
      }
    }
    return null;
  };
  const subpaths =
    exportsField &&
    typeof exportsField === "object" &&
    Object.keys(exportsField).some((k) => k.startsWith("."));
  if (!subpaths) return subpath === "." ? pick(exportsField) : null;
  if (subpath in exportsField) return pick(exportsField[subpath]);
  for (const [key, value] of Object.entries(exportsField)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (subpath.startsWith(head) && subpath.endsWith(tail)) {
      const t = pick(value);
      const middle = subpath.slice(head.length, subpath.length - tail.length);
      return t ? t.replace("*", middle) : null;
    }
  }
  return null;
}

/** The wasm one imported entry of a package reaches. */
function entryWasm(pkgDir, target) {
  const file = resolve(pkgDir, target);
  if (file.endsWith(".wasm")) return [file];
  if (!/\.m?js$/.test(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return []; // an entry that is not built
  }
  const out = [];
  for (const m of text.matchAll(/['"`]([^'"`\s]+\.wasm)['"`]/g)) {
    const wasm = resolve(dirname(file), m[1]);
    try {
      if (statSync(wasm).isFile()) out.push(wasm);
    } catch {
      /* named but absent */
    }
  }
  return out;
}

/** Every `.wasm` of a package the page loads: what it ships, less the wasm
 *  that only entries the page does not import lead to. A package without an
 *  `exports` map, or whose entries name no wasm (the bundles, whose entries
 *  are TypeScript source), counts everything it ships. */
function loadedWasm(pkgDir, name, specifiers) {
  const shipped = shippedWasm(pkgDir).map((f) => resolve(f));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return shipped;
  }
  const exp = manifest.exports;
  if (!exp || typeof exp !== "object") return shipped;
  const keys = Object.keys(exp).filter(
    (k) => k.startsWith(".") && !k.includes("*"),
  );
  if (keys.length === 0) return shipped;
  const imported = new Set(
    [...specifiers]
      .filter((s) => s === name || s.startsWith(`${name}/`))
      .map((s) => (s === name ? "." : `.${s.slice(name.length)}`)),
  );
  // wasm file -> whether an imported entry reaches it
  const reached = new Map();
  for (const key of keys) {
    const target = exportTarget(exp, key);
    if (!target) continue;
    for (const f of entryWasm(pkgDir, target)) {
      reached.set(f, reached.get(f) === true || imported.has(key));
    }
  }
  return shipped.filter((f) => reached.get(f) !== false);
}

/** The source trees of the page: the app's `src/` and the `src/` of every
 *  workspace package it links (a linked package resolves into the
 *  repository, not into the package store). */
function pageSourceDirs(scope, pkgs) {
  const dirs = [join(APP, "src")];
  for (const pkg of pkgs) {
    let real;
    try {
      real = realpathSync(join(scope, pkg));
    } catch {
      continue;
    }
    if (real.includes("/node_modules/")) continue;
    dirs.push(join(real, "src"));
  }
  return dirs;
}

export function collect() {
  const scope = join(APP, "node_modules/@paged-media");
  let pkgs;
  try {
    pkgs = readdirSync(scope);
  } catch {
    throw new Error(
      `no ${relative(ROOT, scope)} — run \`bun install\` before the wasm budget check`,
    );
  }
  const specifiers = new Set();
  for (const dir of pageSourceDirs(scope, pkgs))
    pagedSpecifiers(dir, specifiers);

  // realpath -> {bytes, owners[]}. One physical artifact, however many
  // packages link to it, is one download.
  const byReal = new Map();
  for (const pkg of pkgs.sort()) {
    const name = `@paged-media/${pkg}`;
    for (const f of loadedWasm(join(scope, pkg), name, specifiers)) {
      let real;
      try {
        real = realpathSync(f);
      } catch {
        continue;
      }
      const entry = byReal.get(real) ?? {
        bytes: statSync(real).size,
        owners: [],
      };
      if (!entry.owners.includes(pkg)) entry.owners.push(pkg);
      byReal.set(real, entry);
    }
  }

  const artifacts = [...byReal.entries()]
    .map(([real, v]) => ({
      file: real.includes("/node_modules/")
        ? real.replace(/^.*\/node_modules\//, "")
        : relative(REPO, real),
      bytes: v.bytes,
      owners: v.owners,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const total = artifacts.reduce((s, a) => s + a.bytes, 0);
  return { artifacts, total, budget: APP_WASM_BUDGET_BYTES };
}

const mb = (n) => (n / 1_000_000).toFixed(1);

/** `--json-out <path>` — write the measurement artifact as a SIDE EFFECT and
 *  still exit on the budget the way the gate always did.
 *
 *  Deliberately not `--json | tee file`: a pipe replaces this process's exit
 *  code with tee's, which would turn the budget gate into a gate that always
 *  passes. One invocation, gate on exit, file written on the way past. */
function jsonOutPath() {
  const i = process.argv.indexOf("--json-out");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function main() {
  const json = process.argv.includes("--json");
  const outPath = jsonOutPath();
  const { artifacts, total, budget } = collect();

  if (outPath) {
    // The measurement shape, not the inventory shape: one total plus one row
    // per artifact, each carrying the budget it is measured against. Per-file
    // detail stays in the CI log; only these aggregates are meant to be
    // trended.
    const doc = {
      contract: 1,
      source: "editor",
      lane: "wasm-budget",
      commit: process.env.GITHUB_SHA ?? "unknown",
      branch: process.env.GITHUB_REF_NAME ?? "main",
      ...(process.env.GITHUB_RUN_ID
        ? { run_id: String(process.env.GITHUB_RUN_ID) }
        : {}),
      finished_at: new Date().toISOString(),
      environment: {
        os: process.env.RUNNER_OS ?? process.platform,
        arch: process.arch,
      },
      // AGGREGATES ONLY, and one of them deliberately.
      //
      // A row per artifact would key the series on a FILE PATH — an
      // effectively open set that churns whenever a dependency is renamed,
      // and paths in a committed trend file are noise at best. The count of
      // artifacts is the useful summary; the per-file inventory stays in the
      // CI log above, where you read it while triaging.
      measurements: [
        {
          metric: "wasm.app_total_bytes",
          subject: "app",
          value: total,
          unit: "bytes",
          status: "ok",
          budget,
        },
        {
          metric: "wasm.artifact_count",
          subject: "app",
          value: artifacts.length,
          unit: "count",
          status: "ok",
        },
      ],
    };
    writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify({ artifacts, total, budget }, null, 2));
  } else {
    console.log("app-wide wasm inventory (distinct artifacts):\n");
    for (const a of artifacts) {
      console.log(
        `  ${mb(a.bytes).padStart(7)} MB  ${a.file}` +
          (a.owners.length > 1 ? `  [shared by ${a.owners.length}]` : ""),
      );
    }
    console.log(
      `\n  ${mb(total).padStart(7)} MB  TOTAL across ${artifacts.length} artifact(s)` +
        `\n  ${mb(budget).padStart(7)} MB  budget (whole app, all plugins)`,
    );
  }

  if (total > budget) {
    console.error(
      `\n::error::app-wide wasm budget exceeded: ${mb(total)} MB > ${mb(budget)} MB.\n` +
        `The cap covers the editor AND every plugin together — the number a user downloads.\n` +
        `Shrink an artifact (wasm-opt -Oz, drop a vendored engine) rather than raising this;\n` +
        `raising it is a maintainer decision and belongs in a commit that says why.`,
    );
    process.exit(1);
  }
  console.log(`\nwasm budget OK — ${mb(budget - total)} MB headroom.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
