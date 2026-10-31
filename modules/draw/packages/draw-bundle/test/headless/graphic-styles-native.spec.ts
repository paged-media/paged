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

// WP6.3 (draw ADR 367) through the REAL engine wasm: graphic styles on the
// engine's native appearance — a style carries the native fills and
// strokes and the object effects; apply writes them in ONE undo step and
// the link stays in sync; a library is exported, imported and merged; and
// a v1 library with its linked elements moves over on open without one
// link turning up overridden. [plugin-draw.graphic-styles]

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
  appearanceMutation,
  applyGraphicStyleToSelection,
  applySaveGraphicStyle,
  commitAppearance,
  drawBundle,
  graphicStyleLinks,
  migrateAppearanceStacks,
  objectStackMutation,
  parseGraphicStyleLibrary,
  readGraphicStyleLibrary,
  readNativeAppearance,
  readObjectStack,
  GRAPHIC_STYLES_PART,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { poly, squareItem } from "../panels/panel-document";
import { openHost } from "./host";

const C = "media.paged.draw.command";
const A = poly("a");
const B = poly("b");
const DOC = () =>
  packageWithSpread(
    squareItem("a", 100, 100, 100) + squareItem("b", 300, 100, 100),
  );

const run = (h: HeadlessHost, id: string, payload?: unknown) =>
  (
    h.contributions.find((c) => c.kind === "command" && c.id === id)!.value as {
      handler: (p: unknown, a: unknown) => Promise<unknown>;
    }
  ).handler(undefined, payload);

/** Give `id` an extra stroke and a zig zag. */
async function dress(h: HeadlessHost, id: ElementId) {
  await h.host.document.mutate({
    op: "batch",
    args: {
      ops: [
        appearanceMutation(id, [
          { kind: "frameFill" },
          { kind: "frameStroke" },
          { kind: "stroke", color: "Color/Black", weight: 6, opacityPct: 50 },
        ]),
        objectStackMutation(id, [
          { kind: "zigZag", enabled: true, size: 4, ridges: 3 },
        ]),
      ],
    },
  } as never);
}

describe("graphic styles on native appearance (draw ADR 367) [plugin-draw.graphic-styles]", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([]);
  });

  it("save carries the native layers and effects; apply writes them in ONE undo step, in sync", async () => {
    await dress(h, A);
    await h.host.selection.set([A]);
    const style = (await applySaveGraphicStyle(h.host, { name: "Zig" }))!;
    expect(style.appearance.layers?.map((l) => l.kind)).toEqual([
      "frameFill",
      "frameStroke",
      "stroke",
    ]);
    expect(style.appearance.effects?.map((e) => e.kind)).toEqual(["zigZag"]);
    const lib = parseGraphicStyleLibrary(
      await h.host.parts.read(GRAPHIC_STYLES_PART),
    );
    expect(lib.v).toBe(2);
    await h.host.selection.set([B]);
    await applyGraphicStyleToSelection(h.host, style.id);
    expect((await readNativeAppearance(h.host, B))!.map((l) => l.kind)).toEqual(
      ["frameFill", "frameStroke", "stroke"],
    );
    expect((await readObjectStack(h.host, B))!.map((e) => e.kind)).toEqual([
      "zigZag",
    ]);
    const links = await graphicStyleLinks(h.host, style.id);
    expect(links.map((l) => [String(l.id.id), l.overridden]).sort()).toEqual([
      ["a", false],
      ["b", false],
    ]);
    await h.host.document.undo();
    expect(await readNativeAppearance(h.host, B)).toEqual([]);
    expect(await readObjectStack(h.host, B)).toEqual([]);
  });

  it("export, import and merge", async () => {
    covers("command:media.paged.draw.command.exportGraphicStyles");
    covers("command:media.paged.draw.command.importGraphicStyles");
    covers("command:media.paged.draw.command.mergeGraphicStyles");
    await dress(h, A);
    await h.host.selection.set([A]);
    const zig = (await applySaveGraphicStyle(h.host, { name: "Zig" }))!;
    await h.host.selection.set([B]);
    const plain = (await applySaveGraphicStyle(h.host, { name: "Plain" }))!;
    const text = (await run(h, `${C}.exportGraphicStyles`, {
      styles: [zig.id],
      save: false,
    })) as string;
    expect(JSON.parse(text)).toMatchObject({ paged: "graphicStyles", v: 2 });
    const added = (await run(h, `${C}.importGraphicStyles`, {
      json: text,
    })) as string[];
    expect(added).toHaveLength(1);
    const lib = await readGraphicStyleLibrary(h.host);
    expect(lib.styles.map((s) => s.name)).toEqual(["Zig", "Plain", "Zig 2"]);
    await expect(
      run(h, `${C}.importGraphicStyles`, { json: "{}" }),
    ).rejects.toThrow(/not a graphic style library/);
    const merged = (await run(h, `${C}.mergeGraphicStyles`, {
      styles: [plain.id, zig.id],
      name: "",
    })) as string;
    const m = (await readGraphicStyleLibrary(h.host)).styles.find(
      (s) => s.id === merged,
    )!;
    expect(m.name).toBe("Plain + Zig");
    // Plain's own paint, then Zig's fill (its own, as a real layer) and
    // its extra stroke on top — Zig's own stroke is none, so it adds none —
    // and Zig's zig zag.
    expect(m.appearance.layers!.map((l) => l.kind)).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
      "stroke",
    ]);
    expect(m.appearance.effects!.map((e) => e.kind)).toEqual(["zigZag"]);
    await expect(
      run(h, `${C}.mergeGraphicStyles`, { styles: [zig.id], name: "x" }),
    ).rejects.toThrow(/two styles/);
  });

  it("a v1 library and its links move over on open, in sync", async () => {
    // Made on a host without native appearance (draw ADR 354's lane).
    const supports = h.host.supports.bind(h.host);
    (h.host as { supports: (f: string) => boolean }).supports = (f) =>
      f !== "document.appearance@1" && supports(f);
    await commitAppearance(
      h.host,
      A,
      {
        fills: [{ color: "Color/Black", tint: 30 }, { color: "Color/Black" }],
        strokes: [{ color: "Color/Black", weight: 3 }],
      },
      await h.host.document.getMetadata(A),
    );
    await h.host.selection.set([A]);
    const style = (await applySaveGraphicStyle(h.host, { name: "Old" }))!;
    expect(
      parseGraphicStyleLibrary(await h.host.parts.read(GRAPHIC_STYLES_PART)).v,
    ).toBe(1);
    (h.host as { supports: (f: string) => boolean }).supports = supports;

    const moved = await migrateAppearanceStacks(h.host);
    expect(moved).toMatchObject({ moved: 1, restamped: 1, library: true });
    expect((await readNativeAppearance(h.host, A))!.map((l) => l.kind)).toEqual(
      ["fill", "frameFill", "frameStroke"],
    );
    const lib = parseGraphicStyleLibrary(
      await h.host.parts.read(GRAPHIC_STYLES_PART),
    );
    expect(lib.v).toBe(2);
    expect(lib.styles[0]!.appearance.layers!.map((l) => l.kind)).toEqual([
      "fill",
      "frameFill",
      "frameStroke",
    ]);
    const links = await graphicStyleLinks(h.host, style.id);
    expect(links.map((l) => l.overridden)).toEqual([false]);
    // Applying the converted style elsewhere reads in sync too.
    await h.host.selection.set([B]);
    await applyGraphicStyleToSelection(h.host, style.id);
    const all = await graphicStyleLinks(h.host, style.id);
    expect(all.map((l) => l.overridden)).toEqual([false, false]);
    // Nothing is left to move.
    expect(await migrateAppearanceStacks(h.host)).toBeNull();
  });
});
