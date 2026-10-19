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

import type { ViewerSessionLike } from "./session.js";

/**
 * Create a `ViewerSession` from the wasm that ships in this package
 * (`wasm/paged_sdk.js` + `wasm/paged_sdk_bg.wasm`, the `./session`
 * entry). In a source checkout `wasm/` is a build output:
 * `bash engine/core/scripts/build-wasm-packages.sh --workspace session`
 * (or `moon run core:wasm-pkg`) writes it.
 *
 * `wasmUrl` overrides the `.wasm` location for bundlers that move
 * assets; default resolves next to the glue file.
 */
export async function createSessionFromBundledWasm(
  wasmUrl?: string,
): Promise<ViewerSessionLike> {
  const glueUrl = new URL("../wasm/paged_sdk.js", import.meta.url).href;
  // Dynamic, computed import — left untouched by TS and bundlers so
  // the glue resolves at runtime inside the published package.
  const mod = (await import(/* @vite-ignore */ glueUrl)) as {
    default: (init?: { module_or_path: string }) => Promise<unknown>;
    // `new` here is wasm-bindgen's STATIC factory (async), not a
    // construct signature — hence the quoted method name.
    ViewerSession: { ["new"](): Promise<ViewerSessionLike> };
  };
  await mod.default(wasmUrl ? { module_or_path: wasmUrl } : undefined);
  return mod.ViewerSession["new"]();
}
