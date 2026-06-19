#!/usr/bin/env node
// Capability-catalog vendoring (ADR 019). Sibling of sync-wire.mjs: where
// sync-wire vendors the engine WIRE TYPES (.d.ts), this vendors the engine
// CAPABILITY CATALOG (host fns + the settable property paths + id grammar +
// constraints) — the single generated contract core publishes as
// `catalog.json` inside @paged-media/introspect-wasm.
//
//   node scripts/sync-catalog.mjs              # copy from the published pkg
//   node scripts/sync-catalog.mjs --check      # fail if the copy drifted
//   node scripts/sync-catalog.mjs --source <f> # explicit catalog.json override
//
// SOURCE resolution (in order):
//   1. --source <path> to a catalog.json, OR
//   2. @paged-media/introspect-wasm resolved from the editor's node_modules
//      (Decision B: the editor consumes introspect-wasm). NOTE: the catalog ships
//      in introspect-wasm from the FIRST release after ADR 019 Phase 2 — until
//      then `--check` against the published package reports the file missing;
//      that is the cross-repo release-ordering signal, not a script bug.
// If neither resolves the script EXITS NONZERO (the vendored catalog is a
// contract coupling; a check that can't see its source is not a passing check).

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET = resolve(ROOT, "packages/plugin-api/src/catalog.json");
const RESOLVE_FROM =
  process.env.PAGED_INTROSPECT_WASM_FROM ?? resolve(ROOT, "../editor/packages/client");
const PKG = "@paged-media/introspect-wasm";
const CATALOG_FILE = "catalog.json";

/** Resolve the source catalog.json and its package version. */
export function resolveSource(opts = {}) {
  if (opts.source) {
    const path = resolve(opts.source);
    if (!existsSync(path)) throw new Error(`sync-catalog: --source not found: ${path}`);
    return { path, version: "unknown" };
  }
  const from = opts.resolveFrom ?? RESOLVE_FROM;
  let req;
  try {
    req = createRequire(pathToFileURL(resolve(from, "package.json")));
  } catch (err) {
    throw new Error(`sync-catalog: cannot anchor require at ${from} (${String(err)})`);
  }
  let pkgJsonPath;
  try {
    pkgJsonPath = req.resolve(`${PKG}/package.json`);
  } catch {
    throw new Error(
      `sync-catalog: ${PKG} is not resolvable from ${from}. Install it or pass ` +
        `--source <catalog.json>. No warn-skip: the vendored catalog is a contract coupling.`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const path = resolve(dirname(pkgJsonPath), CATALOG_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `sync-catalog: ${PKG}@${pkg.version} resolved but ${CATALOG_FILE} is missing — ` +
        `the catalog ships from the first release after ADR 019 Phase 2. Bump ${PKG}.`,
    );
  }
  return { path, version: pkg.version ?? "unknown" };
}

/** The vendored content (the catalog JSON verbatim, normalized to a trailing newline). */
export function buildVendored({ path }) {
  return readFileSync(path, "utf8").trimEnd() + "\n";
}

/** Run a --check: drift iff the vendored copy differs from the source. */
export function checkVendored(opts = {}) {
  let src;
  try {
    src = resolveSource(opts);
  } catch (err) {
    return { ok: false, reason: String(err.message ?? err).replace(/^sync-catalog:\s*/, "") };
  }
  const fresh = buildVendored(src);
  const target = opts.target ?? TARGET;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== fresh) {
    return {
      ok: false,
      reason: `vendored catalog.json has drifted from ${PKG}@${src.version} — run ` +
        `\`node scripts/sync-catalog.mjs\` and commit`,
      version: src.version,
    };
  }
  return { ok: true, version: src.version };
}

/** Write the vendored copy from the resolved source. */
export function writeVendored(opts = {}) {
  const src = resolveSource(opts);
  const target = opts.target ?? TARGET;
  writeFileSync(target, buildVendored(src));
  return { target, version: src.version, source: src.path };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const out = { check: false, source: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--source") out.source = argv[++i];
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const res = checkVendored({ source: args.source });
    if (!res.ok) {
      console.error(`sync-catalog: ${res.reason}`);
      process.exit(1);
    }
    console.log(`sync-catalog: vendored catalog in sync (${PKG}@${res.version})`);
    process.exit(0);
  }
  try {
    const { target, version, source } = writeVendored({ source: args.source });
    console.log(`sync-catalog: wrote ${target} from ${PKG}@${version}`);
    console.log(`sync-catalog: source ${source}`);
  } catch (err) {
    console.error(`sync-catalog: ${err.message ?? err}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
