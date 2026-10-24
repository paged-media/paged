#!/usr/bin/env node
// The hash of every source file a module's engine wasm is built from.
//
// A module's scripts/build-wasm.sh stamps it into the wasm (the crate's
// `engine_source_hash()`, through an `option_env!` variable cargo tracks)
// and beside it (<bin>/SOURCE_HASH); the module's test/wasm-fresh.spec.ts
// recomputes it and fails when the wasm it is about to test was built from
// different sources. Without that check every test run exercised whatever
// wasm was last built (gitignored build output, or once a committed one):
// on 2026-10-04 sheet's local artifact was two months older than its
// checkout and image's predated two PSD parser fixes, and nothing said so.
//
// Usage: bun tooling/js/source-hash.mjs <module>         → the hex digest
//        bun tooling/js/source-hash.mjs <module> --list  → the input files
//
// One implementation for every module; what differs is the table below.
// Inputs, per module (paths relative to the module's directory):
//   · `crate` and, with `walk`, every crate it reaches through
//     `path = "../…"` normal and build dependencies (dev-dependencies are
//     not inputs to the wasm): each crate's `crateDirs` and `crateFiles`;
//   · the files under each `extra` directory with the given extension
//     (build-consumed registries);
//   · `rootFiles` of the module's Cargo workspace.
// Tests and benches are not inputs, so editing one does not demand a
// rebuild — except where they live inside src/ (web-render's
// #[cfg(test)] modules), the simple, conservative choice there.
//
// Path and content both count. A file that is valid UTF-8 is hashed as text
// with CRLF normalised, so a Windows checkout hashes the same as the one that
// built the wasm; anything else (web-render's vendored font) as bytes.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CARGO_WORKSPACE = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];

/** What each module's engine wasm is built from. */
export const MODULES = {
  data: {
    root: "modules/data",
    crate: "data-js",
    walk: true,
    crateDirs: ["src"],
    crateFiles: ["build.rs", "Cargo.toml"],
    // paged-data-core + paged-data-expr build.rs read them (PM-0015).
    extra: [
      {
        dir: "../../engine/core/crates/paged-data-core/functions",
        ext: ".yaml",
      },
    ],
    rootFiles: CARGO_WORKSPACE,
  },
  image: {
    root: "modules/image",
    crate: "image-js",
    walk: true,
    crateDirs: ["src"],
    crateFiles: ["build.rs", "Cargo.toml"],
    extra: [{ dir: "registry", ext: ".yaml" }],
    rootFiles: CARGO_WORKSPACE,
  },
  sheet: {
    root: "modules/sheet",
    crate: "sheet-js",
    walk: true,
    crateDirs: ["src"],
    crateFiles: ["build.rs", "Cargo.toml"],
    // sheet-core + sheet-fn build.rs read them.
    extra: [{ dir: "registry/functions", ext: ".yaml" }],
    rootFiles: CARGO_WORKSPACE,
  },
  web: {
    root: "modules/web",
    // Its own Cargo workspace (Cargo.lock beside it); no path dependencies.
    crate: "packages/web-render",
    walk: false,
    // assets/: the vendored font is compiled in.
    crateDirs: ["src", "assets"],
    crateFiles: ["Cargo.toml", "Cargo.lock"],
    extra: [],
    rootFiles: [],
  },
};

function specOf(module) {
  const spec = MODULES[module];
  if (!spec) {
    throw new Error(
      `source-hash: unknown module "${module}" (known: ${Object.keys(MODULES).join(", ")})`,
    );
  }
  return spec;
}

/**
 * The normal (and build) `path = "../…"` dependencies of a crate, relative to
 * the module's directory: a path is resolved from the crate's own directory,
 * so a shared crate outside the module (platform/shared/*) that depends on
 * another one by `../x` is followed too.
 */
function pathDeps(root, crate) {
  const toml = readFileSync(join(root, crate, "Cargo.toml"), "utf8");
  const deps = [];
  let section = "";
  for (const line of toml.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = header[1];
      continue;
    }
    if (/dev-dependencies/.test(section)) continue;
    if (!/dependencies/.test(section)) continue;
    const m = line.match(/path\s*=\s*"(\.\.\/[^"]+)"/);
    if (m)
      deps.push(
        relative(root, join(root, crate, m[1]))
          .split("\\")
          .join("/"),
      );
  }
  return deps;
}

function crates(root, spec) {
  if (!spec.walk) return [spec.crate];
  const seen = new Set();
  const walk = (c) => {
    if (seen.has(c)) return;
    seen.add(c);
    for (const d of pathDeps(root, c)) walk(d);
  };
  walk(spec.crate);
  return [...seen].sort();
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** The module's directory, absolute. */
export function moduleRoot(module) {
  return join(REPO, specOf(module).root);
}

/** The input files, relative to the module's directory, sorted. */
export function inputs(module) {
  const spec = specOf(module);
  const root = moduleRoot(module);
  const files = [];
  for (const c of crates(root, spec)) {
    for (const d of spec.crateDirs) files.push(...filesUnder(join(root, c, d)));
    for (const f of spec.crateFiles) {
      if (existsSync(join(root, c, f))) files.push(join(root, c, f));
    }
  }
  for (const { dir, ext } of spec.extra) {
    files.push(...filesUnder(join(root, dir)).filter((f) => f.endsWith(ext)));
  }
  for (const f of spec.rootFiles) files.push(join(root, f));
  return files.map((f) => relative(root, f).split("\\").join("/")).sort();
}

// `ignoreBOM` keeps a byte-order mark in the text, as a utf8 read does.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The hex SHA-256 over the module's inputs (path, then content). */
export function sourceHash(module) {
  const root = moduleRoot(module);
  const h = createHash("sha256");
  for (const rel of inputs(module)) {
    h.update(rel);
    h.update("\0");
    const bytes = readFileSync(join(root, rel));
    let text = null;
    try {
      text = utf8.decode(bytes);
    } catch {
      // Not UTF-8: hashed as bytes below.
    }
    h.update(text === null ? bytes : text.replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const module = args.find((a) => !a.startsWith("-"));
  if (!module) {
    console.error(
      `usage: bun tooling/js/source-hash.mjs <module> [--list]  (modules: ${Object.keys(MODULES).join(", ")})`,
    );
    process.exit(2);
  }
  if (args.includes("--list")) console.log(inputs(module).join("\n"));
  else console.log(sourceHash(module));
}
