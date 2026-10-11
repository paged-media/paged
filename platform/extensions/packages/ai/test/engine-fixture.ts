/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The real engine (published canvas-wasm through the plugin-sdk headless
// host) behind the ScriptEngine door, on the SDK's minimal one-page IDML
// with a font loaded so overset is measured.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createHeadlessHost, type HeadlessHost } from "../../plugin-sdk/src/harness";
import { minimalIdml } from "../../plugin-sdk/test/fixtures/minimal-idml";
import type { ScriptEngine } from "../src";

const FONT = new Uint8Array(readFileSync(fileURLToPath(new URL("../../plugin-sdk/test/fixtures/fonts/SpaceGrotesk-VF.ttf", import.meta.url))));
const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Console;

export async function headlessEngine(): Promise<{ engine: ScriptEngine; host: HeadlessHost }> {
  const host = await createHeadlessHost({ console: silent, defaultFont: FONT });
  await host.load(minimalIdml());
  return { host, engine: { runScript: (source) => host.runScript(source) } };
}
