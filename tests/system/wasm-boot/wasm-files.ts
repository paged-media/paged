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

// Every wasm the editor ships, with the sha384 its module host stamps on it:
// the engine's (engine/core/packages/canvas-wasm: the canvas, introspect/ and
// repo/) and every file a bundle's manifest declares, as the editor's module
// manifest lists them (`virtual:paged-modules`, apps/canvas/scripts/
// module-index.mjs). A declared file that is not built makes the manifest
// throw, and with it this lane: a product with a missing wasm is incomplete.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildModuleManifest } from "../../../apps/editor/apps/canvas/scripts/module-index.mjs";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const ENGINE_PACKAGE = join(
  REPO_ROOT,
  "engine",
  "core",
  "packages",
  "canvas-wasm",
);

export interface WasmFile {
  /** `engine` or the bundle's package name. */
  owner: string;
  /** The path inside its owner. */
  file: string;
  /** The absolute path on disk. */
  fs: string;
  /** `sha384-…`, the integrity the page fetches it with. */
  integrity: string;
  /** The wasm-bindgen glue beside it, when it has one: booted through it. */
  glue: string | null;
}

/** The bundles that ship wasm, pinned: one leaving the manifest (or a new one
 *  joining it without a row here) fails the list test by name. */
export const WASM_BUNDLES = [
  "@paged-media/data",
  "@paged-media/doc",
  "@paged-media/draw",
  "@paged-media/image",
  "@paged-media/pdf",
  "@paged-media/sheet",
  "@paged-media/slide",
  "@paged-media/web",
] as const;

const sha384 = (path: string) =>
  `sha384-${createHash("sha384").update(readFileSync(path)).digest("base64")}`;

function glueOf(path: string): string | null {
  const glue = path.replace(/_bg\.wasm$/, ".js");
  return glue !== path && existsSync(glue) ? glue : null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".wasm")) out.push(p);
  }
  return out;
}

export function wasmFiles(): WasmFile[] {
  const files: WasmFile[] = [];
  for (const fs of walk(ENGINE_PACKAGE).sort()) {
    files.push({
      owner: "engine",
      file: relative(ENGINE_PACKAGE, fs),
      fs,
      integrity: sha384(fs),
      glue: glueOf(fs),
    });
  }
  const manifest = buildModuleManifest({ host: null, dev: true }) as {
    packages: Record<
      string,
      { files: Record<string, { integrity: string; fs?: string }> }
    >;
  };
  for (const [pkg, entry] of Object.entries(manifest.packages).sort()) {
    for (const [file, f] of Object.entries(entry.files).sort()) {
      if (!file.endsWith(".wasm") || !f.fs) continue;
      files.push({
        owner: pkg,
        file,
        fs: f.fs,
        integrity: f.integrity,
        glue: glueOf(f.fs),
      });
    }
  }
  return files;
}
