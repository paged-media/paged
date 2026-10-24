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

// Shared boot for specs that need the REAL data-js engine in Node: the wasm
// the bundle ships (bin/data_js_bg.wasm), the query store inside it. The
// bundle's glue fetches the wasm by URL, which Node cannot; this hands it the
// bytes instead. Nothing else is swapped: the store, the session and the
// lowering are the shipped code.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
export const BIN = join(PKG, "bin");
export const DATA_JS_WASM = join(BIN, "data_js_bg.wasm");
/** CI sets it: a missing engine wasm fails a lane instead of skipping it. */
export const REQUIRE_REAL_ENGINE = process.env.REQUIRE_REAL_ENGINE === "1";
/** Whether the engine wasm is built (`bash scripts/build-wasm.sh`). */
export const HAVE_ENGINE = existsSync(DATA_JS_WASM);

/** Boot the REAL data-js engine in Node. */
export async function bootRealEngine(today: number): Promise<any> {
  const mod = await import(join(BIN, "data_js.js"));
  await mod.default({ module_or_path: readFileSync(DATA_JS_WASM) });
  return new mod.DataEngine(today);
}
