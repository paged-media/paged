#!/usr/bin/env node
// The publish tarballs of the four public npm packages at one release version
// (PM-0008):
//
//   bun tooling/release/stage.mjs <version> <destination dir> [--keep]
//
// 1. The version must be MAJOR.MINOR.PATCH[-prerelease] and carry the engine's
//    protocol as its minor: 0.<protocol>.<patch>, the protocol read from
//    canvas-wasm's committed 0.<protocol>.0-dev (which
//    engine/core/scripts/check-wasm-package-versions.mjs holds to
//    PROTOCOL_VERSION). The editor reads the protocol from that minor.
// 2. Each package.json gets the release version, and `bun install` records it
//    in bun.lock: `bun pm pack` rewrites a `workspace:` specifier to the
//    version the LOCKFILE records, so without this plugin-sdk would depend on
//    plugin-api's in-tree counter (0.2.N-canary.0), a version npm never had.
// 3. tooling/js/pack.mjs packs each package (workspace: and catalog: resolved,
//    publishConfig applied) into the destination.
// 4. tooling/release/verify-tarballs.mjs checks the tarballs.
//
// The package.json files and bun.lock are restored afterwards (unless --keep),
// so a local dry run leaves the tree as it was. Release versions are never
// committed. The built files the packages ship (the engine wasm, plugin-api's
// and plugin-sdk's dist/, the idml-viewer's dist/) must exist before this runs.
//
// Prints one line per tarball: `<name>\t<path>`.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The public packages, in publish order (a dependency before its dependents). */
export const PUBLIC_PACKAGES = [
  { name: "@paged-media/canvas-wasm", dir: "engine/core/packages/canvas-wasm" },
  { name: "@paged-media/idml-viewer", dir: "engine/core/web/idml-viewer" },
  {
    name: "@paged-media/plugin-api",
    dir: "platform/extensions/packages/plugin-api",
  },
  {
    name: "@paged-media/plugin-sdk",
    dir: "platform/extensions/packages/plugin-sdk",
  },
];

export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** The engine protocol of the tree: the minor of canvas-wasm's dev version. */
export function treeProtocol() {
  const v = JSON.parse(
    readFileSync(join(REPO, PUBLIC_PACKAGES[0].dir, "package.json"), "utf8"),
  ).version;
  const m = /^0\.(\d+)\.0-dev$/.exec(v);
  if (!m)
    throw new Error(
      `canvas-wasm's committed version ${v} is not 0.<protocol>.0-dev`,
    );
  return Number(m[1]);
}

/** Why `version` cannot be released from this tree, or null. */
export function versionProblem(version) {
  const m = VERSION_RE.exec(version);
  if (!m) return `${version} is not MAJOR.MINOR.PATCH[-prerelease]`;
  const protocol = treeProtocol();
  if (m[1] !== "0" || Number(m[2]) !== protocol) {
    return `${version} does not carry the engine's protocol: tag v0.${protocol}.<patch> (canvas-wasm is 0.${protocol}.0-dev)`;
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const [version, destArg] = args.filter((a) => !a.startsWith("--"));
  if (!version || !destArg) {
    console.error(
      "usage: bun tooling/release/stage.mjs <version> <destination dir> [--keep]",
    );
    process.exit(2);
  }
  const problem = versionProblem(version);
  if (problem) {
    console.error(`::error::stage: ${problem}`);
    process.exit(1);
  }
  const dest = resolve(destArg);
  mkdirSync(dest, { recursive: true });

  const files = [
    ...PUBLIC_PACKAGES.map((p) => join(REPO, p.dir, "package.json")),
    join(REPO, "bun.lock"),
  ];
  const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const tarballs = [];
  try {
    for (const p of PUBLIC_PACKAGES) {
      const file = join(REPO, p.dir, "package.json");
      const text = originals.get(file);
      const manifest = JSON.parse(text);
      if (manifest.name !== p.name)
        throw new Error(`${p.dir} is ${manifest.name}, expected ${p.name}`);
      if (manifest.private) throw new Error(`${p.name} is private`);
      // Only the one field, so the rest of the file stays as written.
      writeFileSync(
        file,
        text.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`),
      );
    }
    execFileSync("bun", ["install", "--silent"], {
      cwd: REPO,
      stdio: "inherit",
    });
    for (const p of PUBLIC_PACKAGES) {
      const out = execFileSync(
        "bun",
        [join(REPO, "tooling/js/pack.mjs"), join(REPO, p.dir), dest],
        {
          cwd: REPO,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      tarballs.push({ name: p.name, path: out.trim().split("\n").pop() });
    }
    execFileSync(
      "bun",
      [
        join(REPO, "tooling/release/verify-tarballs.mjs"),
        version,
        ...tarballs.map((t) => t.path),
      ],
      { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] },
    );
  } finally {
    if (!keep) {
      for (const [f, text] of originals) writeFileSync(f, text);
      try {
        execFileSync("bun", ["install", "--frozen-lockfile", "--silent"], {
          cwd: REPO,
          stdio: "inherit",
        });
      } catch {
        console.error(
          "stage: restoring the install failed; run `bun install --frozen-lockfile`",
        );
      }
    }
  }
  for (const t of tarballs) console.log(`${t.name}\t${t.path}`);
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url))
  main();
