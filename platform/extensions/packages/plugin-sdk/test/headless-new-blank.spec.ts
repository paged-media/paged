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

// newBlank — a headless host can start from nothing (the CLI's
// `paged ai --new`, a document built from a brief), not only from a file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/fonts/SpaceGrotesk-VF.ttf", import.meta.url),
    ),
  ),
);
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Console;
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
    expect(run.output[0]).toMatch(
      /^\[log\] \[595(\.0)?,842(\.0)?\] textFrame:/,
    );
  });
});
