#!/usr/bin/env node
// Wire-type vendoring (M1.1(a), decision 2026-06-06): plugin-api OWNS
// its published types. The engine wire types stay generated (tsify in
// core → editor's tracked paged_canvas_wasm.d.ts), so plugin-api
// VENDORS that file verbatim under src/wire.d.ts and this script
// keeps the copy honest:
//
//   node scripts/sync-wire.mjs           # copy from the sibling editor
//   node scripts/sync-wire.mjs --check   # fail if the copy drifted
//
// --check is a no-op (warn only) when the sibling editor checkout is
// absent (published-package consumers, CI without private repos) —
// the sibling layout is a dev-time luxury, not a build requirement.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE = resolve(
  ROOT,
  "../editor/packages/client/src/wasm/paged_canvas_wasm.d.ts",
);
const TARGET = resolve(ROOT, "packages/plugin-api/src/wire.d.ts");

const HEADER = `// GENERATED — do not edit. Vendored verbatim from the editor's
// tracked tsify output (packages/client/src/wasm/paged_canvas_wasm.d.ts),
// which is itself generated from paged-media/core (MPL-2.0 OR PMEL).
// Sync: node scripts/sync-wire.mjs · Check: --check (CI-safe: warns
// when the sibling editor checkout is absent).
`;

const check = process.argv.includes("--check");

if (!existsSync(SOURCE)) {
  console.warn(
    `sync-wire: sibling editor checkout not found (${SOURCE}) — skipping`,
  );
  process.exit(0);
}

const fresh = HEADER + readFileSync(SOURCE, "utf8");

if (check) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  if (current !== fresh) {
    console.error(
      "sync-wire: vendored wire.d.ts has drifted from the editor's " +
        "generated types — run `node scripts/sync-wire.mjs` and commit",
    );
    process.exit(1);
  }
  console.log("sync-wire: vendored wire types in sync");
  process.exit(0);
}

writeFileSync(TARGET, fresh);
console.log(`sync-wire: wrote ${TARGET}`);
