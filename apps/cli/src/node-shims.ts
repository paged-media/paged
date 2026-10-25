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

// The browser facility plugin bundles reach for that Node lacks, installed
// by the CLI before a bundle needs it. It is NARROW: it serves exactly the
// bundle-local files a browser host would serve, and refuses everything else
// (no network, no arbitrary file reads).
//
//  `fetch(file:…)` — wasm-bindgen `--target web` glue (data-js, sheets, …)
//  fetches its `_bg.wasm` next to its own module URL. Node's fetch has no
//  `file:` scheme; this serves `.wasm` files only.
//
// (paged.data's query store is inside its engine wasm since ADR 561: there is
// no second engine, worker or extension repository to stand in for.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let installed = false;

/** Install the shim (idempotent). */
export function installNodeShims(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as { fetch: typeof fetch };
  const realFetch = g.fetch.bind(globalThis);
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : (input as Request).url;
    if (href.startsWith("file:")) {
      const file = fileURLToPath(href);
      if (!file.endsWith(".wasm"))
        throw new TypeError(
          `paged CLI: fetch(${href}) — only bundle .wasm files are served from disk`,
        );
      return new Response(readFileSync(file), {
        headers: { "content-type": "application/wasm" },
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}
