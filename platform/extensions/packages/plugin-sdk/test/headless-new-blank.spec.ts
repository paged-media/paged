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

// newBlank — a headless host can start from nothing (the CLI's
// `paged ai --new`, a document built from a brief), not only from a file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";

const FONT = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/fonts/SpaceGrotesk-VF.ttf", import.meta.url))));
const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Console;
let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("headless newBlank", () => {
  it("makes a one-page document of the given size that scripts can author", async () => {
    live = await createHeadlessHost({ console: silent, defaultFont: FONT });
    const pages = await live.newBlank(595, 842);
    expect(pages).toHaveLength(1);
    const run = await live.runScript(`
      const p = JSON.parse(paged.pages());
      const f = paged.insertTextFrame(p[0].selfId, [72, 72, 200, 523]);
      console.log(JSON.stringify(p[0].sizePt), f);`);
    expect(run.error).toBeNull();
    expect(run.output[0]).toMatch(/^\[log\] \[595(\.0)?,842(\.0)?\] textFrame:/);
  });
});
