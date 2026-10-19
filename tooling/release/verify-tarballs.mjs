#!/usr/bin/env node
// What npm would receive, checked before it does (PM-0008):
//
//   node tooling/release/verify-tarballs.mjs <version> <tgz...>
//
// For each tarball of the four public packages:
//   - the name is one of the four, the version is <version>, it is not private;
//   - the licence is `AGPL-3.0-only OR LicenseRef-PMEL`, and LICENSE and
//     LICENSE.md are in it;
//   - `repository` names github.com/paged-media/paged and the package's
//     directory (npm checks it against the provenance of a trusted publish);
//   - no dependency of any kind is still `workspace:` or `catalog:`, and every
//     @paged-media dependency is <version> (one version for the four);
//   - main, types, bin and every `exports` target are files in the tarball;
//   - for @paged-media/idml-viewer, the viewer subset audit holds for the files
//     (engine/core/scripts/viewer-subset-audit.mjs --no-cargo).
//
// Prints each tarball's file list with sizes. Exit 1 on any failure.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LICENSE = "AGPL-3.0-only OR LicenseRef-PMEL";
const REPOSITORY = "git+https://github.com/paged-media/paged.git";
const NAMES = new Set([
  "@paged-media/canvas-wasm",
  "@paged-media/idml-viewer",
  "@paged-media/plugin-api",
  "@paged-media/plugin-sdk",
]);
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const [version, ...tarballs] = process.argv.slice(2);
if (!version || tarballs.length === 0) {
  console.error(
    "usage: node tooling/release/verify-tarballs.mjs <version> <tgz...>",
  );
  process.exit(2);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function targets(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object")
    for (const x of Object.values(v)) targets(x, out);
  return out;
}

const failures = [];
const seen = new Set();
for (const tgz of tarballs) {
  const scratch = mkdtempSync(join(tmpdir(), "verify-tarball-"));
  const fail = (m) => failures.push(`${basename(tgz)}: ${m}`);
  try {
    execFileSync("tar", ["-xzf", tgz, "-C", scratch]);
    const root = join(scratch, "package");
    const files = walk(root).map((f) => relative(root, f));
    const has = (p) => files.includes(normalize(p).replace(/^\.\//, ""));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    if (!NAMES.has(pkg.name))
      fail(`${pkg.name} is not one of the four public packages`);
    if (seen.has(pkg.name)) fail(`${pkg.name} appears twice`);
    seen.add(pkg.name);
    if (pkg.version !== version)
      fail(`version ${pkg.version}, expected ${version}`);
    if (pkg.private) fail("is private");
    if (pkg.license !== LICENSE)
      fail(`license is ${JSON.stringify(pkg.license)}, expected ${LICENSE}`);
    for (const f of ["LICENSE", "LICENSE.md"])
      if (!has(f)) fail(`ships no ${f}`);
    if (pkg.repository?.url !== REPOSITORY)
      fail(`repository.url is ${pkg.repository?.url}`);
    if (!pkg.repository?.directory) fail("repository.directory is missing");
    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
        if (/^(workspace|catalog):/.test(spec))
          fail(`${field}.${dep} is still ${spec}`);
        if (field !== "devDependencies" && NAMES.has(dep) && spec !== version) {
          fail(
            `${field}.${dep} is ${spec}, expected ${version} (one version for the four)`,
          );
        }
      }
    }
    const entryPoints = [
      pkg.main,
      pkg.types,
      ...(typeof pkg.bin === "string"
        ? [pkg.bin]
        : Object.values(pkg.bin ?? {})),
      ...targets(pkg.exports),
    ].filter(Boolean);
    for (const p of new Set(entryPoints)) {
      if (p.includes("*")) continue;
      if (!has(p)) fail(`${p} (an entry point) is not in the tarball`);
    }
    if (pkg.name === "@paged-media/idml-viewer") {
      try {
        execFileSync(
          "node",
          [
            join(REPO, "engine/core/scripts/viewer-subset-audit.mjs"),
            "--no-cargo",
            root,
          ],
          {
            stdio: ["ignore", "inherit", "inherit"],
          },
        );
      } catch {
        fail("the viewer subset audit failed");
      }
    }

    console.log(`${pkg.name}@${pkg.version} — ${files.length} files`);
    for (const f of files.sort()) {
      const bytes = statSync(join(root, f)).size;
      console.log(`  ${String(bytes).padStart(10)}  ${f}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures.length) {
  for (const f of failures) console.error(`::error::verify-tarballs: ${f}`);
  process.exit(1);
}
console.log(`verify-tarballs OK — ${tarballs.length} tarball(s) at ${version}`);
