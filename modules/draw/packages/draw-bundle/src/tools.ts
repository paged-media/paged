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

// The paged.draw tool catalog — namespaced under the manifest id,
// joining the rail's existing "pen" flyout slot (group = slot).
// Division of labor (editor W2.5): the PEN itself is a built-in
// core-document tool (group default, authors NEW paths); this bundle
// contributes the three anchor-EDITING companions in the same slot.
// Registered through `contributeTool` so each entry carries its
// activation command + text-suppressed shortcut (the host only
// auto-wires shortcuts for startup tools — BREAKAGE_LOG B-15).
//
// B-17: the tool list is a FACTORY over the `BundleHost` — each
// gesture handler closes over `host` and reaches the engine through
// the `host.*` facades only (no raw spine). `activate(host)` calls
// `drawTools(host)`; the static `DRAW_TOOL_IDS` (just the ids, no
// host) stays available for the edit context's tool-set.

import type {
  BundleHost,
  CursorSpec,
  ToolContribution,
} from "@paged-media/plugin-api";

import { createAnchorEditHandler } from "./handlers/anchors";
import {
  createBlobBrushHandler,
  createEraserBrushHandler,
  createPaintbrushHandler,
} from "./handlers/brush";
import { createCornerRadiusHandler } from "./handlers/corner-radius";
import { createCurvatureHandler } from "./handlers/curvature";
import { createEyedropperHandler } from "./handlers/eyedropper";
import { createGradientAnnotatorHandler } from "./handlers/gradient-annotator";
import { createLassoSelectHandler } from "./handlers/lasso";
import {
  createLivePaintBucketHandler,
  createLivePaintSelectHandler,
} from "./handlers/live-paint";
import { createMeasureHandler } from "./handlers/measure";
import { createPencilHandler } from "./handlers/pencil";
import { createShapeBuilderHandler } from "./handlers/shape-builder";
import { createTypeOnPathHandler } from "./handlers/text-on-path";
import { createWidthHandler } from "./handlers/width";

const CROSS: CursorSpec = { kind: "css", token: "crosshair" };

/** The anchor-editing tool ids, in rail order — exported host-free so
 *  the edit context can name its tool-set without a host (B-17). */
export const DRAW_TOOL_IDS = [
  "media.paged.draw.tool.addAnchor",
  "media.paged.draw.tool.deleteAnchor",
  "media.paged.draw.tool.convertAnchor",
] as const;

/** Phase 4c — the pro toolset ids, in rail order (host-free, like
 *  DRAW_TOOL_IDS; the edit context keeps its anchor-editing set —
 *  these are document-level authoring/inspection tools). Phase 9 (Tier
 *  B) appends the Shape Builder gesture tool. */
export const PRO_TOOL_IDS = [
  "media.paged.draw.tool.curvature",
  "media.paged.draw.tool.pencil",
  "media.paged.draw.tool.gradientAnnotator",
  "media.paged.draw.tool.measure",
  "media.paged.draw.tool.shapeBuilder",
  "media.paged.draw.tool.cornerRadius",
] as const;

/** Brush tools v0 — sweep-authoring ids, in rail order (host-free, the
 *  PRO_TOOL_IDS pattern). */
export const BRUSH_TOOL_IDS = [
  "media.paged.draw.tool.paintbrush",
  "media.paged.draw.tool.blobBrush",
  "media.paged.draw.tool.eraserBrush",
] as const;

/** Wave 2 — the eyedropper / width / lasso ids, in rail order
 *  (host-free, the PRO_TOOL_IDS pattern). */
export const WAVE2_TOOL_IDS = [
  "media.paged.draw.tool.eyedropper",
  "media.paged.draw.tool.width",
  "media.paged.draw.tool.lassoSelect",
] as const;

/** LIVE PAINT v0 — the bucket + the face-selection tool, in rail order
 *  (host-free, the PRO_TOOL_IDS pattern). */
export const LIVE_PAINT_TOOL_IDS = [
  "media.paged.draw.tool.livePaintBucket",
  "media.paged.draw.tool.livePaintSelect",
] as const;

/** TYPE ON A PATH (C-29, engine protocol v58) — one tool (host-free,
 *  the PRO_TOOL_IDS pattern). */
export const TEXT_ON_PATH_TOOL_IDS = [
  "media.paged.draw.tool.typeOnPath",
] as const;

/** Build the three anchor-editing tools bound to `host` — each
 *  gesture handler reaches the engine through the facades only (B-17).
 *  `activate(host)` iterates this and contributes each. */
export function drawTools(host: BundleHost): ToolContribution[] {
  return [
    {
      id: "media.paged.draw.tool.addAnchor",
      title: "Add Anchor Point",
      icon: "tool-addAnchor",
      shortcut: "=",
      group: "pen",
      section: "drawType",
      order: 1,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("add", host),
    },
    {
      id: "media.paged.draw.tool.deleteAnchor",
      title: "Delete Anchor Point",
      icon: "tool-deleteAnchor",
      shortcut: "-",
      group: "pen",
      section: "drawType",
      order: 2,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("delete", host),
    },
    {
      id: "media.paged.draw.tool.convertAnchor",
      title: "Convert Direction Point",
      icon: "tool-convertAnchor",
      shortcut: "shift+c",
      group: "pen",
      section: "drawType",
      order: 3,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("convert", host),
    },
    // Phase 4c — the pro toolset. Curvature + Pencil AUTHOR new paths
    // (machine → one insertPath), so they join the pen flyout slot;
    // the gradient annotator + measure are inspection/steering tools
    // in their own slots.
    {
      id: "media.paged.draw.tool.curvature",
      title: "Curvature",
      icon: "tool-curvature",
      // shift+u — yields shift+p to the built-in Page tool (InDesign-canonical);
      // INV-REG-1 keeps every single-key tool shortcut unique across bundles.
      shortcut: "shift+u",
      group: "pen",
      section: "drawType",
      order: 4,
      cursor: CROSS,
      gesture: () => createCurvatureHandler(host),
    },
    {
      id: "media.paged.draw.tool.pencil",
      title: "Pencil",
      icon: "tool-pencil",
      shortcut: "shift+n",
      group: "pen",
      section: "drawType",
      order: 5,
      cursor: CROSS,
      gesture: () => createPencilHandler(host),
    },
    {
      id: "media.paged.draw.tool.gradientAnnotator",
      title: "Gradient Annotator",
      icon: "tool-gradient",
      // shift+a — yields shift+g to the built-in Gradient Feather tool
      // (InDesign-canonical); INV-REG-1 keeps tool shortcuts unique.
      shortcut: "shift+a",
      group: "gradientAnnotator",
      section: "transform",
      order: 1,
      cursor: CROSS,
      gesture: () => createGradientAnnotatorHandler(host),
    },
    {
      id: "media.paged.draw.tool.measure",
      title: "Measure",
      icon: "tool-measure",
      shortcut: "shift+m",
      group: "measure",
      section: "modNav",
      order: 1,
      cursor: CROSS,
      gesture: () => createMeasureHandler(host),
    },
    // Phase 9 (Tier B) — Shape Builder: a drag across overlapping shapes
    // unites them; Alt-drag subtracts. Composes over pathfinderBoolean;
    // the gesture decides the operand set + mode (handlers/shape-builder.ts).
    {
      id: "media.paged.draw.tool.shapeBuilder",
      title: "Shape Builder",
      icon: "tool-shapeBuilder",
      shortcut: "shift+b",
      group: "shapeBuilder",
      section: "drawType",
      order: 6,
      cursor: CROSS,
      gesture: () => createShapeBuilderHandler(host),
    },
    // §13.2 — the on-canvas corner widget: press near a corner of the
    // selected rectangle, drag inward, release → ONE per-corner
    // RoundedCorner mutation (the handle the live-corners commands
    // reserved; rectangles only, B-23).
    {
      id: "media.paged.draw.tool.cornerRadius",
      title: "Corner Radius",
      icon: "tool-cornerRadius",
      shortcut: "shift+r",
      group: "cornerRadius",
      section: "transform",
      order: 2,
      cursor: CROSS,
      gesture: () => createCornerRadiusHandler(host),
    },
    // Brush tools v0 — sweep authoring composed over the engine's
    // outline ops (handlers/brush.ts): BrushMachine centerline +
    // per-anchor calligraphic widths → insertPath →
    // outlineStrokeVariable = a filled swept shape. They AUTHOR new
    // paths, so they join the pen flyout slot with Pencil/Curvature.
    // v0 fixed nib defaults (no options UI yet): size 6pt, nib angle
    // 45°, roundness 0.3; eraser = uniform 6pt round nib.
    // SHORTCUTS (INV-REG-1, globally unique tool shortcuts): shift+j /
    // shift+k / shift+i — verified free against the editor built-ins
    // (v a u b t f m l c e r s o g i k h z p n w x d j q \ = - and the
    // shift+p/t/g trio), this bundle (= - shift+c/u/n/a/m/b/r) and the
    // other plugin bundles (paged.image holds shift+x).
    {
      id: "media.paged.draw.tool.paintbrush",
      title: "Paintbrush",
      icon: "tool-paintbrush",
      shortcut: "shift+j",
      group: "pen",
      section: "drawType",
      order: 7,
      cursor: CROSS,
      gesture: () => createPaintbrushHandler(host),
    },
    {
      id: "media.paged.draw.tool.blobBrush",
      title: "Blob Brush",
      icon: "tool-blobBrush",
      shortcut: "shift+k",
      group: "pen",
      section: "drawType",
      order: 8,
      cursor: CROSS,
      gesture: () => createBlobBrushHandler(host),
    },
    {
      id: "media.paged.draw.tool.eraserBrush",
      title: "Eraser",
      icon: "tool-eraserBrush",
      shortcut: "shift+i",
      group: "pen",
      section: "drawType",
      order: 9,
      cursor: CROSS,
      gesture: () => createEraserBrushHandler(host),
    },
    // Wave 2 — Eyedropper / Width / Lasso. SHORTCUTS (INV-REG-1,
    // globally unique tool shortcuts): shift+d / shift+s / shift+q —
    // verified free against the editor built-ins (the single keys
    // v a u b t f m l c e r s o g i k h z p n w x d j q \ = - plus the
    // shift+p/t/g trio — `d` is taken as a single key, shift+d is
    // not), this bundle (= - shift+c/u/n/a/m/b/r/j/k/i) and the other
    // plugin bundles: paged.image holds shift+x AND (since its
    // selection-tools wave) y / shift+y / shift+l / shift+w — which
    // rules out the Illustrator-canonical shift+w (Width) and shift+l
    // (Lasso) here. shift+s reads as "Stroke width"; shift+q shifts
    // Illustrator's own lasso key (q, whose single-key register is
    // editor-claimed).
    //
    // Eyedropper — sample a clicked element's PROPERTIES (not
    // composited pixels — handlers/eyedropper.ts documents the honest
    // scope) and apply them to the selection; Alt+click samples only.
    {
      id: "media.paged.draw.tool.eyedropper",
      title: "Eyedropper",
      icon: "tool-eyedropper",
      shortcut: "shift+d",
      group: "eyedropper",
      section: "modNav",
      order: 2,
      cursor: CROSS,
      gesture: () => createEyedropperHandler(host),
    },
    // Width v0 — drag near an anchor of the selected OPEN path to
    // peak a per-anchor width profile there, baked DESTRUCTIVELY via
    // outlineStrokeVariable on release (handlers/width.ts).
    {
      id: "media.paged.draw.tool.width",
      title: "Width",
      icon: "tool-width",
      shortcut: "shift+s",
      group: "width",
      section: "transform",
      order: 3,
      cursor: CROSS,
      gesture: () => createWidthHandler(host),
    },
    // Lasso select — freehand region; elements whose bounds CENTERS
    // fall inside are selected (handlers/lasso.ts documents the
    // centers-inside v0 semantics).
    {
      id: "media.paged.draw.tool.lassoSelect",
      title: "Lasso Select",
      icon: "tool-lassoSelect",
      shortcut: "shift+q",
      group: "lassoSelect",
      section: "selection",
      order: 1,
      cursor: CROSS,
      gesture: () => createLassoSelectHandler(host),
    },
    // LIVE PAINT v0 — the bucket hovers/paints the FACES of a recorded
    // group's planar arrangement (commands/live-paint.ts says exactly
    // what "Live Paint" does and does not mean here: a regenerable
    // recipe, no gap handling, no edges); its sibling selects the
    // materialised face artwork for restyling or deletion.
    //
    // SHORTCUTS (INV-REG-1, globally unique tool shortcuts): the
    // catalog's own two keys are BOTH unavailable — Illustrator's Live
    // Paint Bucket is `k`, which is an editor built-in single key, and
    // its Live Paint Selection is `shift+l`, which paged.image took in
    // its selection-tools wave. Re-verified at pick time against the
    // editor built-ins (v a u b t f m l c e r s o g i k h z p n w x d j
    // q \ = - plus the shift+p/t/g trio), this bundle (= -
    // shift+c/u/n/a/m/b/r/j/k/i/d/s/q) and paged.image, which has GROWN
    // since the wave-2 note above: it now holds shift+x, y, shift+y,
    // shift+l, shift+w AND q / shift+f / shift+e (its raster brush /
    // pencil / eraser). That left exactly four free shift keys —
    // shift+h, shift+o, shift+v, shift+z — and these take two of them.
    // `shift+v` reads as a Selection-tool variant (`v` is the editor's
    // Selection tool), which is what the face picker is. (Type on a Path
    // has since taken shift+h; shift+z is the only one still free.)
    //
    // ICONS: the host's kebab-case glyph map has no `tool-livePaint*`
    // entry, and an INVENTED token renders the rail button GLYPHLESS
    // (the stroke panel's recorded lesson) — so both borrow a REAL
    // token whose metaphor holds: a filled swatch for "drop this paint
    // into a region", and the direct-selection arrow for "pick one part
    // of a compound thing".
    {
      id: "media.paged.draw.tool.livePaintBucket",
      title: "Live Paint Bucket",
      icon: "tool-gradientSwatch",
      shortcut: "shift+o",
      group: "livePaintBucket",
      section: "drawType",
      order: 10,
      cursor: CROSS,
      gesture: () => createLivePaintBucketHandler(host),
    },
    {
      id: "media.paged.draw.tool.livePaintSelect",
      title: "Live Paint Selection",
      icon: "tool-directSelect",
      shortcut: "shift+v",
      group: "livePaintSelect",
      section: "selection",
      order: 2,
      cursor: CROSS,
      gesture: () => createLivePaintSelectHandler(host),
    },
    // TYPE ON A PATH (C-29, engine protocol v58) — click a Rectangle /
    // GraphicLine / Polygon and an EXISTING free story flows along it;
    // alt+click detaches (handlers/text-on-path.ts). The engine has
    // rendered `<TextPath>` all along; v58 is the first way to CREATE
    // one, so nothing here is an approximation.
    //
    // THE EDITOR ALREADY SHIPS AN INERT `paged.tool.typePath` — a
    // built-in rail entry titled "Type on a Path" (icon `tool-typePath`,
    // shortcut `shift+t`, TEXT cursor) that carries NO `gesture` and
    // therefore does nothing when picked. A bundle cannot attach
    // behaviour to a built-in id (`contributeTool` registers a NEW
    // tool), so this joins the SAME `type` group one slot further along
    // and takes a DISTINCT title, rather than shadowing the built-in or
    // pretending to replace it. Retiring the placeholder is an editor-
    // side call.
    //
    // SHORTCUT (INV-REG-1, globally unique tool shortcuts): the
    // canonical `shift+t` is exactly the inert built-in's key, so it is
    // NOT free. Re-verified at pick time against the editor built-ins
    // (v a u b t f m l c e r s o g i k h z p n w x d j q \ = - plus the
    // shift+p/t/g trio), this bundle (= - shift+c/u/n/a/m/b/r/j/k/i/d/
    // s/q and, since Live Paint, shift+o/shift+v) and paged.image
    // (shift+x, y, shift+y, shift+l, shift+w, q, shift+f, shift+e).
    // That leaves exactly TWO free shift keys — shift+h and shift+z —
    // and this takes shift+h: `shift+z` reads as an undo variant on
    // every platform and binding it to a tool would be a trap.
    {
      id: "media.paged.draw.tool.typeOnPath",
      title: "Type on a Path (attach story)",
      icon: "tool-typePath",
      shortcut: "shift+h",
      group: "type",
      section: "drawType",
      order: 2,
      cursor: CROSS,
      gesture: () => createTypeOnPathHandler(host),
    },
  ];
}
