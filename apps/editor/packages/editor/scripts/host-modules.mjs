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

// The wasm the package does not ship, on the module host before the package
// is published (docs/adr/PM-0013, ADR 220): every file of dist/modules.json
// (paged.data's engines, which its module door names) is at
// <host>/<package>/<host version>/<path>, uploaded from the workspace
// package when it is not there yet. Its integrity is checked against the
// manifest first, so the host never serves bytes the door would refuse.
//
//   bun scripts/host-modules.mjs [<dist dir>] [--dry-run]
//
// Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID with R2 write access
// (not for --dry-run, which reports what it would upload).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pagedPackages } from "../../../apps/canvas/scripts/module-index.mjs";
import { present, upload } from "../../../apps/canvas/scripts/module-host.mjs";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const dist = resolve(
  args.find((a) => !a.startsWith("--")) ?? join(PKG, "dist"),
);
const manifest = JSON.parse(readFileSync(join(dist, "modules.json"), "utf8"));
const roots = new Map(pagedPackages().map((p) => [p.name, p.root]));

let failed = false;
for (const [name, pkg] of Object.entries(manifest.packages)) {
  const root = roots.get(name);
  for (const [path, file] of Object.entries(pkg.files)) {
    const url = `${manifest.host}/${name}/${file.version}/${path}`;
    if (await present(url)) {
      console.log(`${url} · already hosted`);
      continue;
    }
    if (!root) {
      console.error(`::error::${url} is missing and ${name} is not installed`);
      failed = true;
      continue;
    }
    const local = join(root, ...path.split("/"));
    const bytes = readFileSync(local);
    const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
    if (integrity !== file.integrity) {
      console.error(
        `::error::${local} is not the file the build listed (${integrity} != ${file.integrity})`,
      );
      failed = true;
      continue;
    }
    if (dry) {
      console.log(`${url} · would upload`);
      continue;
    }
    const key = `${name}/${file.version}/${path}`;
    const br = upload(key, local);
    console.log(`${url} · uploaded (${(br / 1048576).toFixed(1)} MiB brotli)`);
  }
}
if (failed) process.exit(1);
