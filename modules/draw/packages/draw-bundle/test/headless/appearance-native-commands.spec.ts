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
// draws native appearance (engine ADR 1043), draw's appearance commands
// write `frameAppearance` — every selected item in ONE batch, one undo
// step — and a document's metadata stacks (draw ADR 354), plain or
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

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  appearanceBakeOf,
  appearanceOf,
  bakeAppearance,
  commitAppearance,
  drawBundle,
  installAppearanceMigration,
  migrateAppearanceStacks,
  readNativeAppearance,
  type AppearanceStack,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const C = "media.paged.draw.command";
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

  it("Add fill and Add stroke stack a native layer above their kind, one undo step each", async () => {
    covers("command:media.paged.draw.command.appearanceAddFill");
    covers("command:media.paged.draw.command.appearanceAddStroke");
    await h.objects.invoke(`${C}.appearanceAddFill`, { targets: [] });
    expect(await kinds(h)).toEqual(["frameFill", "fill", "frameStroke"]);
    const fill = (await readNativeAppearance(h.host, RECT))![1]!;
    // Seeded from the frame's own fill.
    expect(fill.color).toBe("Color/Black");
    await h.objects.invoke(`${C}.appearanceAddStroke`, { targets: [] });
    expect(await kinds(h)).toEqual([
      "frameFill",
      "fill",
      "frameStroke",
      "stroke",
    ]);
    // Nothing went into the envelope.
    expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual({
      fills: [],
      strokes: [],
    });
    await h.host.document.undo();
    expect(await kinds(h)).toEqual(["frameFill", "fill", "frameStroke"]);
    await h.host.document.undo();
    expect(await kinds(h)).toEqual([]);
  });

  it("Move layer, Remove layer and Clear edit the native list, one undo step each", async () => {
    covers("command:media.paged.draw.command.appearanceMoveLayer");
    covers("command:media.paged.draw.command.appearanceRemoveLayer");
    covers("command:media.paged.draw.command.appearanceClear");
    await h.objects.invoke(`${C}.appearanceAddFill`, { targets: [] });
    await h.objects.invoke(`${C}.appearanceAddStroke`, { targets: [] });
    // The extra fill (fill #0) one place up: above the frame's stroke.
    const run = (id: string, payload: unknown) =>
      (
        h.contributions.find((c) => c.kind === "command" && c.id === id)!
          .value as { handler: (p: unknown, a: unknown) => Promise<unknown> }
      ).handler(undefined, payload);
    await run(`${C}.appearanceMoveLayer`, {
      kind: "fill",
      index: 0,
      direction: "up",
    });
    expect(await kinds(h)).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
      "stroke",
    ]);
    await h.host.document.undo();
    expect(await kinds(h)).toEqual([
      "frameFill",
      "fill",
      "frameStroke",
      "stroke",
    ]);
    await run(`${C}.appearanceRemoveLayer`, { kind: "stroke", index: 0 });
    expect(await kinds(h)).toEqual(["frameFill", "fill", "frameStroke"]);
    // A placeholder is the frame's own paint: not removable.
    await run(`${C}.appearanceRemoveLayer`, { layer: 0 });
    expect(await kinds(h)).toEqual(["frameFill", "fill", "frameStroke"]);
    await run(`${C}.appearanceClear`, undefined);
    expect(await kinds(h)).toEqual([]);
    await h.host.document.undo();
    expect(await kinds(h)).toEqual(["frameFill", "fill", "frameStroke"]);
  });

  it("Bake has nothing to bake on a native appearance, and says so", async () => {
    await h.objects.invoke(`${C}.appearanceAddFill`, { targets: [] });
    const before = await kinds(h);
    await h.objects
      .invoke(`${C}.bakeAppearance`, { targets: [] })
      .catch(() => null);
    expect(await kinds(h)).toEqual(before);
    expect(
      appearanceBakeOf(await h.host.document.getMetadata(RECT)),
    ).toBeNull();
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

  it("a GROUP-BAKED stack is released and moved in the same ONE undo step", async () => {
    await commitAppearance(
      h.host,
      RECT,
      STACK,
      await h.host.document.getMetadata(RECT),
    );
    await bakeAppearance(h.host, RECT);
    const leavesBaked = (await h.host.document.tree()).length;
    expect(
      appearanceBakeOf(await h.host.document.getMetadata(RECT)),
    ).not.toBeNull();
    const moved = await migrateAppearanceStacks(h.host);
    expect(moved).toMatchObject({ moved: 1, released: 1 });
    expect(await kinds(h)).toEqual([
      "fill",
      "frameFill",
      "stroke",
      "frameStroke",
    ]);
    const env = await h.host.document.getMetadata(RECT);
    expect(appearanceBakeOf(env)).toBeNull();
    // The baked group and its derived paths are gone.
    const tree = await h.host.document.tree();
    expect(JSON.stringify(tree)).not.toContain('"group"');
    await h.host.document.undo();
    expect(
      appearanceBakeOf(await h.host.document.getMetadata(RECT)),
    ).not.toBeNull();
    expect((await h.host.document.tree()).length).toBe(leavesBaked);
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
