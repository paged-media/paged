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

// The real engine (published canvas-wasm through the plugin-sdk headless
// host) behind the ScriptEngine door, on the SDK's minimal one-page IDML
// with a font loaded so overset is measured.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createHeadlessHost,
  type HeadlessHost,
} from "../../plugin-sdk/src/harness";
import { minimalIdml } from "../../plugin-sdk/test/fixtures/minimal-idml";
import type { ScriptEngine } from "../src";

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../plugin-sdk/test/fixtures/fonts/SpaceGrotesk-VF.ttf",
        import.meta.url,
      ),
    ),
  ),
);
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Console;

export async function headlessEngine(): Promise<{
  engine: ScriptEngine;
  host: HeadlessHost;
}> {
  const host = await createHeadlessHost({ console: silent, defaultFont: FONT });
  await host.load(minimalIdml());
  return { host, engine: { runScript: (source) => host.runScript(source) } };
}
