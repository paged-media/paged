#!/usr/bin/env node
// What npm would receive, checked before it does (PM-0008, amendment 3):
//
//   node tooling/release/verify-tarballs.mjs <version> <tgz...>
//
// For each tarball of the three public packages:
//   - the name is one of the three, the version is <version>, it is not
//     private, and `publishConfig.access` is `public` (a scoped package is
//     restricted unless it says so);
//   - the licence is `AGPL-3.0-only OR LicenseRef-PMEL`, and LICENSE and
//     LICENSE.md are in it;
//   - `repository` names github.com/paged-media/paged and the package's
//     directory (npm checks it against the provenance of a trusted publish);
//   - no dependency of any kind is still `workspace:` or `catalog:`, there are
//     no devDependencies, and no dependency names an @paged-media package
//     that is not one of the three (a published package depends on nothing
//     private), at <version> if it does;
//   - main, types, bin and every `exports` target are files in the tarball;
//   - @paged-media/viewer: the viewer subset audit holds for the files
//     (engine/core/scripts/viewer-subset-audit.mjs --no-cargo);
//   - @paged-media/paged: the `paged` bin starts with a node shebang and
//     imports nothing but node: builtins (React only dynamically), and the
//     notices of the code bundled into it are there;
//   - @paged-media/plugin-sdk: nothing in it imports the private
//     @paged-media/plugin-api, and ./api is type-only (its index.js exports
//     nothing).
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
  "@paged-media/paged",
  "@paged-media/viewer",
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
      fail(`${pkg.name} is not one of the three public packages`);
    if (seen.has(pkg.name)) fail(`${pkg.name} appears twice`);
    seen.add(pkg.name);
    if (pkg.version !== version)
      fail(`version ${pkg.version}, expected ${version}`);
    if (pkg.private) fail("is private");
    if (pkg.publishConfig?.access !== "public")
      fail(
        "publishConfig.access is not public (a scoped package publishes restricted)",
      );
    if (pkg.devDependencies) fail("ships devDependencies");
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
        if (dep.startsWith("@paged-media/") && !NAMES.has(dep))
          fail(`${field}.${dep}: not a public package`);
        if (NAMES.has(dep) && spec !== version) {
          fail(
            `${field}.${dep} is ${spec}, expected ${version} (one version for the three)`,
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
    if (pkg.name === "@paged-media/viewer") {
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

    if (pkg.name === "@paged-media/paged") {
      const binFile = join(root, pkg.bin?.paged ?? "dist/paged.js");
      const code = has(pkg.bin?.paged ?? "")
        ? readFileSync(binFile, "utf8")
        : "";
      if (!code.startsWith("#!/usr/bin/env node\n"))
        fail("the paged bin has no node shebang");
      const imports = [
        ...code.matchAll(
          /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']/gm,
        ),
        ...code.matchAll(/(?:^|[\s;])import\s*["']([^"']+)["']/gm),
      ].map((m) => m[1]);
      const bad = imports.filter((x) => !x.startsWith("node:"));
      if (bad.length)
        fail(`the paged bin imports ${[...new Set(bad)].join(", ")}`);
      if (!has("dist/THIRD-PARTY-NOTICES.md"))
        fail("dist/THIRD-PARTY-NOTICES.md is missing");
    }
    if (pkg.name === "@paged-media/plugin-sdk") {
      for (const f of files.filter((x) => /\.(js|mjs|d\.ts)$/.test(x))) {
        if (
          /["']@paged-media\/plugin-api["']/.test(
            readFileSync(join(root, f), "utf8"),
          )
        )
          fail(`${f} imports the private @paged-media/plugin-api`);
      }
      const apiIndex = join(root, "dist/api/index.js");
      if (
        has("dist/api/index.js") &&
        readFileSync(apiIndex, "utf8").trim() !== "export {};"
      )
        fail("dist/api/index.js is not empty: ./api must stay type-only");
    }

    const unpacked = files.reduce(
      (n, f) => n + statSync(join(root, f)).size,
      0,
    );
    console.log(
      `${pkg.name}@${pkg.version} — ${files.length} files, ${(statSync(tgz).size / 1048576).toFixed(1)} MiB packed, ${(unpacked / 1048576).toFixed(1)} MiB unpacked`,
    );
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
