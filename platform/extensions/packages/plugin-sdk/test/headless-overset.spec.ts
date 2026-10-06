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


// @feat: plugin-platform.text-measurement
//
// D-28 — the headless host reports overset like the editor does. The engine
// lays text out (and reports a story `overset`) only when it has a font; the
// editor loads every document with its default font, the headless host with
// none — so every story read `overset: false`, not measured. `defaultFont`
// is the headless stand-in for the editor's `defaultFontProvider`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
// Space Grotesk (SIL OFL 1.1, test/fixtures/fonts/OFL-spacegrotesk.txt).
const FONT = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/fonts/SpaceGrotesk-VF.ttf", import.meta.url))),
);

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

/** A 40 × 40 pt frame holding far more text than fits; its story's overset. */
async function overfilled(h: HeadlessHost): Promise<boolean | undefined> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertTextFrame", args: { pageId, bounds: [20, 20, 60, 60] } },
        { op: "bindCreated", args: { handle: "f" } },
        { op: "insertText", args: { storyId: "$h:f", offset: 0, text: "overset ".repeat(200) } },
      ],
    },
  } as never);
  expect(out.applied).toBe(true);
  const storyId = (out as { minted?: { storyId: string | null }[] }).minted?.[0]?.storyId;
  const stories = await h.host.document.collection<{ selfId: string; overset?: boolean }>("stories" as never);
  return stories.find((s) => s.selfId === storyId)?.overset;
}

describe("headless overset needs the default font (D-28)", () => {
  it("without a font nothing is laid out: an overfilled story reads not overset", async () => {
    live = await createHeadlessHost({ console: silent });
    expect(await overfilled(live)).toBe(false);
  });

  it("with defaultFont the overfilled story reads overset, as in the editor", async () => {
    live = await createHeadlessHost({ console: silent, defaultFont: FONT });
    expect(await overfilled(live)).toBe(true);
  });

  it("a document opened through host.documents lays out with it too", async () => {
    live = await createHeadlessHost({ console: silent, defaultFont: FONT });
    expect(await overfilled(live)).toBe(true);
    const copy = await live.host.documents.exportPaged();
    expect((await live.host.documents.open(copy)).opened).toBe(true);
    const stories = await live.host.document.collection<{ overset?: boolean }>("stories" as never);
    expect(stories.some((s) => s.overset)).toBe(true);
  });
});
