#!/usr/bin/env bun
/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The package's dist/ (docs/adr/PM-0013):
//
//   1. the editor, by vite.config.lib.ts (the engine wasm and every module
//      wasm built first: `moon run core:wasm-pkg`, each module's `wasm`
//      task, `data:duckdb`);
//   2. the declarations of the three entries, by TypeScript (src/types.ts
//      is the whole public contract, so they name no private package);
//   3. the data a host's tooling reads: feature-ids.json and
//      theme-tokens.json;
//   4. scripts/check-dist.mjs over the result.
//
//   bun scripts/build.mjs        (the package's `build` script)

import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITOR = resolve(PKG, "..", "..");
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: PKG, stdio: "inherit" });

run("bunx", ["--bun", "vite", "build", "-c", "vite.config.lib.ts"]);
run("bunx", ["tsc", "-p", "tsconfig.build.json"]);
// The declarations of the build-internal module are not part of the package.
rmSync(join(PKG, "dist/asset-base.d.ts"), { force: true });
copyFileSync(
  join(EDITOR, "apps/canvas/feature-ids.json"),
  join(PKG, "dist/feature-ids.json"),
);
copyFileSync(
  join(EDITOR, "docs/theme-tokens.json"),
  join(PKG, "dist/theme-tokens.json"),
);
run("bun", ["scripts/check-dist.mjs"]);
