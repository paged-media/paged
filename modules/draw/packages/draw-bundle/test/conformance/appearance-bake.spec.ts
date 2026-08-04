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

// GAP B-24 — the GROUP BAKE, through the REAL engine wasm the harness
// boots (protocol 57). Pins:
//   (1) the pure plan: paint order (fills bottom-to-top, then strokes),
//       the exact insert / paint / release wire shapes, and the ONE-paint
//       rule for a derived layer — one colour per layer, plus the
//       modifiers that paint carries (tint, opacity, blend mode), which
//       C-20 made writable on a derived Polygon;
//   (2) the document SHAPE a bake produces — a group whose members are
//       the CARRIER (the source frame, paint cleared, metadata intact)
//       followed by one derived path per paint layer, back-to-front,
//       every one of them carrying the source geometry;
//   (3) the real MUTATION/UNDO count: TWO batches, so exactly two undos
//       return the document to its pre-bake state (RFI C-15 — assert the
//       count, never claim "one undo");
//   (4) release restores a single frame + the metadata stack + the
//       front-most-layer bake, and bake→release→bake is stable;
//   (5) an edit on a BAKED stack re-bakes (the derived paths follow the
//       model instead of silently diverging from it);
//   (6) EXPORT, through the real engine:
//         · PDF — the baked stack paints into the page content stream in
//           order (the bake's whole point: every layer renders);
//         · IDML — the bake SURVIVES a save (C-19: the writer emits a
//           scene-created group as a real `<Group>`, members nested and
//           re-based, in z-table order). Asserted end to end: the group
//           wrapper, the carrier moved inside it with its metadata
//           envelope, every derived layer, and each layer's paint +
//           tint + opacity + blend mode. The one z-fact that is STILL
//           true is pinned as such: an inserted item emits at the
//           spread's close, so the group reopens ABOVE the source items
//           rather than in the carrier's canvas z-slot;
//         · IDML after RELEASE — the front-most layer on a single frame,
//           unchanged by the C-19 work.

import { inflateSync } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceOf,
  appearanceBakeOf,
  appearanceLayerOf,
  appearanceBakeLayers,
  bakeAppearance,
  bakeGeometryOf,
  bakeInsertBatchFor,
  bakeLayerPaintFor,
  bakePaintBatchFor,
  commitAppearance,
  releaseAppearance,
  releaseBatchFor,
  resolveAppearanceCarrier,
  withAppearanceBake,
  APPEARANCE_BAKE_COMMAND_ID,
  APPEARANCE_RELEASE_COMMAND_ID,
  APPEARANCE_REMOVE_LAYER_COMMAND_ID,
  DRAW_METADATA_KEY,
  type AppearanceStack,
  type BakeLayer,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = {
  kind: "rectangle",
  id: F1_MULTI_SHAPE.ids.rectangle!,
} as ElementId;

/** Two fills + one stroke — the canonical 3-layer stack. */
const STACK: AppearanceStack = {
  fills: [{ color: "Color/Black" }, { color: "Color/Paper" }],
  strokes: [{ color: "Color/Black", weight: 2 }],
};

/** The same stack wearing every per-layer MODIFIER the lowering now
 *  carries: a tinted + multiplied bottom fill and a half-transparent
 *  stroke (C-19 / C-20). */
const MODIFIED_STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 40, blendMode: "Multiply" },
    { color: "Color/Paper" },
  ],
  strokes: [{ color: "Color/Black", weight: 2, opacity: 55 }],
};

/** The F1 rectangle is BOUNDS-ONLY (an IDML `<Rectangle>` exposes no
 *  anchor table), so the bake copies its four corners as a closed
 *  contour — GeometricBounds "100 100 300 300" ⇒ [top,left,bottom,right]. */
const RECT_CORNERS: [number, number][] = [
  [100, 100],
  [300, 100],
  [300, 300],
  [100, 300],
];

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leafIds(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length > 0) walk(children);
      else if (node.id && typeof node.id.id === "string") out.push(node.id.id);
    }
  };
  walk(await h.host.document.tree());
  return out;
}

/** The one group node in the tree (or null) plus its member ids in tree
 *  (= paint) order. */
async function groupShape(
  h: HeadlessHost,
): Promise<{ id: string; members: string[] } | null> {
  let found: { id: string; members: string[] } | null = null;
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      if (node.id && node.id.kind === "group" && typeof node.id.id === "string") {
        found = {
          id: node.id.id,
          members: (node.children ?? [])
            .map((c) => c.id?.id)
            .filter((id): id is string => typeof id === "string"),
        };
        return;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(await h.host.document.tree());
  return found;
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path) return e.value;
  }
  return undefined;
}

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

// ------------------------------------------------------- export helpers
// Both ride `host.editor.client` — the MARKED escape hatch (DESIGN.md
// §4.9). A conformance spec may use it to reach an engine query the
// plugin contract does not expose (export); the bundle's own source
// never does.

/** The page-1 PDF content stream, inflated. */
async function pdfContentStream(h: HeadlessHost): Promise<string> {
  const client = (h.host as unknown as { editor: { client: PdfClient } }).editor
    .client;
  const begun = await client.send({
    kind: "exportPdfBegin",
    payload: { options: {} },
  });
  const session = begun.payload.session as number;
  const pages = begun.payload.pageCount as number;
  for (let i = 0; i < pages; i++) {
    await client.send({ kind: "exportPdfPage", payload: { session } });
  }
  const fin = await client.send({
    kind: "exportPdfFinish",
    payload: { session },
  });
  const bytes = new Uint8Array(fin.payload.pdfBytes as number[]);
  const text = new TextDecoder("latin1").decode(bytes);
  const length = Number(/\/Length (\d+)/.exec(text)![1]);
  const start = text.indexOf("stream\n") + "stream\n".length;
  return new TextDecoder("latin1").decode(
    inflateSync(bytes.subarray(start, start + length)),
  );
}

interface PdfClient {
  send(m: { kind: string; payload: unknown }): Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

/** One `q … Q` paint block of a PDF content stream. */
interface PaintBlock {
  fill: string | null;
  stroke: string | null;
  width: string | null;
  op: "f" | "S" | null;
}

function paintBlocks(stream: string): PaintBlock[] {
  return stream
    .split(/\nq\n/)
    .slice(1)
    .map((block) => ({
      fill: /^([\d.]+ [\d.]+ [\d.]+) rg$/m.exec(block)?.[1] ?? null,
      stroke: /^([\d.]+ [\d.]+ [\d.]+) RG$/m.exec(block)?.[1] ?? null,
      width: /^([\d.]+) w$/m.exec(block)?.[1] ?? null,
      op: (/^([fS])$/m.exec(block)?.[1] as "f" | "S" | undefined) ?? null,
    }))
    .filter((b) => b.op !== null);
}

/** Export the document to IDML and re-open it in a fresh engine — the
 *  honest "does it survive a save" question. */
async function reopenViaIdml(h: HeadlessHost): Promise<HeadlessHost> {
  const client = (h.host as unknown as { editor: { client: PdfClient } }).editor
    .client;
  const reply = await client.send({ kind: "exportIdml", payload: {} });
  expect(reply.kind).toBe("idmlExported");
  const bytes = new Uint8Array(reply.payload.idmlBytes as number[]);
  const reopened = await openHost();
  await reopened.load(bytes);
  reopened.loadBundle(drawBundle);
  return reopened;
}

describe("draw conformance — the appearance GROUP BAKE (gap B-24)", () => {
  describe("the pure plan", () => {
    it("flattens the stack to PAINT ORDER: fills bottom-to-top, then strokes", () => {
      expect(appearanceBakeLayers(STACK)).toEqual([
        { kind: "fill", index: 0, color: "Color/Black" },
        { kind: "fill", index: 1, color: "Color/Paper" },
        { kind: "stroke", index: 0, color: "Color/Black", weight: 2 },
      ]);
      expect(appearanceBakeLayers({ fills: [], strokes: [] })).toEqual([]);
    });

    it("bakeInsertBatchFor emits ONE batch of N identical insertPath ops", () => {
      const geometry = {
        pageId: "usp",
        anchors: RECT_CORNERS.map((c) => ({ anchor: c, left: c, right: c })),
        open: false,
      };
      const batch = bakeInsertBatchFor(geometry, 2) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(batch.op).toBe("batch");
      expect(batch.args.ops).toHaveLength(2);
      expect(batch.args.ops[0]).toEqual({
        op: "insertPath",
        args: { pageId: "usp", anchors: geometry.anchors, open: false },
      });
      // Both copies are the SAME contour — that is the whole point.
      expect(batch.args.ops[0]).toEqual(batch.args.ops[1]);
    });

    it("a derived layer carries exactly ONE paint, with its modifiers", () => {
      // ONE paint per layer is the whole lowering: a fill layer clears
      // its stroke and vice versa. The MODIFIERS that paint carries —
      // tint, opacity, blend mode — ride along; C-20 gave `FrameFillTint`
      // and `FrameBlendMode` Polygon arms, so withholding them would be
      // the fiction now.
      const fill: BakeLayer = {
        kind: "fill",
        index: 0,
        color: "Color/Paper",
        tint: 40,
        opacity: 60,
        blendMode: "Multiply",
      };
      expect(bakeLayerPaintFor(poly("u1"), fill)).toEqual([
        {
          op: "setElementProperty",
          args: {
            elementId: poly("u1"),
            path: "frameFillColor",
            value: { type: "colorRef", value: "Color/Paper" },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: poly("u1"),
            path: "frameStrokeColor",
            value: { type: "colorRef", value: null },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: poly("u1"),
            path: "frameFillTint",
            value: { type: "length", value: 40 },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: poly("u1"),
            path: "frameOpacity",
            value: { type: "length", value: 60 },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: poly("u1"),
            path: "frameBlendMode",
            value: { type: "text", value: "Multiply" },
          },
        },
      ]);
      // A layer with no modifiers emits none of them — the plan stays
      // minimal, and a stroke layer never gets a fill tint (there is no
      // stroke-side tint on the wire).
      const stroke: BakeLayer = {
        kind: "stroke",
        index: 0,
        color: "Color/Black",
        weight: 3,
      };
      expect(
        bakeLayerPaintFor(poly("u2"), stroke).map(
          (m) => (m as { args: { path: string } }).args.path,
        ),
      ).toEqual(["frameFillColor", "frameStrokeColor", "frameStrokeWeight"]);
      expect(
        bakeLayerPaintFor(poly("u3"), {
          kind: "stroke",
          index: 0,
          color: "Color/Black",
          weight: 3,
          blendMode: "Screen",
        }).map((m) => (m as { args: { path: string } }).args.path),
      ).toEqual([
        "frameFillColor",
        "frameStrokeColor",
        "frameStrokeWeight",
        "frameBlendMode",
      ]);
      expect(
        bakeLayerPaintFor(poly("u4"), {
          kind: "fill",
          index: 0,
          color: "Color/Black",
        }).map((m) => (m as { args: { path: string } }).args.path),
      ).toEqual(["frameFillColor", "frameStrokeColor"]);
    });

    it("bakePaintBatchFor closes with the carrier clear + envelope + createGroup", () => {
      const batch = bakePaintBatchFor({
        carrier: RECT,
        created: [poly("u1")],
        layers: [{ kind: "fill", index: 0, color: "Color/Black" }],
        carrierEnvelope: { v: 1, data: { appearance: STACK } },
      }) as Extract<Mutation, { op: "batch" }>;
      const ops = batch.args.ops;
      // …2 paints + the layer marker, then the carrier's two clears, its
      // envelope, and the group.
      expect(ops).toHaveLength(7);
      expect(ops[2]).toEqual({
        op: "setPluginMetadata",
        args: {
          elementId: poly("u1"),
          key: DRAW_METADATA_KEY,
          value: JSON.stringify({
            v: 1,
            data: {
              appearanceLayer: { of: RECT, kind: "fill", index: 0 },
            },
          }),
          caller: "media.paged.draw",
        },
      });
      expect(ops[3]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameFillColor",
          value: { type: "colorRef", value: null },
        },
      });
      expect(ops[6]).toEqual({
        op: "createGroup",
        args: { memberIds: [RECT, poly("u1")] },
      });
    });

    it("releaseBatchFor dissolves, deletes, restores and un-stamps in ONE batch", () => {
      const batch = releaseBatchFor({
        carrier: RECT,
        group: { kind: "group", id: "u9" } as ElementId,
        layers: ["u1", "u2"],
        record: {
          layers: ["u1", "u2"],
          restore: { fill: "Color/Black", stroke: null, weight: null },
        },
        stack: STACK,
        carrierEnvelope: { v: 1, data: { appearance: STACK } },
      }) as Extract<Mutation, { op: "batch" }>;
      const kinds = batch.args.ops.map((m) => (m as { op: string }).op);
      expect(kinds[0]).toBe("dissolveGroup");
      expect(kinds.slice(1, 3)).toEqual(["deleteFrame", "deleteFrame"]);
      expect(kinds.at(-1)).toBe("setPluginMetadata");
      // The restore is followed by the front-most-layer bake (Paper fill
      // + the 2pt Black stroke) — a released object looks exactly like
      // the pre-B-24 top-layer bake.
      const paths = batch.args.ops
        .filter((m) => (m as { op: string }).op === "setElementProperty")
        .map((m) => (m as { args: { path: string } }).args.path);
      expect(paths).toEqual([
        "frameFillColor",
        "frameStrokeColor",
        "frameFillColor",
        "frameStrokeColor",
        "frameStrokeWeight",
      ]);
    });

    it("a COMPOUND source is REFUSED, never silently flattened", async () => {
      // `insertPath` carries ONE contour and ONE open flag, so a
      // multi-subpath source cannot be copied faithfully. The refusal is
      // the honest answer (the blend.ts structure-mismatch precedent).
      const compound = {
        document: {
          pathAnchors: async () => ({
            id: RECT,
            pageId: "usp",
            anchors: RECT_CORNERS.concat(RECT_CORNERS).map((c) => ({
              anchor: c,
              left: c,
              right: c,
            })),
            subpathStarts: [0, 4],
            subpathOpen: [false, false],
            itemTransform: null,
          }),
          elementGeometry: async () => [],
        },
      } as unknown as Parameters<typeof bakeGeometryOf>[0];
      expect(await bakeGeometryOf(compound, RECT)).toEqual({
        refusal: "compound-path",
      });

      const blind = {
        document: {
          pathAnchors: async () => null,
          elementGeometry: async () => [],
        },
      } as unknown as Parameters<typeof bakeGeometryOf>[0];
      expect(await bakeGeometryOf(blind, RECT)).toEqual({
        refusal: "no-geometry",
      });
    });

    it("the bake record round-trips through the envelope, preserving other keys", () => {
      const prev = { v: 1, data: { tool: "addAnchor", appearance: STACK } };
      const record = {
        layers: ["u1"],
        restore: { fill: "Color/Black", stroke: null, weight: null },
      };
      const next = withAppearanceBake(prev, record)!;
      expect(next.data.tool).toBe("addAnchor");
      expect(appearanceBakeOf(next)).toEqual(record);
      expect(appearanceOf(next)).toEqual(STACK);
      expect(appearanceBakeOf(withAppearanceBake(next, null))).toBeNull();
      expect(appearanceBakeOf(null)).toBeNull();
      expect(appearanceBakeOf({ v: 1, data: { appearanceBake: 7 } })).toBeNull();
    });
  });

  describe("against the real engine (F1 rectangle)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    /** Seed the carrier with the 3-layer stack (unbaked). */
    const seed = async () => {
      const prev = await h.host.document.getMetadata(RECT);
      await commitAppearance(h.host, RECT, STACK, prev);
    };

    it("BAKE — a group of carrier + one derived path per layer, back-to-front", async () => {
      await seed();
      const before = await leafIds(h);
      expect(await groupShape(h)).toBeNull();

      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);

      // The document shape: ONE group, members = carrier then the three
      // derived paths in paint order.
      const group = await groupShape(h);
      expect(group).not.toBeNull();
      expect(group!.members).toEqual([
        RECT.id,
        ...created.map((c) => c.id as string),
      ]);
      expect(await leafIds(h)).toHaveLength(before.length + 3);
      // The group lands in the CARRIER's z-slot, so the object does not
      // jump above its neighbours when it is baked.
      const roots = await h.host.document.tree();
      const page = roots[0].children![0];
      expect(page.children!.map((c) => c.id!.id)).toEqual([
        group!.id,
        F1_MULTI_SHAPE.ids.polygon,
        F1_MULTI_SHAPE.ids.graphicLine,
      ]);

      // Each derived path carries the SOURCE geometry (the rectangle's
      // four corners, closed) …
      for (const id of created) {
        const table = await h.host.document.pathAnchors(id);
        expect(table).not.toBeNull();
        expect(table!.anchors.map((a) => a.anchor)).toEqual(RECT_CORNERS);
        expect(table!.subpathOpen?.[0]).toBe(false);
      }
      // … and EXACTLY ONE paint, in stack order.
      expect(await readProp(h, created[0], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      expect(await readProp(h, created[0], "frameStrokeColor")).toEqual({
        type: "colorRef",
        value: null,
      });
      expect(await readProp(h, created[1], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
      expect(await readProp(h, created[2], "frameFillColor")).toEqual({
        type: "colorRef",
        value: null,
      });
      expect(await readProp(h, created[2], "frameStrokeColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });
      expect(await readProp(h, created[2], "frameStrokeWeight")).toEqual({
        type: "length",
        value: 2,
      });

      // The CARRIER paints nothing now, keeps the editable stack, and
      // carries the bake record naming its layers.
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: null,
      });
      const env = await h.host.document.getMetadata(RECT);
      expect(appearanceOf(env)).toEqual(STACK);
      expect(appearanceBakeOf(env)!.layers).toEqual(
        created.map((c) => c.id as string),
      );
      // The pre-bake paint is remembered for the release.
      expect(appearanceBakeOf(env)!.restore.fill).toBe("Color/Paper");

      // A derived layer resolves back to its carrier (so selecting one
      // inside the group still edits the stack).
      expect(
        appearanceLayerOf(await h.host.document.getMetadata(created[0]))!.of,
      ).toEqual(RECT);
      expect(await resolveAppearanceCarrier(h.host, created[0])).toEqual(RECT);
      expect(
        await resolveAppearanceCarrier(h.host, {
          kind: "group",
          id: group!.id,
        } as ElementId),
      ).toEqual(RECT);
    });

    it("UNDO — the bake is exactly TWO batches (C-15: assert, never claim one)", async () => {
      // Fresh state: release whatever the previous test left baked.
      await releaseAppearance(h.host, RECT);
      const before = await leafIds(h);

      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);

      // Undo #1 unwinds the paint/metadata/group batch: the group is
      // gone, the three inserted paths are still there.
      await h.host.document.undo();
      expect(await groupShape(h)).toBeNull();
      expect(await leafIds(h)).toHaveLength(before.length + 3);

      // Undo #2 unwinds the insert batch: back to the pre-bake document.
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(before);
      expect(appearanceBakeOf(await h.host.document.getMetadata(RECT))).toBeNull();
      // The carrier's own paint is back (the front-most-layer bake).
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
    });

    it("RELEASE — back to a single frame with the stack + the front-most layer", async () => {
      const before = await leafIds(h);
      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);

      expect(await releaseAppearance(h.host, RECT)).toBe(true);

      expect(await groupShape(h)).toBeNull();
      expect(await leafIds(h)).toEqual(before);
      const env = await h.host.document.getMetadata(RECT);
      expect(appearanceOf(env)).toEqual(STACK);
      expect(appearanceBakeOf(env)).toBeNull();
      // The front-most fill + stroke sit on the frame again — exactly
      // the pre-B-24 behaviour the note describes.
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
      expect(await readProp(h, RECT, "frameStrokeWeight")).toEqual({
        type: "length",
        value: 2,
      });
      // Releasing something that is not baked is an honest no-op.
      expect(await releaseAppearance(h.host, RECT)).toBe(false);
    });

    it("bake → release → bake is STABLE (same shape, same paints)", async () => {
      const first = await bakeAppearance(h.host, RECT);
      const firstShape = await groupShape(h);
      await releaseAppearance(h.host, RECT);
      const second = await bakeAppearance(h.host, RECT);
      const secondShape = await groupShape(h);

      expect(second).toHaveLength(first.length);
      expect(secondShape!.members).toHaveLength(firstShape!.members.length);
      expect(secondShape!.members[0]).toBe(RECT.id);
      expect(await readProp(h, second[1], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual(
        STACK,
      );
      await releaseAppearance(h.host, RECT);
    });

    it("an EDIT on a baked stack RE-BAKES (the page follows the model)", async () => {
      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);
      await h.host.selection.set([RECT]);

      // Remove the front-most fill through the panel's own command.
      await commandFor(h, APPEARANCE_REMOVE_LAYER_COMMAND_ID).handler(
        undefined,
        { kind: "fill", index: 1 },
      );

      const env = await h.host.document.getMetadata(RECT);
      expect(appearanceOf(env).fills).toEqual([{ color: "Color/Black" }]);
      // Still baked — and with ONE FEWER derived path, rebuilt from the
      // new stack (not the stale one).
      const record = appearanceBakeOf(env);
      expect(record).not.toBeNull();
      expect(record!.layers).toHaveLength(2);
      const group = await groupShape(h);
      expect(group!.members).toEqual([RECT.id, ...record!.layers]);
      expect(await readProp(h, poly(record!.layers[0]), "frameFillColor")).toEqual(
        { type: "colorRef", value: "Color/Black" },
      );
      expect(
        await readProp(h, poly(record!.layers[1]), "frameStrokeColor"),
      ).toEqual({ type: "colorRef", value: "Color/Black" });

      // Restore the fixture for the export tests below.
      await releaseAppearance(h.host, RECT);
      const prev = await h.host.document.getMetadata(RECT);
      await commitAppearance(h.host, RECT, STACK, prev);
    });

    it("REFUSALS are honest no-ops (empty stack, already baked)", async () => {
      // Nothing to bake on an element with no stack.
      const line = {
        kind: "graphicLine",
        id: F1_MULTI_SHAPE.ids.graphicLine!,
      } as ElementId;
      expect(await bakeAppearance(h.host, line)).toEqual([]);
      expect(await groupShape(h)).toBeNull();

      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);
      // A second bake refuses rather than stacking a bake on a bake.
      expect(await bakeAppearance(h.host, RECT)).toEqual([]);
      const group = await groupShape(h);
      expect(group!.members).toHaveLength(4);
      await releaseAppearance(h.host, RECT);
    });

    it("the COMMANDS drive the same appliers (bake / release by id)", async () => {
      await h.host.selection.set([RECT]);
      await commandFor(h, APPEARANCE_BAKE_COMMAND_ID).handler(undefined);
      expect((await groupShape(h))!.members).toHaveLength(4);

      // Select the GROUP — the release command resolves it to the carrier.
      const group = await groupShape(h);
      await h.host.selection.set([
        { kind: "group", id: group!.id } as ElementId,
      ]);
      await commandFor(h, APPEARANCE_RELEASE_COMMAND_ID).handler(undefined);
      expect(await groupShape(h)).toBeNull();
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual(
        STACK,
      );
      await h.host.selection.set([]);
    });

    it("EXPORT (PDF) — every baked layer paints, in stack order", async () => {
      const before = paintBlocks(await pdfContentStream(h));
      // Unbaked, the rectangle contributes exactly the FRONT-MOST layer
      // pair (one fill + one stroke — the one-slot reality); the F1
      // polygon adds a fill and the graphic line a stroke.
      expect(before).toHaveLength(4);

      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);
      const after = paintBlocks(await pdfContentStream(h));

      // The carrier now paints NOTHING and the three derived paths paint
      // in order: Black fill, Paper fill, 2pt Black stroke.
      expect(after).toHaveLength(5);
      expect(after[0]).toMatchObject({ fill: "0 0 0", op: "f" });
      expect(after[1].op).toBe("f");
      expect(after[1].fill).not.toBe("0 0 0"); // Paper, not Black
      expect(after[2]).toMatchObject({ stroke: "0 0 0", width: "2", op: "S" });
      await releaseAppearance(h.host, RECT);
    });

    it("EXPORT (IDML) — the whole baked group saves back (C-19)", async () => {
      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);
      const liveGroup = await groupShape(h);

      const reopened = await reopenViaIdml(h);
      try {
        // core's IDML writer emits a scene-created group as a real
        // `<Group>` with its members nested and re-based (C-19), so every
        // DERIVED layer reaches the file — where the writer used to drop
        // the whole bake on the floor.
        const ids = await leafIds(reopened);
        for (const id of created) {
          expect(ids).toContain(id.id as string);
        }
        // `leafIds` walks to LEAVES, so the wrapper itself is not in that
        // list — the group is the non-leaf node with children.
        const group = await groupShape(reopened);
        expect(group).not.toBeNull();
        expect(group!.id).toBe(liveGroup!.id);
        // Members in PAINT order: the carrier first, then the derived
        // layers back-to-front. C-19 also made the insert lane follow the
        // spread's z-table, so the stack no longer re-imports inverted.
        expect(group!.members).toEqual([
          RECT.id,
          ...created.map((c) => c.id as string),
        ]);
        // The CARRIER survives — moved INSIDE the wrapper by the writer …
        expect(ids).toContain(RECT.id as string);
        // …and it carries the paint the bake gave it: none. Spelled
        // `Swatch/None` rather than the absent attribute the pre-C-19
        // round-trip produced: a MOVED carrier is re-emitted by the
        // write-new lane, which NAMES the empty paint instead of leaving
        // the attribute out. Same picture, explicit spelling.
        expect(await readProp(reopened, RECT, "frameFillColor")).toEqual({
          type: "colorRef",
          value: "Swatch/None",
        });
        // …and its `<Label>` (this plugin's envelope) rode the move, so
        // the editable stack AND the bake record reopen intact.
        const env = await reopened.host.document.getMetadata(RECT);
        expect(appearanceOf(env)).toEqual(STACK);
        expect(appearanceBakeOf(env)!.layers).toEqual(
          created.map((c) => c.id as string),
        );
        // Each derived layer keeps its ONE paint, and its own envelope
        // still resolves back to the carrier.
        expect(await readProp(reopened, created[0], "frameFillColor")).toEqual({
          type: "colorRef",
          value: "Color/Black",
        });
        expect(await readProp(reopened, created[1], "frameFillColor")).toEqual({
          type: "colorRef",
          value: "Color/Paper",
        });
        expect(await readProp(reopened, created[2], "frameStrokeColor")).toEqual(
          { type: "colorRef", value: "Color/Black" },
        );
        expect(await readProp(reopened, created[2], "frameStrokeWeight")).toEqual(
          { type: "length", value: 2 },
        );
        expect(
          appearanceLayerOf(
            await reopened.host.document.getMetadata(created[0]),
          )!.of,
        ).toEqual(RECT);

        // CLOSED (RFI C-22): an inserted item used to emit at the SPREAD'S
        // CLOSE, so the group reopened ABOVE everything the source file
        // already carried and the file's z-order disagreed with the
        // canvas. The writer now anchors an inserted item to the first
        // following source item, so this matches the LIVE-tree assertion
        // in the BAKE test exactly — which is the whole point: what the
        // file records is what the canvas shows.
        const page = (await reopened.host.document.tree())[0].children![0];
        expect(page.children!.map((c) => c.id!.id)).toEqual([
          group!.id,
          F1_MULTI_SHAPE.ids.polygon,
          F1_MULTI_SHAPE.ids.graphicLine,
        ]);
      } finally {
        reopened.dispose();
      }
    });

    it("EXPORT (IDML) — RELEASE first and the front-most layer saves back", async () => {
      expect(await releaseAppearance(h.host, RECT)).toBe(true);
      const reopened = await reopenViaIdml(h);
      try {
        expect(await readProp(reopened, RECT, "frameFillColor")).toEqual({
          type: "colorRef",
          value: "Color/Paper",
        });
        expect(await readProp(reopened, RECT, "frameStrokeWeight")).toEqual({
          type: "length",
          value: 2,
        });
        expect(
          appearanceOf(await reopened.host.document.getMetadata(RECT)),
        ).toEqual(STACK);
      } finally {
        reopened.dispose();
      }
    });

    it("per-layer TINT + BLEND MODE + OPACITY land on the derived paths and survive an IDML save (C-19/C-20)", async () => {
      // The stack the old note said could not be lowered: a tinted,
      // multiplied bottom fill and a half-transparent stroke.
      const prev = await h.host.document.getMetadata(RECT);
      await commitAppearance(h.host, RECT, MODIFIED_STACK, prev);
      const created = await bakeAppearance(h.host, RECT);
      expect(created).toHaveLength(3);

      // …ON THE ENGINE: `FrameFillTint` / `FrameBlendMode` on a derived
      // Polygon are C-20 arms; `FrameOpacity` always had one.
      expect(await readProp(h, created[0], "frameFillTint")).toEqual({
        type: "length",
        value: 40,
      });
      expect(await readProp(h, created[0], "frameBlendMode")).toEqual({
        type: "text",
        value: "Multiply",
      });
      expect(await readProp(h, created[2], "frameOpacity")).toEqual({
        type: "length",
        value: 55,
      });
      // An untinted layer stays untinted — the bake emits nothing it was
      // not given.
      expect(await readProp(h, created[1], "frameFillTint")).toEqual({
        type: "length",
        value: null,
      });

      // …AND THROUGH A SAVE: C-19 emits the tint attribute and the
      // `<TransparencySetting>` (opacity + blend mode) for an inserted
      // item, which the write-new lane used to drop entirely.
      const reopened = await reopenViaIdml(h);
      try {
        expect(await readProp(reopened, created[0], "frameFillTint")).toEqual({
          type: "length",
          value: 40,
        });
        expect(await readProp(reopened, created[0], "frameBlendMode")).toEqual({
          type: "text",
          value: "Multiply",
        });
        expect(await readProp(reopened, created[2], "frameOpacity")).toEqual({
          type: "length",
          value: 55,
        });
        // The editable model rides along unchanged.
        expect(
          appearanceOf(await reopened.host.document.getMetadata(RECT)),
        ).toEqual(MODIFIED_STACK);
      } finally {
        reopened.dispose();
      }
      await releaseAppearance(h.host, RECT);
    });

    it("a GraphicLine still REFUSES tint + blend — named, not papered over", async () => {
      // C-20 gave Polygon and Oval the `FrameFillTint` / `FrameBlendMode`
      // arms; `paged_model::GraphicLine` has no `fill_tint` /
      // `blend_mode` / `opacity` field at all (its paint is entirely
      // stroke-side), so the refusal is a MODEL fact, not a missing arm.
      // The bake never mints a GraphicLine, so this bites nothing — it is
      // pinned so the boundary stays honest.
      const line = {
        kind: "graphicLine",
        id: F1_MULTI_SHAPE.ids.graphicLine!,
      } as ElementId;
      for (const op of [
        {
          op: "setElementProperty",
          args: {
            elementId: line,
            path: "frameFillTint",
            value: { type: "length", value: 40 },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: line,
            path: "frameBlendMode",
            value: { type: "text", value: "Multiply" },
          },
        },
      ] as Mutation[]) {
        const outcome = await h.host.document.mutate(op);
        expect(outcome.applied).toBe(false);
      }
    });
  });
});
