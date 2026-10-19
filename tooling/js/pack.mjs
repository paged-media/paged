#!/usr/bin/env node
// The publish tarball of one workspace package, as `pnpm pack` made it.
//
//   bun tooling/js/pack.mjs <package dir> <destination dir>
//
// Prints the tarball's path. `bun pm pack` turns `workspace:` and `catalog:`
// specifiers into versions; what pnpm did besides, and Bun does not, happens
// here first:
//
//   1. publishConfig: its manifest fields (main, types, exports, bin, ...)
//      replace the top-level ones and leave publishConfig. In the repository
//      those fields point at src/*.ts (the workspace consumes source); the
//      published package points at dist/.
//   2. The lifecycle scripts that only mean something before publishing
//      (prepublishOnly, prepack, ...) are left out of the packed manifest.
//   3. A package with no LICENSE file of its own gets the ones of its module
//      (the nearest directory above it that has any: modules/draw for
//      modules/draw/packages/draw-bundle), as pnpm copied them from its
//      workspace root.
//
// package.json is restored and the copied licence files are removed
// afterwards, whether packing worked or not. The publish workflows upload the
// tarball with `npm publish <tgz>`, because npm does OIDC trusted publishing.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const [dirArg, destArg] = process.argv.slice(2);
if (!dirArg || !destArg) {
  console.error(
    "usage: bun tooling/js/pack.mjs <package dir> <destination dir>",
  );
  process.exit(2);
}
const dir = resolve(dirArg);
const dest = resolve(destArg);
const file = join(dir, "package.json");
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

// The fields pnpm moves out of publishConfig, and the scripts it drops
// (@pnpm/exportable-manifest).
const PUBLISH_CONFIG_FIELDS = [
  "bin",
  "type",
  "imports",
  "main",
  "module",
  "typings",
  "types",
  "exports",
  "browser",
  "esnext",
  "es2015",
  "unpkg",
  "umd:main",
  "os",
  "cpu",
  "libc",
  "typesVersions",
];
const PREPUBLISH_SCRIPTS = [
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
];
const isLicense = (name) => /^licen[cs]e(\..*)?$/i.test(name);

const original = readFileSync(file, "utf8");
const manifest = JSON.parse(original);
const publishConfig = manifest.publishConfig ?? {};
for (const key of PUBLISH_CONFIG_FIELDS) {
  if (key in publishConfig) {
    manifest[key] = publishConfig[key];
    delete publishConfig[key];
  }
}
if (manifest.scripts) {
  const scripts = manifest.scripts;
  for (const s of PREPUBLISH_SCRIPTS) delete scripts[s];
  delete manifest.scripts;
  manifest.scripts = scripts;
}

const copied = [];
if (!readdirSync(dir).some(isLicense)) {
  for (let up = dirname(dir); up.startsWith(REPO); up = dirname(up)) {
    const found = readdirSync(up).filter(isLicense);
    if (found.length === 0) continue;
    for (const name of found) {
      copyFileSync(join(up, name), join(dir, name));
      copied.push(join(dir, name));
    }
    break;
  }
}

let out = "";
try {
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  out = execFileSync("bun", ["pm", "pack", "--destination", dest, "--quiet"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
} finally {
  writeFileSync(file, original);
  for (const f of copied) if (existsSync(f)) rmSync(f);
}
// --quiet prints only the tarball's name.
const name = out.trim().split("\n").pop();
console.log(resolve(dest, name));
