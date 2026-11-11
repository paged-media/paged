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

// WP6.3 (draw ADR 367) through the REAL engine wasm: on an engine that
// draws native appearance (engine ADR 1043), a document's metadata stacks (draw ADR 354), plain or
// group-baked, move onto it when it opens, in one undo step, once.
// [frames-paths.native-appearance] [plugin-draw.appearance]

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  appearanceBakeOf,
  appearanceOf,
  commitAppearance,
  drawBundle,
  installAppearanceMigration,
  migrateAppearanceStacks,
  readNativeAppearance,
  type AppearanceStack,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

/** A document an older paged.draw saved with a group-baked stack. */
const LEGACY_BAKE = join(
  import.meta.dir,
  "../fixtures/legacy/appearance-bake.idml",
);
const CARRIER = { kind: "rectangle", id: "urect" } as ElementId;
const RECT = {
  kind: "rectangle",
  id: F1_MULTI_SHAPE.ids.rectangle!,
} as ElementId;

const STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 40, opacity: 50, blendMode: "Multiply" },
    { color: "Color/Paper", opacity: 80 },
  ],
  strokes: [
    { color: "Color/Black", weight: 8 },
    { color: "Color/Paper", weight: 2 },
  ],
};

const kinds = async (h: HeadlessHost) =>
  ((await readNativeAppearance(h.host, RECT)) ?? []).map((l) => l.kind);

describe("draw appearance on the engine's native appearance (draw ADR 367) [frames-paths.native-appearance]", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(F1_MULTI_SHAPE.bytes());
    await h.host.selection.set([RECT]);
  });

  it("a metadata stack moves onto the native appearance in ONE undo step, once", async () => {
    await commitAppearance(
      h.host,
      RECT,
      STACK,
      await h.host.document.getMetadata(RECT),
    );
    const moved = await migrateAppearanceStacks(h.host);
    expect(moved).toMatchObject({ moved: 1, released: 0 });
    expect(await kinds(h)).toEqual([
      "fill",
      "frameFill",
      "stroke",
      "frameStroke",
    ]);
    expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual({
      fills: [],
      strokes: [],
    });
    // Idempotent: nothing is left to move.
    expect(await migrateAppearanceStacks(h.host)).toBeNull();
    await h.host.document.undo();
    expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual(
      STACK,
    );
    expect(await kinds(h)).toEqual([]);
  });

  it("a GROUP-BAKED stack of an older document is released and moved when it opens, in ONE undo step", async () => {
    // A document saved while draw still baked a stack into a group of
    // derived paths (draw ADR 354): the carrier `urect` holds the record,
    // and the bundle's migration releases and moves it on open.
    await h.load(new Uint8Array(readFileSync(LEGACY_BAKE)));
    const baked = async () =>
      appearanceBakeOf(await h.host.document.getMetadata(CARRIER)) !== null;
    const deadline = Date.now() + 10_000;
    while ((await baked()) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(await baked()).toBe(false);
    const layers = ((await readNativeAppearance(h.host, CARRIER)) ?? []).map(
      (l) => l.kind,
    );
    expect(layers).toContain("fill");
    expect(layers).toContain("frameFill");
    // The baked group and its derived paths are gone.
    expect(JSON.stringify(await h.host.document.tree())).not.toContain(
      '"group"',
    );
    // One undo step gives the older document back as it was.
    await h.host.document.undo();
    expect(await baked()).toBe(true);
    expect(JSON.stringify(await h.host.document.tree())).toContain('"group"');
  });

  it("the migration runs when a document opens", async () => {
    await commitAppearance(
      h.host,
      RECT,
      STACK,
      await h.host.document.getMetadata(RECT),
    );
    const m = installAppearanceMigration(h.host);
    await m.idle();
    m.dispose();
    expect(await kinds(h)).toEqual([
      "fill",
      "frameFill",
      "stroke",
      "frameStroke",
    ]);
  });
});
