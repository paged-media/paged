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

// The module host's two operations (ADR 220): is a module there, and put
// one there. Shared by scripts/modules-sync.mjs (the editor deploy) and
// the @paged-media/editor package's release (packages/editor/scripts/
// host-modules.mjs).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

export const BUCKET = process.env.PAGED_MODULE_BUCKET ?? "paged-modules";

export async function present(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export function upload(key, file) {
  const raw = readFileSync(file);
  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 10,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  // In a temp dir: the file may be inside the package store (a declared
  // module this build did not emit).
  const dir = mkdtempSync(join(tmpdir(), "paged-modules-"));
  const tmp = join(dir, "module.wasm.br");
  writeFileSync(tmp, br);
  execFileSync(
    "npx",
    [
      "-y",
      "wrangler@4",
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      // Wrangler 4 runs `r2 object` commands against the local simulator
      // unless told otherwise.
      "--remote",
      "--file",
      tmp,
      "--content-type",
      "application/wasm",
      "--content-encoding",
      "br",
      "--cache-control",
      "public, max-age=31536000, immutable",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  rmSync(dir, { recursive: true, force: true });
  return br.length;
}
