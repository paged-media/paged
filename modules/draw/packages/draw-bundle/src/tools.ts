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
import { defineMessages, t } from "@paged-media/strings";

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
import { createKnifeHandler } from "./handlers/knife";
import { createLassoSelectHandler } from "./handlers/lasso";
import {
  createLivePaintBucketHandler,
  createLivePaintSelectHandler,
} from "./handlers/live-paint";
import { createMeasureHandler } from "./handlers/measure";
import { createRepeatHandler } from "./handlers/repeat";
import { createScissorsHandler } from "./handlers/scissors";
import { createShapeBuilderHandler } from "./handlers/shape-builder";
import { createTypeOnPathHandler } from "./handlers/text-on-path";
import { createWidthHandler } from "./handlers/width";
import { createReflectHandler } from "./handlers/reflect";
import { createReshapeHandler } from "./handlers/reshape";
import {
  createJoinHandler,
  createPathEraserHandler,
  createShaperHandler,
} from "./handlers/scrub-tools";
import { createFlareHandler, createStarHandler } from "./handlers/star-flare";
import {
  BLOB_BRUSH_OPTIONS,
  ERASER_OPTIONS,
  LASSO_OPTIONS,
  PAINTBRUSH_OPTIONS,
  RESHAPE_OPTIONS,
  STAR_OPTIONS,
  WIDTH_OPTIONS,
  toolOptionsSpecOf,
} from "./tool-options";

/** The tool names, read in the editor's locale when the bundle activates. */
const M = defineMessages("draw.tools", {
  addAnchor: "Add Anchor Point",
  deleteAnchor: "Delete Anchor Point",
  convertAnchor: "Convert Direction Point",
  curvature: "Curvature",
  gradientAnnotator: "Gradient Annotator",
  measure: "Measure",
  shapeBuilder: "Shape Builder",
  cornerRadius: "Corner Radius",
  paintbrush: "Paintbrush",
  blobBrush: "Blob Brush",
  eraser: "Eraser",
  eyedropper: "Eyedropper",
  width: "Width",
  lassoSelect: "Lasso Select",
  livePaintBucket: "Live Paint Bucket",
  livePaintSelection: "Live Paint Selection",
  typeOnPath: "Type on a Path (attach story)",
  repeat: "Repeat (steer the selected repeat)",
  knife: "Knife",
  scissorsAnyPoint: "Scissors (any point)",
  reflect: "Reflect",
  reshape: "Reshape",
  join: "Join",
  pathEraser: "Path Eraser",
  star: "Star",
  flare: "Flare",
  shaper: "Shaper",
});

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

/** REPEATS (§12.4) — the on-canvas steering widget (host-free, the
 *  PRO_TOOL_IDS pattern). */
export const REPEAT_TOOL_IDS = ["media.paged.draw.tool.repeat"] as const;

/** The CUTTING tools — they join the host's built-in Scissors flyout
 *  (host-free, the PRO_TOOL_IDS pattern). */
export const CUT_TOOL_IDS = [
  "media.paged.draw.tool.knife",
  "media.paged.draw.tool.scissorsAnyPoint",
] as const;

/** WP6.1 part 2 — Illustrator's remaining quick-win tools (host-free,
 *  the PRO_TOOL_IDS pattern). EVERY ONE IS KEYLESS: the shortcut
 *  registers are full (the note above: `shift+o` is the only free shift
 *  key and it is reserved for the host's Artboard tool), so each joins
 *  the host flyout Illustrator keeps it in, without a key. */
export const WAVE3_TOOL_IDS = [
  "media.paged.draw.tool.reflect",
  "media.paged.draw.tool.reshape",
  "media.paged.draw.tool.join",
  "media.paged.draw.tool.pathEraser",
  "media.paged.draw.tool.star",
  "media.paged.draw.tool.flare",
  "media.paged.draw.tool.shaper",
] as const;

/** Build the three anchor-editing tools bound to `host` — each
 *  gesture handler reaches the engine through the facades only (B-17).
 *  `activate(host)` iterates this and contributes each. */
export function drawTools(host: BundleHost): ToolContribution[] {
  return [
    {
      id: "media.paged.draw.tool.addAnchor",
      title: t(M.addAnchor),
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
      title: t(M.deleteAnchor),
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
      title: t(M.convertAnchor),
      icon: "tool-convertAnchor",
      shortcut: "shift+c",
      group: "pen",
      section: "drawType",
      order: 3,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("convert", host),
    },
    // Phase 4c — the pro toolset. Curvature AUTHORS new paths (machine →
    // one insertPath), so it joins the pen flyout slot; the gradient
    // annotator + measure are inspection/steering tools in their own
    // slots. The Pencil that stood here was retired into the host's one
    // Pencil (`paged.tool.pencil`, ADR 359).
    {
      id: "media.paged.draw.tool.curvature",
      title: t(M.curvature),
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
      id: "media.paged.draw.tool.gradientAnnotator",
      title: t(M.gradientAnnotator),
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
      title: t(M.measure),
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
      title: t(M.shapeBuilder),
      icon: "tool-shapeBuilder",
      shortcut: "shift+b",
      group: "shapeBuilder",
      section: "drawType",
      order: 6,
      cursor: CROSS,
      gesture: () => createShapeBuilderHandler(host),
    },
    // §13.2 — the on-canvas corner widget: press near a corner of the
    // selected rectangle, text frame or polygon (any rotation — the drag
    // runs in the element's own space), drag inward, release → ONE batch
    // (handlers/corner-radius.ts: a box corner's radius, or a polygon's
    // uniform one).
    {
      id: "media.paged.draw.tool.cornerRadius",
      title: t(M.cornerRadius),
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
    // paths, so they join the pen flyout slot with Curvature.
    // The nib is a TOOL OPTION (./tool-options.ts — double-click the
    // slot): size / angle / roundness / fidelity, defaulting to what
    // these tools shipped with (6pt, 45°, roundness 30%, 2px); the
    // eraser = a uniform round nib whose SIZE is its option (6pt).
    // SHORTCUTS (INV-REG-1, globally unique tool shortcuts): shift+j /
    // shift+k / shift+i — verified free against the editor built-ins
    // (v a u b t f m l c e r s o g i k h z p n w x d j q \ = - and the
    // shift+p/t/g trio), this bundle (= - shift+c/u/n/a/m/b/r) and the
    // other plugin bundles (paged.image holds shift+x).
    {
      id: "media.paged.draw.tool.paintbrush",
      title: t(M.paintbrush),
      icon: "tool-paintbrush",
      shortcut: "shift+j",
      group: "pen",
      section: "drawType",
      order: 7,
      cursor: CROSS,
      gesture: () => createPaintbrushHandler(host),
      options: toolOptionsSpecOf(PAINTBRUSH_OPTIONS),
    },
    {
      id: "media.paged.draw.tool.blobBrush",
      title: t(M.blobBrush),
      icon: "tool-blobBrush",
      shortcut: "shift+k",
      group: "pen",
      section: "drawType",
      order: 8,
      cursor: CROSS,
      gesture: () => createBlobBrushHandler(host),
      options: toolOptionsSpecOf(BLOB_BRUSH_OPTIONS),
    },
    {
      id: "media.paged.draw.tool.eraserBrush",
      title: t(M.eraser),
      icon: "tool-eraserBrush",
      shortcut: "shift+i",
      group: "pen",
      section: "drawType",
      order: 9,
      cursor: CROSS,
      gesture: () => createEraserBrushHandler(host),
      options: toolOptionsSpecOf(ERASER_OPTIONS),
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
      title: t(M.eyedropper),
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
      title: t(M.width),
      icon: "tool-width",
      shortcut: "shift+s",
      group: "width",
      section: "transform",
      order: 3,
      cursor: CROSS,
      gesture: () => createWidthHandler(host),
      // Peak limit / width per drag / falloff.
      options: toolOptionsSpecOf(WIDTH_OPTIONS),
    },
    // Lasso select — freehand region; elements whose OUTLINE the region
    // touches are selected, or (the `mode` option) those whose bounds
    // CENTRE falls inside — handlers/lasso.ts documents both rules and
    // what intersection costs.
    {
      id: "media.paged.draw.tool.lassoSelect",
      title: t(M.lassoSelect),
      icon: "tool-lassoSelect",
      shortcut: "shift+q",
      group: "lassoSelect",
      section: "selection",
      order: 1,
      cursor: CROSS,
      gesture: () => createLassoSelectHandler(host),
      options: toolOptionsSpecOf(LASSO_OPTIONS),
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
    // UPDATE 2026-10-04: the editor retired its dead built-in Measure and
    // freed `k`, so the bucket moved onto its canonical key (re-checked
    // against editor main and every plugin's tools: nothing else holds
    // `k`). `shift+o` is free again. The other two owed keys are gone:
    // the host's working Eyedropper holds `i`, and paged.image took
    // `shift+t`, so Type on a Path stays on `shift+h` and the Eyedropper
    // on `shift+d`.
    //
    // ICONS: the host's kebab-case glyph map has no `tool-livePaint*`
    // entry, and an INVENTED token renders the rail button GLYPHLESS
    // (the stroke panel's recorded lesson) — so both borrow a REAL
    // token whose metaphor holds: a filled swatch for "drop this paint
    // into a region", and the direct-selection arrow for "pick one part
    // of a compound thing".
    {
      id: "media.paged.draw.tool.livePaintBucket",
      title: t(M.livePaintBucket),
      icon: "tool-gradientSwatch",
      shortcut: "k",
      group: "livePaintBucket",
      section: "drawType",
      order: 10,
      cursor: CROSS,
      gesture: () => createLivePaintBucketHandler(host),
    },
    {
      id: "media.paged.draw.tool.livePaintSelect",
      title: t(M.livePaintSelection),
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
      title: t(M.typeOnPath),
      icon: "tool-typePath",
      shortcut: "shift+h",
      group: "type",
      section: "drawType",
      order: 2,
      cursor: CROSS,
      gesture: () => createTypeOnPathHandler(host),
    },
    // REPEATS (§12.4) — the on-canvas steering widget. Press and drag to
    // steer the SELECTED repeat's primary parameter (the ring centre,
    // the next grid cell, a point on the mirror axis); Shift snaps the
    // angular ones to 45°; the commit is ONE update on release.
    // handlers/repeat.ts states exactly how live that is and is not.
    //
    // NO SHORTCUT — and that is a decision, not an omission. The three
    // keys the editor freed on 2026-08-03 by retiring its dead rail
    // entries (`2e6f835`) are `shift+t`, `i` and `k`, and EVERY one of
    // them is the canonical Illustrator/InDesign key of a paged.draw
    // tool that is currently sitting on a substitute because that key
    // was taken: `shift+t` → Type on a Path (on `shift+h`; the editor's
    // own retirement note asks paged.draw to claim it), `i` →
    // Eyedropper (on `shift+d`), `k` → Live Paint Bucket (then on
    // `shift+o`). Taking one for a NEW tool would spend the correction
    // those retirements were FOR. The only other free register is
    // `shift+z`, which reads as an undo variant on every platform and
    // would be a trap. So this tool ships keyless — the editor's own
    // catalog has working tools with no shortcut (`paged.tool.smooth`),
    // and a keyless working tool is honest where a stolen key is not.
    //
    // (This also CORRECTS the note further up: `shift+z` is no longer
    // "the only free shift key" — `shift+t` is free too, and so are the
    // single keys `i` and `k`.)
    //
    // UPDATE 2026-10-04: the Live Paint Bucket now holds `k` (above), the
    // host's Eyedropper holds `i`, and paged.image took `shift+t` (clone
    // stamp) and `shift+z` (raster type), so `shift+o` is the one free
    // shift key; this tool stays keyless.
    //
    // ICON: `tool-rotate` is a REAL token in the host's kebab-case glyph
    // map and the honest metaphor — a radial repeat turns copies about a
    // centre, which is what the drag steers. An INVENTED token renders
    // the rail button glyphless (the stroke panel's recorded lesson), so
    // a shared real glyph beats a made-up specific one.
    {
      id: "media.paged.draw.tool.repeat",
      title: t(M.repeat),
      icon: "tool-rotate",
      group: "repeat",
      section: "transform",
      order: 4,
      cursor: CROSS,
      gesture: () => createRepeatHandler(host),
    },
    // THE KNIFE — a freehand cut through every closed path it crosses,
    // each split into separate closed pieces along it; Alt draws a
    // straight cut, Alt+Shift snaps it to 45° (commands/knife.ts says
    // which engine door does the geometry, and why the others do not).
    //
    // It joins the host's built-in `scissors` group — Illustrator keeps
    // Scissors and Knife in one flyout, and both CUT. NO SHORTCUT, for
    // the Repeat tool's reason above: the four free registers are owed
    // to the tools on substitutes (`shift+t`, `i`, `k`) or are a trap
    // (`shift+z`). `tool-scissors` is a REAL glyph in the host's map and
    // the honest metaphor; there is no knife glyph, and an invented
    // token renders the rail button glyphless.
    {
      id: "media.paged.draw.tool.knife",
      title: t(M.knife),
      icon: "tool-scissors",
      group: "scissors",
      section: "transform",
      order: 3,
      cursor: CROSS,
      gesture: () => createKnifeHandler(host),
    },
    // SCISSORS AT ANY POINT — the host's Scissors cuts at ANCHORS only;
    // this one splits the clicked segment where the click lands (the
    // de Casteljau insert) and opens the path there, in one batch
    // (handlers/scissors.ts). Same flyout, same glyph, same keyless
    // reason as the Knife above.
    {
      id: "media.paged.draw.tool.scissorsAnyPoint",
      title: t(M.scissorsAnyPoint),
      icon: "tool-scissors",
      group: "scissors",
      section: "transform",
      order: 2,
      cursor: CROSS,
      gesture: () => createScissorsHandler(host),
    },
    // WP6.1 part 2 — keyless, each in the host flyout Illustrator keeps it
    // in (WAVE3_TOOL_IDS says why there are no keys). Glyphs: REAL tokens
    // of the host's map whose metaphor holds (an invented token renders
    // the rail button glyphless).
    //
    // REFLECT and RESHAPE join the host's TRANSFORM flyout (Rotate, Scale,
    // Shear); Illustrator nests Reflect under Rotate and Reshape under
    // Scale — one flyout here.
    {
      id: "media.paged.draw.tool.reflect",
      title: t(M.reflect),
      icon: "tool-rotate",
      group: "transform",
      section: "transform",
      order: 10,
      cursor: CROSS,
      gesture: () => createReflectHandler(host),
    },
    {
      id: "media.paged.draw.tool.reshape",
      title: t(M.reshape),
      icon: "tool-directSelect",
      group: "transform",
      section: "transform",
      order: 11,
      cursor: CROSS,
      gesture: () => createReshapeHandler(host),
      options: toolOptionsSpecOf(RESHAPE_OPTIONS),
    },
    // JOIN, PATH ERASER and SHAPER join the host's PENCIL flyout (with
    // Smooth) — Illustrator's Shaper / Pencil / Smooth / Path Eraser / Join
    // group.
    {
      id: "media.paged.draw.tool.shaper",
      title: t(M.shaper),
      icon: "tool-pencil",
      group: "pencil",
      section: "drawType",
      order: 10,
      cursor: CROSS,
      gesture: () => createShaperHandler(host),
    },
    {
      id: "media.paged.draw.tool.pathEraser",
      title: t(M.pathEraser),
      icon: "tool-erase",
      group: "pencil",
      section: "drawType",
      order: 11,
      cursor: CROSS,
      gesture: () => createPathEraserHandler(host),
    },
    {
      id: "media.paged.draw.tool.join",
      title: t(M.join),
      icon: "tool-smooth",
      group: "pencil",
      section: "drawType",
      order: 12,
      cursor: CROSS,
      gesture: () => createJoinHandler(host),
    },
    // STAR and FLARE join the host's SHAPE flyout (Rectangle, Ellipse,
    // Polygon).
    {
      id: "media.paged.draw.tool.star",
      title: t(M.star),
      icon: "tool-polygon",
      group: "shape",
      section: "drawType",
      order: 10,
      cursor: CROSS,
      gesture: () => createStarHandler(host),
      options: toolOptionsSpecOf(STAR_OPTIONS),
    },
    {
      id: "media.paged.draw.tool.flare",
      title: t(M.flare),
      icon: "tool-ellipse",
      group: "shape",
      section: "drawType",
      order: 11,
      cursor: CROSS,
      gesture: () => createFlareHandler(host),
    },
  ];
}
