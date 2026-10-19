#!/usr/bin/env node
// Every generated file the engine's two npm packages ship is present
// (PM-0008): @paged-media/canvas-wasm (packages/canvas-wasm/: the canvas,
// introspect/ and repo/ entries, and introspect/catalog.json) and the session
// of @paged-media/idml-viewer (web/idml-viewer/wasm/). Each manifest's
// `files` names them; `exports` targets that point into them must exist too.
//
//   node scripts/check-wasm-packages-built.mjs
//
// The idml-viewer's own dist/ (its TypeScript build) is not an engine output
// and is not checked here. Plain Node, no dependencies.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..");
// directory -> which of its shipped paths the engine build writes
const PACKAGES = {
  "packages/canvas-wasm": () => true,
  "web/idml-viewer": (p) => p.startsWith("wasm/"),
};
const COMMITTED = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "LICENSE.md",
]);

function targets(exportsField) {
  const out = [];
  const visit = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(exportsField);
  return out;
}

const missing = [];
for (const [dir, generated] of Object.entries(PACKAGES)) {
  const manifest = JSON.parse(
    readFileSync(join(CORE, dir, "package.json"), "utf8"),
  );
  const paths = new Set(
    [...(manifest.files ?? []), ...targets(manifest.exports)]
      .map((p) => normalize(p).replace(/^\.\//, ""))
      .filter((p) => !COMMITTED.has(p) && generated(p)),
  );
  for (const p of [...paths].sort()) {
    if (!existsSync(join(CORE, dir, p))) missing.push(`${dir}/${p}`);
  }
  if (missing.length === 0)
    console.log(`ok ${manifest.name}@${manifest.version}`);
}
if (missing.length) {
  for (const m of missing)
    console.error(`::error::engine wasm: ${m} is missing`);
  console.error(
    "Build them: bash engine/core/scripts/build-wasm-packages.sh --workspace (or moon run core:wasm-pkg).",
  );
  process.exit(1);
}
