#!/usr/bin/env bun
/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The last step of plugin-sdk's build: the contract goes INTO the package
// (PM-0008, amendment 3). `@paged-media/plugin-api` is the contract's private
// source package; the published plugin-sdk carries its declarations as the
// type-only `./api` entry and depends on nothing private (ADR 331).
//
//   1. plugin-api's declarations are compiled with its own
//      tsconfig.build.json straight into dist/api/ (plugin-api's dist/ is
//      left alone, so the two packages' builds can run side by side), with
//      the vendored wire, an empty index.js and src/manifest.schema.json
//      beside them: what plugin-api's own build writes.
//   2. Every declaration plugin-sdk's tsc wrote that names
//      `@paged-media/plugin-api` names `./api/index.js` instead (relative to
//      the file), so the package's types resolve inside the package.
//   3. dist/api.d.ts, the declaration of src/api.ts (the workspace's
//      re-export), is replaced by dist/api/ and removed.
//   4. Nothing in dist/ names `@paged-media/plugin-api` any more: a leftover
//      fails the build, since an installed plugin-sdk could not resolve it.
//
// `--outdir <dir>` works on another build directory (the tests).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(pkg, "..", "plugin-api");
const args = process.argv.slice(2);
const outAt = args.indexOf("--outdir");
const dist = outAt >= 0 ? args[outAt + 1] : join(pkg, "dist");
const SPEC = "@paged-media/plugin-api";

const target = join(dist, "api");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const tsc = join(
  dirname(
    createRequire(join(pkg, "package.json")).resolve("typescript/package.json"),
  ),
  "bin",
  "tsc",
);
execFileSync(
  process.execPath,
  [tsc, "-p", join(api, "tsconfig.build.json"), "--outDir", target],
  { stdio: "inherit" },
);
copyFileSync(join(api, "src", "wire.d.ts"), join(target, "wire.d.ts"));
writeFileSync(join(target, "index.js"), "export {};\n");
copyFileSync(
  join(api, "src", "manifest.schema.json"),
  join(target, "manifest.schema.json"),
);
rmSync(join(dist, "api.d.ts"), { force: true });

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const quoted = new RegExp(`(["'])${SPEC.replace("/", "\\/")}\\1`, "g");
let rewritten = 0;
for (const file of walk(dist)) {
  if (file.startsWith(target + sep) || !file.endsWith(".d.ts")) continue;
  const text = readFileSync(file, "utf8");
  if (!text.includes(SPEC)) continue;
  let rel = relative(dirname(file), join(target, "index.js"))
    .split(sep)
    .join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  writeFileSync(
    file,
    text.replace(quoted, (_m, q) => `${q}${rel}${q}`),
  );
  rewritten++;
}

// An import of the package, not a mention of it in a comment.
const leftovers = walk(dist).filter(
  (f) =>
    /\.(d\.ts|js|mjs)$/.test(f) &&
    new RegExp(quoted.source).test(readFileSync(f, "utf8")),
);
if (leftovers.length) {
  console.error(
    `plugin-sdk: ${leftovers.map((f) => relative(pkg, f)).join(", ")} still name ${SPEC}, which the published package does not depend on.`,
  );
  process.exit(1);
}
if (!existsSync(join(target, "index.d.ts"))) {
  console.error("plugin-sdk: plugin-api's build wrote no index.d.ts");
  process.exit(1);
}
console.log(
  `plugin-sdk: the contract inlined as ./api (${walk(target).length} files); ${rewritten} declarations point at it`,
);
