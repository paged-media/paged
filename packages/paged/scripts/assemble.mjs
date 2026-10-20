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

// @paged-media/paged, assembled (PM-0008, amendment 3). The package is the
// engine on npm plus its command line, built from two private workspace
// packages that stay where they are:
//
//   1. the engine: every file `@paged-media/canvas-wasm` ships (its
//      package.json `files`: the canvas glue and wasm at the root,
//      introspect/ with catalog.json, repo/), copied here unchanged, so
//      `@paged-media/paged/introspect` is what `@paged-media/canvas-wasm/introspect`
//      is in the workspace. They must be built first: `moon run core:wasm-pkg`.
//   2. the `paged` bin: apps/cli bundled into dist/paged.js with every module
//      it imports inlined (apps/cli/scripts/bundle.mjs), and the licences of
//      the third-party code in it in dist/THIRD-PARTY-NOTICES.md. The bundle
//      finds its engine in this package at run time.
//   3. the face the bin sets text in when a run names none: Inter
//      (fonts/Inter.ttf, SIL Open Font License 1.1 in fonts/OFL-inter.txt),
//      the face the Rust CLI bundles, from engine/core/corpus/fonts (ADR 324,
//      amendment 2026-10-20). Without it a PDF's text pages come out blank.
//
//   bun scripts/assemble.mjs        (the package's `build` script)
//
// Every file it writes is a build output (.gitignore).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkg, "..", "..");
const engine = join(repo, "engine/core/packages/canvas-wasm");
const cli = join(repo, "apps/cli");

const engineFiles = JSON.parse(
  readFileSync(join(engine, "package.json"), "utf8"),
).files;
const missing = engineFiles.filter((f) => !existsSync(join(engine, f)));
if (missing.length) {
  console.error(
    `assemble: the engine is not built (${missing.join(", ")} missing in engine/core/packages/canvas-wasm): run \`moon run core:wasm-pkg\``,
  );
  process.exit(1);
}
let bytes = 0;
for (const f of engineFiles) {
  mkdirSync(dirname(join(pkg, f)), { recursive: true });
  copyFileSync(join(engine, f), join(pkg, f));
  bytes += statSync(join(pkg, f)).size;
}
console.log(
  `assemble: the engine, ${engineFiles.length} files (${(bytes / 1048576).toFixed(1)} MiB)`,
);

const fonts = join(repo, "engine/core/corpus/fonts");
mkdirSync(join(pkg, "fonts"), { recursive: true });
for (const f of ["Inter.ttf", "OFL-inter.txt"])
  copyFileSync(join(fonts, f), join(pkg, "fonts", f));
console.log(
  `assemble: the default face, fonts/Inter.ttf (${(statSync(join(pkg, "fonts/Inter.ttf")).size / 1048576).toFixed(2)} MiB)`,
);

execFileSync(
  "bun",
  [join(cli, "scripts/bundle.mjs"), join(pkg, "dist"), "--bin", "paged"],
  {
    stdio: "inherit",
  },
);

// The published files are all here (package.json `files`).
const files = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).files;
const absent = files.filter((f) => !existsSync(join(pkg, f)));
if (absent.length) {
  console.error(`assemble: ${absent.join(", ")} not written`);
  process.exit(1);
}
console.log(`assemble: @paged-media/paged ready (${files.length} files)`);
