#!/usr/bin/env bun
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

// What the package's dist/ may hold (docs/adr/PM-0013):
//
//   bun scripts/check-dist.mjs [<dist dir>]
//
// - the module code imports nothing but React (the host's), its own files
//   and, in the declarations, `@paged-media/paged`: no private
//   `@paged-media/*` package is left, inlined or not;
//   `./iframe` imports no React and stays small;
// - every `new URL("./file", import.meta.url)` names a file in dist/ (the
//   engine's wasm excepted: it is the `@paged-media/paged` dependency's), and
//   every worker is constructed in the form a host's bundler reads;
// - no engine wasm, no paged.data engine wasm (the module host serves it), no
//   source map, no path of the machine that built it;
// - the size budget: the whole of dist/, and the entry a page loads first.
//
// tooling/release/verify-tarballs.mjs runs it on the packed tarball too.
// Exit 1 on any failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(process.argv[2] ?? join(PKG, "dist"));

/** The budget, in bytes. The whole of dist/ is mostly the module wasm the
 *  bundles ship (doc, web, pdfium, image, sheet, slide, …); a rise past it
 *  is a decision, not a drift. */
export const BUDGET = {
  dist: 64 * 1024 * 1024,
  /** The `.` entry: createEditor before the editor loads. */
  entry: 16 * 1024,
  /** `./iframe`: the bridge, without the editor. */
  iframe: 16 * 1024,
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const failures = [];
const fail = (m) => failures.push(m);
const files = walk(DIST).map((f) => relative(DIST, f).split("\\").join("/"));
const has = new Set(files);

const importsOf = (code) => [
  ...[
    ...code.matchAll(
      /^\s*(?:import|export)\s[^;"'`]*?\bfrom\s*["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]),
  ...[...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]),
  // `import("node:…")` appears only in messages: Vite shims a real one.
  ...[...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith("node:")),
];
const REACT = /^react(-dom)?(\/.*)?$/;

let total = 0;
for (const f of files) {
  const abs = join(DIST, f);
  const bytes = statSync(abs).size;
  total += bytes;
  if (f.endsWith(".map")) fail(`${f}: a source map`);
  if (/(^|\/)paged_canvas_wasm_bg[^/]*\.wasm$/.test(f) || bytes > 24 << 20)
    fail(
      `${f} (${bytes} bytes): the engine is the @paged-media/paged dependency's, never a copy`,
    );
  if (/(^|\/)data_js_bg[^/]*\.wasm$/.test(f))
    fail(`${f}: paged.data's engine is hosted (ADR 220), not shipped`);
  if (!/\.(m?js|d\.ts|css|json|html|txt)$/.test(f)) continue;
  // Comments name files too (a JSDoc example); only code counts.
  const code = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\/(Users|home|Volumes)\/[^"'\s]+\/|\/@fs\//.test(code))
    fail(`${f}: names a path of the machine that built it`);
  if (!/\.(m?js|d\.ts)$/.test(f)) continue;
  for (const spec of importsOf(code)) {
    if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(f), spec));
      const found = f.endsWith(".d.ts")
        ? has.has(target.replace(/\.js$/, ".d.ts"))
        : has.has(target);
      if (!found) fail(`${f}: imports ${spec}, which is not in dist/`);
    } else if (f.endsWith(".d.ts")) {
      if (spec !== "@paged-media/paged") fail(`${f}: its types import ${spec}`);
    } else if (!REACT.test(spec)) {
      fail(`${f}: imports ${spec} (only React is the host's)`);
    }
  }
  if (f.endsWith(".js")) {
    for (const m of code.matchAll(
      /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      const target = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (target === "../../paged/paged_canvas_wasm_bg.wasm") continue;
      if (!has.has(target))
        fail(`${f}: new URL("${m[1]}") names no file in dist/`);
    }
    if (/import\.meta\.url\s*\)\s*,\s*\{[^}]*name:/.test(code))
      fail(`${f}: a worker with options no bundler reads statically`);
    if (/\b__vitePreload\b/.test(code))
      fail(`${f}: holds __vitePreload, which a host's Vite declares again`);
    if (/(""|'')\s*\+\s*import\.meta\.url/.test(code))
      fail(`${f}: a file URL in a form no bundler reads`);
  }
}

// The stylesheet's url()s name files in dist/.
if (has.has("style.css")) {
  const css = readFileSync(join(DIST, "style.css"), "utf8");
  for (const m of css.matchAll(
    /url\(\s*["']?(?!data:|https?:|#)([^"')]+)["']?\s*\)/g,
  )) {
    if (!has.has(posix.normalize(m[1])))
      fail(`style.css: url(${m[1]}) names no file in dist/`);
  }
}

const size = (f) => (has.has(f) ? statSync(join(DIST, f)).size : 0);
for (const f of ["index.js", "iframe.js", "presets.js", "style.css"])
  if (!has.has(f)) fail(`${f} is missing`);
for (const f of ["index.d.ts", "iframe.d.ts", "presets.d.ts", "types.d.ts"])
  if (!has.has(f)) fail(`${f} is missing`);
if (has.has("iframe.js")) {
  const code = readFileSync(join(DIST, "iframe.js"), "utf8");
  const reach = new Set(["iframe.js"]);
  const queue = ["iframe.js"];
  while (queue.length) {
    const f = queue.pop();
    for (const spec of importsOf(readFileSync(join(DIST, f), "utf8"))) {
      if (REACT.test(spec)) fail(`./iframe reaches React (${f})`);
      if (!spec.startsWith(".")) continue;
      const t = posix.normalize(posix.join(posix.dirname(f), spec));
      if (has.has(t) && !reach.has(t)) (reach.add(t), queue.push(t));
    }
  }
  const bytes = [...reach].reduce((n, f) => n + size(f), 0);
  if (bytes > BUDGET.iframe)
    fail(
      `./iframe is ${bytes} bytes with what it imports (budget ${BUDGET.iframe})`,
    );
  void code;
}
if (size("index.js") > BUDGET.entry)
  fail(`index.js is ${size("index.js")} bytes (budget ${BUDGET.entry})`);
if (total > BUDGET.dist)
  fail(`dist/ is ${total} bytes (budget ${BUDGET.dist})`);

const mib = (n) => (n / 1048576).toFixed(1);
console.log(
  `check-dist: ${files.length} files, ${mib(total)} MiB (budget ${mib(BUDGET.dist)}); index.js ${size("index.js")} B, iframe.js ${size("iframe.js")} B`,
);
if (failures.length) {
  for (const f of failures) console.error(`::error::check-dist: ${f}`);
  process.exit(1);
}
console.log("check-dist OK");
