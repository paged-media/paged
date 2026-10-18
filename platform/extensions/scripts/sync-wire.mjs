#!/usr/bin/env node
// Wire-type vendoring (M1.1(a), decision 2026-06-06; repointed at
// Decision B, 2026-06-07): plugin-api OWNS its published types. The
// engine wire types stay generated (tsify in core → the published
// @paged-media/canvas-wasm .d.ts), so plugin-api VENDORS that file
// verbatim under src/wire.d.ts and this script keeps the copy honest
// AND records which package version it was synced from.
//
//   node scripts/sync-wire.mjs              # copy from the published pkg
//   node scripts/sync-wire.mjs --check      # fail if the copy drifted
//   node scripts/sync-wire.mjs --source <f> # explicit .d.ts override
//
// SOURCE resolution (in order):
//   1. --source <path> to a paged_canvas_wasm.d.ts, OR
//   2. @paged-media/canvas-wasm resolved from the editor's
//      node_modules (Decision B published package — the editor's
//      packages/client depends on it).
// If NEITHER resolves the script EXITS NONZERO (no warn-skip): the
// vendored wire is a protocol coupling, and a check that can't see
// its source is not a passing check. CI must run this with the
// package installed (it is, via the editor link or a direct dep).

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET = resolve(ROOT, "packages/plugin-api/src/wire.d.ts");

// Where to resolve the published package FROM. The editor's
// packages/client is the canonical declarer of the
// @paged-media/canvas-wasm dependency; resolving from there picks up
// the exact pinned version the editor (and therefore the engine wire)
// is on. Overridable via PAGED_CANVAS_WASM_FROM.
//
// In the monorepo the editor sits at `apps/editor`, two levels above this
// package's root (`platform/extensions`). First existing candidate wins.
const RESOLVE_CANDIDATES = [
  resolve(ROOT, "../../apps/editor/packages/client"), // <repo root>/apps/editor
];
const RESOLVE_FROM =
  process.env.PAGED_CANVAS_WASM_FROM ??
  RESOLVE_CANDIDATES.find((c) => existsSync(resolve(c, "package.json"))) ??
  RESOLVE_CANDIDATES[0];

const PKG = "@paged-media/canvas-wasm";

const VERSION_PREFIX = "// Synced from " + PKG + "@";

/**
 * Resolve the source .d.ts and its package version.
 * @param {{ source?: string, resolveFrom?: string }} [opts]
 * @returns {{ path: string, version: string }}
 * @throws if neither an explicit source nor the package resolves.
 */
export function resolveSource(opts = {}) {
  const explicit = opts.source;
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) {
      throw new Error(`sync-wire: --source path not found: ${path}`);
    }
    // An explicit .d.ts may sit next to a package.json (the published
    // layout) — read its version if so, else mark it unknown.
    const sibling = resolve(dirname(path), "package.json");
    let version = "unknown";
    if (existsSync(sibling)) {
      try {
        version =
          JSON.parse(readFileSync(sibling, "utf8")).version ?? "unknown";
      } catch {
        /* leave unknown */
      }
    }
    return { path, version };
  }

  const from = opts.resolveFrom ?? RESOLVE_FROM;
  let req;
  try {
    req = createRequire(pathToFileURL(resolve(from, "package.json")));
  } catch (err) {
    throw new Error(
      `sync-wire: cannot anchor require at ${from} (${String(err)})`,
    );
  }
  let pkgJsonPath;
  try {
    pkgJsonPath = req.resolve(`${PKG}/package.json`);
  } catch {
    throw new Error(
      `sync-wire: ${PKG} is not resolvable from ${from}. Install it ` +
        `(the editor's packages/client depends on it) or pass ` +
        `--source <paged_canvas_wasm.d.ts>. No warn-skip: the vendored ` +
        `wire is a protocol coupling and must be verifiable.`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const types = pkg.types ?? pkg.typings ?? "paged_canvas_wasm.d.ts";
  const path = resolve(dirname(pkgJsonPath), types);
  if (!existsSync(path)) {
    throw new Error(
      `sync-wire: ${PKG}@${pkg.version} resolved but its types file is ` +
        `missing: ${path}`,
    );
  }
  return { path, version: pkg.version ?? "unknown" };
}

/** Build the header block, stamping the source package version. */
export function buildHeader(version) {
  return (
    `// GENERATED — do not edit. Vendored verbatim from the published\n` +
    `// ${PKG} .d.ts (tsify output from paged-media/core,\n` +
    `// AGPL-3.0-only OR PMEL). Sync: node scripts/sync-wire.mjs · Check: --check.\n` +
    `${VERSION_PREFIX}${version}\n`
  );
}

// `export interface InitOutput { … }` lists the wasm module's raw exports: its
// internal ABI, not wire types. Two things in it depend on the build rather
// than on the source: the closure trampolines are named after rustc symbols
// (`wasm_bindgen__convert__closures_____invoke__h<hash>` before Rust 1.99,
// `wasm_bindgen_<crate hash>___convert__closures_____invoke___<types>` since),
// which differ between hosts and toolchains, and the order of the exports
// follows the link order. So the check compares that block by signature: every
// trampoline name is blanked and the block's lines are sorted. Any other
// difference, a trampoline signature or an export added or dropped included,
// is still drift, and everything outside the block compares byte for byte.
const TRAMPOLINE =
  /wasm_bindgen(?:_[0-9a-f]+_)?__convert__closures_____invoke\w*(?=\s*:)/;
const INIT_OUTPUT_START = /^export interface InitOutput \{\s*$/;

/** `content` with InitOutput's build-dependent parts normalized (see above). */
export function normalizeWire(content) {
  const out = [];
  let block = null;
  for (const line of content.split("\n")) {
    if (block === null) {
      out.push(line);
      if (INIT_OUTPUT_START.test(line)) block = [];
    } else if (line === "}") {
      out.push(...block.sort(), line);
      block = null;
    } else {
      block.push(
        line.replace(TRAMPOLINE, "wasm_bindgen__convert__closures_____invoke…"),
      );
    }
  }
  if (block !== null) out.push(...block);
  return out.join("\n");
}

/** The full freshly-vendored content for a given source. */
export function buildVendored({ path, version }) {
  return buildHeader(version) + readFileSync(path, "utf8");
}

/** Extract the `Synced from …@<version>` stamp from a vendored copy. */
export function readStampedVersion(content) {
  for (const line of content.split("\n", 6)) {
    if (line.startsWith(VERSION_PREFIX)) {
      return line.slice(VERSION_PREFIX.length).trim();
    }
  }
  return null;
}

/**
 * Run a --check against an in-memory or on-disk target.
 * @returns {{ ok: boolean, reason?: string, expectedVersion?: string,
 *             actualVersion?: string|null }}
 */
export function checkVendored(opts = {}) {
  let src;
  try {
    src = resolveSource(opts);
  } catch (err) {
    // resolveSource already prefixes "sync-wire:"; strip it so the CLI
    // wrapper doesn't double it.
    const msg = String(err.message ?? err).replace(/^sync-wire:\s*/, "");
    return { ok: false, reason: msg };
  }
  const fresh = buildVendored(src);
  const target = opts.target ?? TARGET;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (normalizeWire(current) !== normalizeWire(fresh)) {
    const actualVersion = readStampedVersion(current);
    const versionDrift = actualVersion !== src.version;
    return {
      ok: false,
      reason: versionDrift
        ? `vendored wire was synced from ${PKG}@${actualVersion ?? "?"} ` +
          `but the installed package is ${PKG}@${src.version} — run ` +
          `\`node scripts/sync-wire.mjs\` and commit`
        : `vendored wire.d.ts has drifted from ${PKG}@${src.version} ` +
          `(content differs at the same version) — run ` +
          `\`node scripts/sync-wire.mjs\` and commit`,
      expectedVersion: src.version,
      actualVersion,
    };
  }
  return { ok: true, expectedVersion: src.version };
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
    else if (a.startsWith("--source="))
      out.source = a.slice("--source=".length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const res = checkVendored({ source: args.source });
    if (!res.ok) {
      console.error(`sync-wire: ${res.reason}`);
      process.exit(1);
    }
    console.log(
      `sync-wire: vendored wire types in sync (${PKG}@${res.expectedVersion})`,
    );
    process.exit(0);
  }
  try {
    const { target, version, source } = writeVendored({ source: args.source });
    console.log(`sync-wire: wrote ${target} from ${PKG}@${version}`);
    console.log(`sync-wire: source ${source}`);
  } catch (err) {
    console.error(`sync-wire: ${err.message ?? err}`);
    process.exit(1);
  }
}

// Only run as a CLI when invoked directly, so tests can import the
// pure functions without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
