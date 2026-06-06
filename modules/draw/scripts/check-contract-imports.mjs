#!/usr/bin/env node
// M1.1 (post-integration roadmap) — the clean-checkout proof's
// enforcement mechanism, runnable today: every import in this repo's
// source must come through the sanctioned contract surface. Until
// Decision B publishes the packages (when a fresh-container CI lane
// replaces this), the lint IS the "no private backdoors" guarantee:
// an editor-internal import cannot land silently.
//
// Allowed: the plugin contract (@paged-media/plugin-api / plugin-sdk),
// this repo's own packages, and relative paths. Everything else —
// @paged-media/shell, /client, /ui, /catalog, /tools, react — fails
// the build with a pointer to BREAKAGE_LOG.md (the a/b/c disposition:
// promote to plugin-api, use an existing capability, or record).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;

const ALLOWED_PREFIXES = [
  "@paged-media/plugin-api",
  "@paged-media/plugin-sdk",
  "@paged-media/draw-", // this repo's own packages
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[^"'`;]*?from\s*["']([^"']+)["']/g;

const violations = [];
for (const file of walk(join(ROOT, "packages"))) {
  if (!file.includes("/src/")) continue;
  const text = readFileSync(file, "utf8");
  IMPORT.lastIndex = 0;
  let m;
  while ((m = IMPORT.exec(text)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("..")) continue;
    if (ALLOWED_PREFIXES.some((p) => spec.startsWith(p))) continue;
    violations.push(`${relative(ROOT, file)} → "${spec}"`);
  }
}

if (violations.length > 0) {
  console.error(
    "contract-import lint: imports outside the plugin surface " +
      "(disposition each: promote to plugin-api / use an existing " +
      "capability / record in BREAKAGE_LOG.md):",
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("contract-import lint: clean (plugin surface only)");
