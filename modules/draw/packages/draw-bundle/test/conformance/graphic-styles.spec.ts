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

// GRAPHIC STYLES conformance — the Illustrator Phase-2 row: a named,
// LINKED complete appearance. What this pins:
//
//   (1) the PERSISTENCE shape — the library is one `.paged` container
//       part (`paged/media.paged.draw/graphic-styles.json`), read back
//       through the REAL engine's parts door, and a corrupt/foreign
//       part degrades to an empty library instead of taking the
//       document with it;
//   (2) the exact WIRE shape of the apply — ONE batch: the projected
//       base paint, the front-most-layer bake, then the raw metadata
//       stamp carrying both the stack and the link;
//   (3) the REAL undo count (RFI C-15 — measure it, never claim "one"):
//       an apply is ONE step per element, a break-link is ONE, and the
//       LIBRARY is not on the undo stack at all (a container write is
//       not an engine mutation — asserted, not assumed);
//   (4) the LINK semantics decision: a direct appearance edit does NOT
//       break the link, it marks the element OVERRIDDEN, and a REDEFINE
//       propagates to every linked element INCLUDING the overridden one;
//   (5) the KIND PROJECTION: a batch is atomic and the engine refuses a
//       property a kind has no slot for, so applying a fill-bearing
//       style to a GraphicLine drops the fill half rather than failing
//       — and the link it records is still in sync;
//   (6) the honest refusals (a BAKED appearance, a host with no
//       container writer) and the panel's registration + inline note.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceOf,
  commitAppearance,
  applyBreakGraphicStyleLink,
  applyDeleteGraphicStyle,
  applyGraphicStyleBatchFor,
  applyGraphicStyleToSelection,
  applyRedefineGraphicStyle,
  applyRenameGraphicStyle,
  applySaveGraphicStyle,
  canonicalGraphicAppearance,
  findGraphicStyle,
  graphicAppearanceDigest,
  graphicStyleBaseMutations,
  graphicStyleLinks,
  graphicStyleOverridden,
  graphicStyleRefOf,
  graphicStyleRefusalOf,
  graphicStyleRowLabel,
  mintGraphicStyleId,
  parseGraphicStyleLibrary,
  projectGraphicAppearance,
  readGraphicAppearance,
  readGraphicStyleLibrary,
  removeGraphicStyleFrom,
  renameGraphicStyleIn,
  serializeGraphicStyleLibrary,
  upsertGraphicStyle,
  withGraphicStyleRef,
  writeGraphicStyleLibrary,
  APPLY_GRAPHIC_STYLE_COMMAND_ID,
  BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID,
  DELETE_GRAPHIC_STYLE_COMMAND_ID,
  EMPTY_GRAPHIC_STYLE_BASE,
  GRAPHIC_STYLES_COMMAND_IDS,
  GRAPHIC_STYLES_NOTE,
  GRAPHIC_STYLES_PANEL_ID,
  GRAPHIC_STYLES_PART,
  REDEFINE_GRAPHIC_STYLE_COMMAND_ID,
  RENAME_GRAPHIC_STYLE_COMMAND_ID,
  SAVE_GRAPHIC_STYLE_COMMAND_ID,
  type AppearanceStack,
  type GraphicStyle,
  type GraphicStyleAppearance,
  type GraphicStyleLibrary,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as ElementId;
const LINE = { kind: "graphicLine", id: F1_MULTI_SHAPE.ids.graphicLine! } as ElementId;

/** A rectangle's full vocabulary (the paths the projection cares about). */
const RECT_PATHS = [
  "frameFillColor",
  "frameFillTint",
  "frameStrokeColor",
  "frameStrokeWeight",
  "frameOpacity",
  "frameBlendMode",
];
/** A GraphicLine's — stroke-side only (probed: the engine answers
 *  `notImplemented` for FrameFillColor / FrameFillTint / FrameOpacity /
 *  FrameBlendMode on a GraphicLine). */
const LINE_PATHS = ["frameStrokeColor", "frameStrokeWeight"];

const STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 100 },
    { color: "Color/Paper", tint: 60 },
  ],
  strokes: [{ color: "Color/Black", weight: 2 }],
};

const APPEARANCE: GraphicStyleAppearance = {
  stack: STACK,
  base: {
    fill: "Color/Paper",
    fillTint: 60,
    stroke: "Color/Black",
    strokeWeight: 2,
    opacity: 80,
    blendMode: "Multiply",
  },
};

const STYLE: GraphicStyle = {
  id: "gs-1",
  name: "Double stroke",
  appearance: APPEARANCE,
};

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) if (e.path === path) return e.value;
  return undefined;
}

/** Everything a graphic style can touch on a set of elements — the
 *  fingerprint an undo has to restore for a step count to be honest. */
async function signature(
  h: HeadlessHost,
  ids: readonly ElementId[],
): Promise<string> {
  const rows: unknown[] = [];
  for (const id of ids) {
    rows.push([
      await readProp(h, id, "frameFillColor"),
      await readProp(h, id, "frameFillTint"),
      await readProp(h, id, "frameStrokeColor"),
      await readProp(h, id, "frameStrokeWeight"),
      await readProp(h, id, "frameOpacity"),
      await readProp(h, id, "frameBlendMode"),
      await h.host.document.getMetadata(id),
    ]);
  }
  return JSON.stringify(rows);
}

describe("draw conformance — GRAPHIC STYLES (Illustrator Phase 2)", () => {
  // ------------------------------------------------------- pure: library

  describe("the library part (pure)", () => {
    it("round-trips through the part bytes", () => {
      const library: GraphicStyleLibrary = { v: 1, styles: [STYLE] };
      const bytes = serializeGraphicStyleLibrary(library);
      // Indented JSON — the `spec` role exists to stay small and diffable.
      expect(new TextDecoder().decode(bytes)).toContain('\n  "styles": [');
      expect(parseGraphicStyleLibrary(bytes)).toEqual(library);
    });

    it("degrades to an EMPTY library rather than throwing", () => {
      const empty = { v: 1, styles: [] };
      expect(parseGraphicStyleLibrary(null)).toEqual(empty);
      expect(parseGraphicStyleLibrary(new Uint8Array())).toEqual(empty);
      expect(
        parseGraphicStyleLibrary(new TextEncoder().encode("not json{")),
      ).toEqual(empty);
      // A FUTURE library version is not guessed at.
      expect(
        parseGraphicStyleLibrary(
          new TextEncoder().encode('{"v":99,"styles":[{"id":"x"}]}'),
        ),
      ).toEqual(empty);
      // An id-less row is dropped; a name-less one falls back to its id.
      expect(
        parseGraphicStyleLibrary(
          new TextEncoder().encode('{"v":1,"styles":[{},{"id":"gs-4"}]}'),
        ),
      ).toEqual({
        v: 1,
        styles: [
          {
            id: "gs-4",
            name: "gs-4",
            appearance: {
              stack: { fills: [], strokes: [] },
              base: EMPTY_GRAPHIC_STYLE_BASE,
            },
          },
        ],
      });
    });

    it("mints ids deterministically, above the highest existing gs-N", () => {
      expect(mintGraphicStyleId({ v: 1, styles: [] })).toBe("gs-1");
      expect(
        mintGraphicStyleId({
          v: 1,
          styles: [{ ...STYLE, id: "gs-3" }, { ...STYLE, id: "imported" }],
        }),
      ).toBe("gs-4");
    });

    it("upsert / rename / remove are pure and no-op on an unknown id", () => {
      const one: GraphicStyleLibrary = { v: 1, styles: [STYLE] };
      const two = upsertGraphicStyle(one, { ...STYLE, id: "gs-2", name: "B" });
      expect(two.styles.map((s) => s.id)).toEqual(["gs-1", "gs-2"]);
      expect(one.styles).toHaveLength(1); // the input is untouched

      // Upsert REPLACES in place (a redefine keeps the row's position).
      const redefined = upsertGraphicStyle(two, { ...STYLE, name: "renamed" });
      expect(redefined.styles.map((s) => s.name)).toEqual(["renamed", "B"]);

      expect(renameGraphicStyleIn(one, "gs-1", "New").styles[0]!.name).toBe("New");
      expect(renameGraphicStyleIn(one, "nope", "New")).toEqual(one);
      expect(renameGraphicStyleIn(one, "gs-1", "")).toEqual(one);
      expect(removeGraphicStyleFrom(one, "gs-1").styles).toEqual([]);
      expect(removeGraphicStyleFrom(one, "nope")).toEqual(one);
      expect(findGraphicStyle(one, "gs-1")?.name).toBe("Double stroke");
      expect(findGraphicStyle(one, "nope")).toBeNull();
    });
  });

  // ---------------------------------------- pure: projection + the digest

  describe("the kind projection + the override digest (pure)", () => {
    it("nulls the base fields a kind has no slot for", () => {
      const onALine = projectGraphicAppearance(APPEARANCE, LINE_PATHS);
      expect(onALine.base).toEqual({
        fill: null,
        fillTint: null,
        // The style's top STROKE layer still bakes — that half survives.
        stroke: "Color/Black",
        strokeWeight: 2,
        opacity: null,
        blendMode: null,
      });
      // …but the metadata STACK always travels: setPluginMetadata lands on
      // every path-bearing kind, so the layers are not lost, only unpainted.
      expect(onALine.stack).toEqual(STACK);
    });

    it("bakes the front-most layer over the base (what the frame reads back)", () => {
      const odd: GraphicStyleAppearance = {
        stack: { fills: [{ color: "Color/Cyan", tint: 25 }], strokes: [] },
        base: { ...APPEARANCE.base, fill: "Color/Black", fillTint: 100 },
      };
      const projected = projectGraphicAppearance(odd, RECT_PATHS);
      expect(projected.base.fill).toBe("Color/Cyan");
      expect(projected.base.fillTint).toBe(25);
      // No stroke layer ⇒ the base's own stroke stands.
      expect(projected.base.stroke).toBe("Color/Black");
    });

    it("is IDEMPOTENT (the property the whole override check rests on)", () => {
      for (const paths of [RECT_PATHS, LINE_PATHS]) {
        const once = projectGraphicAppearance(APPEARANCE, paths);
        expect(projectGraphicAppearance(once, paths)).toEqual(once);
      }
    });

    it("digests are stable, positional and rounding-tolerant", () => {
      const a = projectGraphicAppearance(APPEARANCE, RECT_PATHS);
      expect(graphicAppearanceDigest(a)).toBe(graphicAppearanceDigest(a));
      expect(graphicAppearanceDigest(a)).toMatch(/^[0-9a-f]{16}$/);
      // 2 vs 2.00000001 pt is the same appearance…
      const near = {
        ...a,
        base: { ...a.base, strokeWeight: 2.00000001 },
      };
      expect(graphicAppearanceDigest(near)).toBe(graphicAppearanceDigest(a));
      // …a reordered stack is NOT (the stack is bottom-to-top).
      const swapped: GraphicStyleAppearance = {
        ...a,
        stack: { fills: [...STACK.fills].reverse(), strokes: STACK.strokes },
      };
      expect(graphicAppearanceDigest(swapped)).not.toBe(
        graphicAppearanceDigest(a),
      );
      // …and neither is a different object opacity.
      expect(
        graphicAppearanceDigest({ ...a, base: { ...a.base, opacity: 79 } }),
      ).not.toBe(graphicAppearanceDigest(a));
      // The canonical form is positional, so a key-order difference in the
      // source object cannot move the digest.
      expect(canonicalGraphicAppearance(a)).toBe(
        canonicalGraphicAppearance(JSON.parse(JSON.stringify(a))),
      );
    });

    it("graphicStyleOverridden compares the live appearance to the stamped rev", () => {
      const projected = projectGraphicAppearance(APPEARANCE, RECT_PATHS);
      const ref = { id: "gs-1", rev: graphicAppearanceDigest(projected) };
      expect(graphicStyleOverridden(ref, projected)).toBe(false);
      expect(
        graphicStyleOverridden(ref, {
          ...projected,
          base: { ...projected.base, opacity: 10 },
        }),
      ).toBe(true);
    });
  });

  // ------------------------------------------------------ pure: the ref

  describe("the element reference (pure)", () => {
    it("reads tolerantly and preserves every other draw key", () => {
      expect(graphicStyleRefOf(null)).toBeNull();
      expect(graphicStyleRefOf({ v: 1, data: {} })).toBeNull();
      expect(graphicStyleRefOf({ v: 1, data: { graphicStyle: { rev: "x" } } })).toBeNull();
      expect(
        graphicStyleRefOf({ v: 1, data: { graphicStyle: { id: "gs-1" } } }),
      ).toEqual({ id: "gs-1", rev: "" });

      const withStack = { v: 1, data: { appearance: STACK } };
      const linked = withGraphicStyleRef(withStack, { id: "gs-1", rev: "ab" });
      expect(linked!.data).toEqual({
        appearance: STACK,
        graphicStyle: { id: "gs-1", rev: "ab" },
      });
      // BREAKING the link keeps the appearance — the whole point.
      const broken = withGraphicStyleRef(linked, null);
      expect(broken!.data).toEqual({ appearance: STACK });
      // …and an envelope that held NOTHING else collapses to null.
      expect(
        withGraphicStyleRef({ v: 1, data: { graphicStyle: { id: "x", rev: "" } } }, null),
      ).toBeNull();
    });
  });

  // -------------------------------------------------- pure: wire builders

  describe("the wire builders (pure — the no-second-copy rule)", () => {
    it("the base ops CLEAR what the style does not carry and skip what the kind lacks", () => {
      const bare = graphicStyleBaseMutations(RECT, EMPTY_GRAPHIC_STYLE_BASE, RECT_PATHS);
      expect(bare).toEqual([
        { op: "setElementProperty", args: { elementId: RECT, path: "frameFillColor", value: { type: "colorRef", value: null } } },
        { op: "setElementProperty", args: { elementId: RECT, path: "frameFillTint", value: { type: "length", value: null } } },
        { op: "setElementProperty", args: { elementId: RECT, path: "frameStrokeColor", value: { type: "colorRef", value: null } } },
        { op: "setElementProperty", args: { elementId: RECT, path: "frameStrokeWeight", value: { type: "length", value: null } } },
        { op: "setElementProperty", args: { elementId: RECT, path: "frameOpacity", value: { type: "length", value: null } } },
        { op: "setElementProperty", args: { elementId: RECT, path: "frameBlendMode", value: { type: "text", value: "" } } },
      ]);
      // On a GraphicLine only the two stroke paths are emitted — an op the
      // kind refuses would roll the whole ATOMIC batch back.
      expect(
        graphicStyleBaseMutations(LINE, APPEARANCE.base, LINE_PATHS).map(
          (m) => (m.op === "setElementProperty" ? m.args.path : m.op),
        ),
      ).toEqual(["frameStrokeColor", "frameStrokeWeight"]);
    });

    it("the apply is ONE batch: base paint → front-most bake → the metadata stamp", () => {
      const batch = applyGraphicStyleBatchFor({
        elementId: RECT,
        style: STYLE,
        supported: RECT_PATHS,
        prev: null,
      });
      expect(batch.op).toBe("batch");
      const ops = batch.op === "batch" ? batch.args.ops : [];
      expect(ops.map((m) => (m.op === "setElementProperty" ? m.args.path : m.op))).toEqual([
        "frameFillColor",
        "frameFillTint",
        "frameStrokeColor",
        "frameStrokeWeight",
        "frameOpacity",
        "frameBlendMode",
        // the front-most-layer bake (the SAME builder the appearance
        // commands use — no second copy)
        "frameFillColor",
        "frameFillTint",
        "frameStrokeColor",
        "frameStrokeWeight",
        "setPluginMetadata",
      ]);
      const stamp = ops.at(-1)!;
      expect(stamp.op).toBe("setPluginMetadata");
      if (stamp.op !== "setPluginMetadata") throw new Error("unreachable");
      expect(stamp.args.key).toBe("x-paged:media.paged.draw");
      expect(stamp.args.caller).toBe("media.paged.draw");
      const envelope = JSON.parse(stamp.args.value as string);
      expect(envelope.data.appearance).toEqual(STACK);
      expect(envelope.data.graphicStyle).toEqual({
        id: "gs-1",
        rev: graphicAppearanceDigest(
          projectGraphicAppearance(APPEARANCE, RECT_PATHS),
        ),
      });
    });

    it("drops the bake ops a kind cannot take, and records what it DID write", () => {
      const batch = applyGraphicStyleBatchFor({
        elementId: LINE,
        style: STYLE,
        supported: LINE_PATHS,
        prev: null,
      });
      const ops = batch.op === "batch" ? batch.args.ops : [];
      expect(ops.map((m) => (m.op === "setElementProperty" ? m.args.path : m.op))).toEqual([
        "frameStrokeColor",
        "frameStrokeWeight",
        "frameStrokeColor",
        "frameStrokeWeight",
        "setPluginMetadata",
      ]);
      const stamp = ops.at(-1)!;
      if (stamp.op !== "setPluginMetadata") throw new Error("unreachable");
      // The stamped rev is the digest of what LANDED, not of the style —
      // so a faithfully-applied line is never falsely "overridden".
      expect(JSON.parse(stamp.args.value as string).data.graphicStyle.rev).toBe(
        graphicAppearanceDigest(projectGraphicAppearance(APPEARANCE, LINE_PATHS)),
      );
    });
  });

  // ------------------------------------------- the honest capability gate

  describe("a host with no `.paged` container writer", () => {
    const warnings: string[] = [];
    const noParts = {
      supports: () => false,
      log: {
        debug: () => {},
        info: () => {},
        warn: (m: string) => void warnings.push(m),
        error: () => {},
      },
      parts: {
        write: async () => {
          throw new Error("must not be reached");
        },
        read: async () => null,
        list: async () => [],
      },
    } as unknown as BundleHost;

    it("degrades with a warn — an empty library and a refused write, never a throw", async () => {
      warnings.length = 0;
      expect(await readGraphicStyleLibrary(noParts)).toEqual({ v: 1, styles: [] });
      expect(await writeGraphicStyleLibrary(noParts, { v: 1, styles: [STYLE] })).toBe(
        false,
      );
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('supports("storage.parts@1") is false');
      expect(warnings[1]).toContain("NOT saved");
    });
  });

  // --------------------------------------------------- against the engine

  describe("against the real engine (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    /** Back to a known state: no metadata anywhere, an empty library. */
    const reset = async () => {
      for (const id of [RECT, POLY, LINE]) {
        await h.host.document.setMetadata(id, null);
      }
      await h.host.parts.write(
        GRAPHIC_STYLES_PART,
        serializeGraphicStyleLibrary({ v: 1, styles: [] }),
      );
      await h.host.selection.set([]);
    };

    /** Give the rectangle a real multi-layer appearance to save from. */
    const seedRect = async () => {
      const prev = await h.host.document.getMetadata(RECT);
      const outcome = await commitAppearance(h.host, RECT, STACK, prev);
      expect(outcome.applied).toBe(true);
    };

    it("registers the six commands + the right-docked panel", () => {
      expect(GRAPHIC_STYLES_COMMAND_IDS).toEqual([
        SAVE_GRAPHIC_STYLE_COMMAND_ID,
        APPLY_GRAPHIC_STYLE_COMMAND_ID,
        REDEFINE_GRAPHIC_STYLE_COMMAND_ID,
        BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID,
        RENAME_GRAPHIC_STYLE_COMMAND_ID,
        DELETE_GRAPHIC_STYLE_COMMAND_ID,
      ]);
      for (const id of GRAPHIC_STYLES_COMMAND_IDS) {
        expect(commandFor(h, id).category).toBe("Graphic Styles");
      }
      const panel = h
        .panelsContributed()
        .find((p) => p.id === GRAPHIC_STYLES_PANEL_ID);
      expect(panel).toBeDefined();
      expect(panel!.title).toBe("Graphic Styles (draw)");
      expect(panel!.defaultDock).toBe("right");
      expect(typeof panel!.component).toBe("function");
    });

    it("the host wires the container parts door this feature rides", () => {
      expect(h.host.supports("storage.parts@1")).toBe(true);
    });

    it("SAVE writes the library part AND links the source", async () => {
      await reset();
      await seedRect();
      await h.host.selection.set([RECT]);

      await commandFor(h, SAVE_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
        name: "Double stroke",
      });

      // (1) the persistence shape — one part, under this plugin's namespace.
      expect(await h.host.parts.list("")).toContain(GRAPHIC_STYLES_PART);
      const library = parseGraphicStyleLibrary(
        await h.host.parts.read(GRAPHIC_STYLES_PART),
      );
      expect(library.v).toBe(1);
      expect(library.styles).toHaveLength(1);
      const style = library.styles[0]!;
      expect(style.id).toBe("gs-1");
      expect(style.name).toBe("Double stroke");
      // A COMPLETE appearance: the stack AND the object-level base paint.
      expect(style.appearance.stack).toEqual(STACK);
      expect(style.appearance.base.fill).toBe("Color/Paper");
      expect(style.appearance.base.fillTint).toBe(60);
      expect(style.appearance.base.stroke).toBe("Color/Black");
      expect(style.appearance.base.strokeWeight).toBe(2);

      // (2) the source is LINKED and in sync (no phantom override).
      const read = await readGraphicAppearance(h.host, RECT);
      const ref = graphicStyleRefOf(read.envelope);
      expect(ref?.id).toBe("gs-1");
      expect(graphicStyleOverridden(ref!, read.appearance)).toBe(false);
    });

    it("APPLY lands base + stack + link on another element in ONE undo step", async () => {
      const before = await signature(h, [POLY]);
      await h.host.selection.set([POLY]);
      await commandFor(h, APPLY_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
        styleId: "gs-1",
      });

      // The document really moved…
      expect(await readProp(h, POLY, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
      expect(await readProp(h, POLY, "frameFillTint")).toEqual({
        type: "length",
        value: 60,
      });
      expect(await readProp(h, POLY, "frameStrokeColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      expect(await readProp(h, POLY, "frameStrokeWeight")).toEqual({
        type: "length",
        value: 2,
      });
      const read = await readGraphicAppearance(h.host, POLY);
      expect(read.appearance.stack).toEqual(STACK);
      const ref = graphicStyleRefOf(read.envelope)!;
      expect(ref.id).toBe("gs-1");
      expect(graphicStyleOverridden(ref, read.appearance)).toBe(false);
      expect(await signature(h, [POLY])).not.toBe(before);

      // …and ONE undo puts every one of those writes back (RFI C-15: the
      // count is MEASURED — one batch, one step).
      await h.host.document.undo();
      expect(await signature(h, [POLY])).toBe(before);

      // Re-apply so the following tests have two linked elements.
      await commandFor(h, APPLY_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
        styleId: "gs-1",
      });
      expect((await graphicStyleLinks(h.host, "gs-1")).map((l) => l.id.id).sort()).toEqual(
        [POLY.id, RECT.id].sort(),
      );
    });

    it("a DIRECT appearance edit keeps the link and marks the element OVERRIDDEN", async () => {
      // The pinned decision: editing does NOT unlink. Nothing is written
      // by the edit that knows about graphic styles — the appearance
      // commands' own applier is used here, exactly as the panel would.
      const prev = await h.host.document.getMetadata(POLY);
      await commitAppearance(
        h.host,
        POLY,
        { fills: [{ color: "Color/Black", tint: 10 }], strokes: [] },
        prev,
      );

      const read = await readGraphicAppearance(h.host, POLY);
      const ref = graphicStyleRefOf(read.envelope);
      expect(ref?.id).toBe("gs-1"); // STILL LINKED
      expect(graphicStyleOverridden(ref!, read.appearance)).toBe(true);
      // …and the link listing agrees.
      const links = await graphicStyleLinks(h.host, "gs-1");
      expect(links.find((l) => l.id.id === POLY.id)!.overridden).toBe(true);
      expect(links.find((l) => l.id.id === RECT.id)!.overridden).toBe(false);
    });

    it("REDEFINE propagates to every linked element — overrides INCLUDED", async () => {
      // Redefine from the rectangle after changing it: a single stroke.
      const prev = await h.host.document.getMetadata(RECT);
      await commitAppearance(
        h.host,
        RECT,
        { fills: [], strokes: [{ color: "Color/Paper", weight: 5 }] },
        prev,
      );
      await h.host.selection.set([RECT]);
      await commandFor(h, REDEFINE_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
        styleId: "gs-1",
      });

      // The library carries the new definition under the SAME id + name.
      const library = parseGraphicStyleLibrary(
        await h.host.parts.read(GRAPHIC_STYLES_PART),
      );
      expect(library.styles).toHaveLength(1);
      expect(library.styles[0]!.name).toBe("Double stroke");
      expect(library.styles[0]!.appearance.stack).toEqual({
        fills: [],
        strokes: [{ color: "Color/Paper", weight: 5 }],
      });

      // The OVERRIDDEN polygon followed anyway — that is what "linked"
      // means here, and breaking the link is the way to keep a deviation.
      const read = await readGraphicAppearance(h.host, POLY);
      expect(read.appearance.stack).toEqual({
        fills: [],
        strokes: [{ color: "Color/Paper", weight: 5 }],
      });
      expect(await readProp(h, POLY, "frameStrokeWeight")).toEqual({
        type: "length",
        value: 5,
      });
      const links = await graphicStyleLinks(h.host, "gs-1");
      expect(links).toHaveLength(2);
      expect(links.every((l) => !l.overridden)).toBe(true);
    });

    it("BREAK LINK drops the reference, keeps the appearance — ONE undo step", async () => {
      const stackBefore = appearanceOf(await h.host.document.getMetadata(POLY));
      const paintBefore = await readProp(h, POLY, "frameStrokeWeight");
      const before = await signature(h, [POLY]);

      await h.host.selection.set([POLY]);
      await commandFor(h, BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID).handler(undefined);

      const env = await h.host.document.getMetadata(POLY);
      expect(graphicStyleRefOf(env)).toBeNull();
      expect(appearanceOf(env)).toEqual(stackBefore);
      expect(await readProp(h, POLY, "frameStrokeWeight")).toEqual(paintBefore);
      expect(await signature(h, [POLY])).not.toBe(before);

      await h.host.document.undo();
      expect(await signature(h, [POLY])).toBe(before);

      // Break it again and leave it broken for the delete test below.
      await commandFor(h, BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID).handler(undefined);
      expect(await graphicStyleLinks(h.host, "gs-1")).toHaveLength(1);
    });

    it("RENAME is library-only — no document mutation at all", async () => {
      const before = await signature(h, [RECT, POLY, LINE]);
      expect(await applyRenameGraphicStyle(h.host, "gs-1", "  Heavy rule  ")).toBe(
        true,
      );
      const library = parseGraphicStyleLibrary(
        await h.host.parts.read(GRAPHIC_STYLES_PART),
      );
      expect(library.styles[0]!.name).toBe("Heavy rule");
      // The element reference stores the ID and nothing else, so a rename
      // never walks the document — and nothing became undoable.
      expect(await signature(h, [RECT, POLY, LINE])).toBe(before);
      expect(graphicStyleRefOf(await h.host.document.getMetadata(RECT))?.id).toBe(
        "gs-1",
      );
      // An unknown id / an empty name refuse rather than corrupt.
      expect(await applyRenameGraphicStyle(h.host, "nope", "x")).toBe(false);
      expect(await applyRenameGraphicStyle(h.host, "gs-1", "   ")).toBe(false);
    });

    it("the LIBRARY is NOT on the undo stack (a container write is no mutation)", async () => {
      // Probed, not assumed: mutate, then write the part, then undo — the
      // undo unwinds the MUTATION and leaves the part exactly as written.
      const beforeStack = appearanceOf(await h.host.document.getMetadata(RECT));
      await h.host.document.setMetadata(RECT, null);
      await writeGraphicStyleLibrary(h.host, {
        v: 1,
        styles: [{ ...STYLE, id: "gs-9", name: "probe" }],
      });
      await h.host.document.undo();

      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual(
        beforeStack,
      );
      const library = parseGraphicStyleLibrary(
        await h.host.parts.read(GRAPHIC_STYLES_PART),
      );
      expect(library.styles.map((s) => s.id)).toEqual(["gs-9"]);
    });

    it("DELETE unlinks every follower first, then drops the style", async () => {
      await reset();
      await seedRect();
      await h.host.selection.set([RECT]);
      await applySaveGraphicStyle(h.host, { name: "Doomed" });
      await h.host.selection.set([POLY]);
      await applyGraphicStyleToSelection(h.host, "gs-1");
      expect(await graphicStyleLinks(h.host, "gs-1")).toHaveLength(2);

      const stackBefore = appearanceOf(await h.host.document.getMetadata(POLY));
      await commandFor(h, DELETE_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
        styleId: "gs-1",
      });

      expect(
        parseGraphicStyleLibrary(await h.host.parts.read(GRAPHIC_STYLES_PART))
          .styles,
      ).toEqual([]);
      // No element is left pointing at a style that is gone…
      expect(await graphicStyleLinks(h.host)).toEqual([]);
      // …and every appearance survives the unlink.
      expect(appearanceOf(await h.host.document.getMetadata(POLY))).toEqual(
        stackBefore,
      );
    });

    it("applies the reachable half of a style to a GraphicLine and stays in sync", async () => {
      await reset();
      await seedRect();
      await h.host.selection.set([RECT]);
      await applySaveGraphicStyle(h.host, { name: "Fills + a rule" });

      await h.host.selection.set([LINE]);
      await applyGraphicStyleToSelection(h.host, "gs-1");

      // The stroke half landed…
      expect(await readProp(h, LINE, "frameStrokeColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      expect(await readProp(h, LINE, "frameStrokeWeight")).toEqual({
        type: "length",
        value: 2,
      });
      // …the fill half is not even addressable on this kind…
      const read = await readGraphicAppearance(h.host, LINE);
      expect(read.supported).not.toContain("frameFillColor");
      // …the metadata stack travelled whole regardless…
      expect(read.appearance.stack).toEqual(STACK);
      // …and the link records what was WRITTEN, so the line is linked and
      // NOT falsely reported as overridden.
      const ref = graphicStyleRefOf(read.envelope)!;
      expect(ref.id).toBe("gs-1");
      expect(graphicStyleOverridden(ref, read.appearance)).toBe(false);
    });

    it("refuses a BAKED appearance instead of putting the model and the page out of step", async () => {
      await reset();
      await seedRect();
      // Bake the rectangle's stack into the B-24 group of derived paths.
      const baked = await commandFor(h, "media.paged.draw.command.bakeAppearance");
      await h.host.selection.set([RECT]);
      await baked.handler(undefined);
      const env = await h.host.document.getMetadata(RECT);
      expect(graphicStyleRefusalOf(env)).toBe("baked");

      // Save refuses, so the library stays empty…
      expect(await applySaveGraphicStyle(h.host, { name: "nope" })).toBeNull();
      expect(
        parseGraphicStyleLibrary(await h.host.parts.read(GRAPHIC_STYLES_PART))
          .styles,
      ).toEqual([]);

      // …and so does an apply of a style saved from somewhere else.
      await h.host.selection.set([POLY]);
      await applySaveGraphicStyle(h.host, { name: "from the polygon" });
      const before = await signature(h, [RECT]);
      await h.host.selection.set([RECT]);
      await applyGraphicStyleToSelection(h.host, "gs-1");
      expect(await signature(h, [RECT])).toBe(before);
      expect(graphicStyleRefOf(await h.host.document.getMetadata(RECT))).toBeNull();

      // Release, and the same apply now lands.
      await commandFor(h, "media.paged.draw.command.releaseAppearance").handler(
        undefined,
      );
      await applyGraphicStyleToSelection(h.host, "gs-1");
      expect(graphicStyleRefOf(await h.host.document.getMetadata(RECT))?.id).toBe(
        "gs-1",
      );
    });

    it("refuses honestly on an empty selection / an unknown style", async () => {
      await reset();
      await h.host.selection.set([]);
      await expect(
        commandFor(h, SAVE_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {}),
      ).resolves.toBeUndefined();
      await expect(
        commandFor(h, APPLY_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {
          styleId: "gs-404",
        }),
      ).resolves.toBeUndefined();
      await expect(
        commandFor(h, REDEFINE_GRAPHIC_STYLE_COMMAND_ID).handler(undefined, {}),
      ).resolves.toBeUndefined();
      await expect(
        commandFor(h, BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID).handler(undefined),
      ).resolves.toBeUndefined();
      await expect(
        applyBreakGraphicStyleLink(h.host),
      ).resolves.toBeUndefined();
      expect(await applyDeleteGraphicStyle(h.host, "gs-404")).toBe(false);
      expect(await applyRedefineGraphicStyle(h.host, "gs-404")).toBeNull();
      expect(await graphicStyleLinks(h.host)).toEqual([]);
    });
  });

  // ------------------------------------------------------------ the panel

  describe("the panel surface", () => {
    it("the row label names the paints and the blast radius of a redefine", () => {
      expect(graphicStyleRowLabel(STYLE, 3)).toBe("2 fills · 1 stroke · 3 linked");
      expect(
        graphicStyleRowLabel(
          {
            ...STYLE,
            appearance: { ...APPEARANCE, stack: { fills: [], strokes: [] } },
          },
          1,
        ),
      ).toBe("base paint only · 1 linked");
    });

    it("the inline note NAMES the link semantics and every honest limit", () => {
      // The feature's substance: link, redefine, break.
      expect(GRAPHIC_STYLES_NOTE).toContain("COMPLETE appearance");
      expect(GRAPHIC_STYLES_NOTE).toContain("LINKS the object to it");
      expect(GRAPHIC_STYLES_NOTE).toContain(
        "propagates to every linked object",
      );
      // The OVERRIDE decision, stated where the author can read it.
      expect(GRAPHIC_STYLES_NOTE).toContain("does NOT break the link");
      expect(GRAPHIC_STYLES_NOTE).toContain("OVERRIDDEN");
      expect(GRAPHIC_STYLES_NOTE).toContain("Redefine overwrites that override");
      // Where the library lives — and that it is outside the undo stack.
      expect(GRAPHIC_STYLES_NOTE).toContain(
        "paged/media.paged.draw/graphic-styles.json",
      );
      expect(GRAPHIC_STYLES_NOTE).toContain("NOT UNDOABLE");
      // The limits that are real and must not quietly disappear.
      expect(GRAPHIC_STYLES_NOTE).toContain("graphic line has no");
      expect(GRAPHIC_STYLES_NOTE).toContain("BAKED appearance is refused");
      expect(GRAPHIC_STYLES_NOTE).toContain(
        "merge, import, export, preview and folder organisation are not built",
      );
    });
  });
});
