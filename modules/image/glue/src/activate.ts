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

// The paged.image bundle entry — the M4 "editor enablement" slice. The
// platform doors this consumes (all probed, never assumed): C-5
// host.assets.getPlacedImage (a placed frame's ORIGINAL bytes), C-1
// Stage-A sceneLayer with the v41 image item (in-frame composite of the
// adjusted RGBA), K-2 contribute.importer (File/Open + drag-drop routes
// PSD/PNG/JPEG bytes here). The engine wasm (image-js: codec/PSD decode
// + the GPU-only Engine A adjustments) boots LAZILY in the bundle realm
// on first ingest — the GPU device is created THERE, not inside
// loadBundleWasm's no-authority sandbox (BREAKAGE I-07).

import type {
  BindingProviderHandle,
  BundleHandle,
  BundleHost,
  CommandContribution,
  Disposable,
} from "@paged-media/plugin-api";
import {
  contributePanel,
  contributeSchemaPanel,
  contributeTool as sdkContributeTool,
} from "@paged-media/plugin-sdk";
import { withCanvasCapture } from "./canvas-capture";
import {
  imagePropertiesPanel,
  PROPERTIES_PANEL_ID,
  publishPropertyLists,
} from "./panels/properties-panel";
import { contributeMenu } from "./menu";
import { defineMessages, defineTranslations, t } from "@paged-media/strings";

import de from "../locales/de.json" with { type: "json" };

import manifest from "../manifest.json";

import { createImageSession } from "./session";
import { registerImageActions } from "./actions";
import { filterDef } from "./filters";
import { BG, type BlurKind } from "./filters-blur-gallery";
import { bindToolSettings, toolOptionFields } from "./tool-options";
import { makeImagePanel } from "./panels/image-panel";
import { adjustmentKindLabel } from "./panels/sections/layer-parity";
import { makeCropGesture } from "./crop-tool";
import { makeMoveGesture } from "./move-tool";
import { makeBucketGesture } from "./bucket-tool";
import { makeGradientGesture } from "./gradient-tool";
import { makeRedEyeGesture } from "./red-eye-tool";
import {
  makeColorSamplerGesture,
  makeEyedropperGesture,
} from "./sampler-tools";
import { makePatchGesture } from "./patch-tool";
import { makeSelectionGesture } from "./selection-tool";
import { makeBrushGesture, PAINT_CURSOR } from "./brush-tool";
import { makeTypeGesture } from "./type-tool";
import { makeLayersBindingProvider } from "./binding-provider/layers-provider";
import { makeTextBindingProvider } from "./binding-provider/text-provider";
import { makeColorBindingProvider } from "./binding-provider/color-provider";
import {
  contributeImageObjectModel,
  type UntypedCommand,
} from "./object-model/contribute";

const CMD = defineMessages("image.command", {
  image: "Image",
  openImagePanel: "Open image panel",
  adjustImage: "Adjust image",
  autoEnhanceImage: "Auto-enhance image",
  serveImageTilesToTheRenderer: "Serve image tiles to the renderer",
  applyCrop: "Apply crop",
  fillSelectionWithAGradient: "Fill selection with a gradient",
  fillSelectionWithNoise: "Fill selection with noise",
  addImageLayer: "Add image layer",
  addLayerMaskRevealAll: "Add layer mask (reveal all)",
  addLayerMaskHideAll: "Add layer mask (hide all)",
  bakeAdjustmentsIntoTheActiveLayer: "Bake adjustments into the active layer",
  undoImageEdit: "Undo image edit",
  redoImageEdit: "Redo image edit",
  median3x3: "Median (3×3)",
  maximum3x3: "Maximum (3×3)",
  minimum3x3: "Minimum (3×3)",
  fillWithTheForegroundColour: "Fill with the foreground colour",
  rotateCanvas90Clockwise: "Rotate canvas 90° clockwise",
  rotateCanvas90CounterClockwise: "Rotate canvas 90° counter-clockwise",
  rotateCanvas180: "Rotate canvas 180°",
  flipCanvasHorizontal: "Flip canvas horizontal",
  flipCanvasVertical: "Flip canvas vertical",
  commitImageEditsToTheDocument: "Commit image edits to the document",
  convertActiveLayerToSmartObject: "Convert active layer to smart object",
  definePatternFromSelectionImage: "Define pattern from selection (image)",
  fillSelectionWithTheDefinedPattern: "Fill selection with the defined pattern",
  shapeBlurDefinedPatternAsTheShape:
    "Shape blur (defined pattern as the shape)",
  applyAdjustmentsToTheFile: "Apply adjustments to the file",
  saveTheAdjustedFile: "Save the adjusted file",
  loadBrushLibraryAbr: "Load brush library (.abr)",
  selectionToPathImage: "Selection to path (image)",
  pathToSelectionImage: "Path to selection (image)",
  luminosityChannelToSelectionImage: "Luminosity channel to selection (image)",
  setTypeImage: "Set type (image)",
  contentAwareFill: "Content-aware fill",
  selectAllImage: "Select all (image)",
  deselectImage: "Deselect (image)",
  invertSelectionImage: "Invert selection (image)",
  featherSelectionImage: "Feather selection (image)",
  filterDialog: "{label}… (filter)",
  blurGalleryOf: "Blur gallery: {label}…",
  oneShotFilter: "{label} (filter)",
  curvesTarget: "Curves: targeted adjustment on the image",
  averageBlur: "Average (fill the selection with its average colour)",
  imageSize: "Image size…",
  trim: "Trim…",
  rotateArbitrary: "Rotate canvas by an arbitrary angle…",
  newFillSolid: "New fill layer: solid colour",
  newFillGradient: "New fill layer: gradient",
  newFillPattern: "New fill layer: pattern",
  newAdjustment: "New adjustment layer: {kind}",
  blendingOptions: "Blending options of the active layer…",
  rasterizeLayer: "Rasterize the active layer",
  layerViaCopy: "Layer via copy",
  layerViaCut: "Layer via cut",
  mergeDown: "Merge down",
  mergeVisible: "Merge visible",
  mergeGroup: "Merge the active layer's group",
  stampVisible: "Stamp visible",
  flattenImage: "Flatten image",
  alignLeft: "Align layers: left edges",
  alignHCenter: "Align layers: horizontal centres",
  alignRight: "Align layers: right edges",
  alignTop: "Align layers: top edges",
  alignVCenter: "Align layers: vertical centres",
  alignBottom: "Align layers: bottom edges",
  distributeHorizontal: "Distribute layers: horizontal centres",
  distributeVertical: "Distribute layers: vertical centres",
  linkLayers: "Link the active layer with the layer below",
  unlinkLayer: "Unlink the active layer",
  newLayerComp: "New layer comp",
});

const BLUR_LABELS: Record<BlurKind, string> = {
  field: BG.field,
  iris: BG.iris,
  tilt: BG.tiltShift,
  path: BG.path,
  spin: BG.spin,
};

/** The no-dialog filters' names (the same keys the session's status
 *  line uses). */
const ONE_SHOT_LABELS = defineMessages("image.effect", {
  solarize: "Solarize",
  facet: "Facet",
  desaturate: "Desaturate",
  equalize: "Equalize",
});

const TOOL = defineMessages("image.tool", {
  crop: "Crop",
  movePixels: "Move pixels",
  paintBucket: "Paint bucket",
  gradient: "Gradient",
  redEye: "Red eye",
  eyedropper: "Eyedropper",
  colorSampler: "Color sampler",
  marqueeRectangle: "Marquee (rectangle)",
  marqueeEllipse: "Marquee (ellipse)",
  lasso: "Lasso",
  polygonalLasso: "Polygonal lasso",
  magicWand: "Magic wand",
  quickSelection: "Quick selection",
  brushRaster: "Brush (raster)",
  pencilRaster: "Pencil (raster)",
  eraserRaster: "Eraser (raster)",
  cloneStamp: "Clone stamp",
  healingBrush: "Healing brush",
  spotHealingBrush: "Spot healing brush",
  patch: "Patch",
  typeRaster: "Type (raster)",
  dodge: "Dodge",
  burn: "Burn",
  sponge: "Sponge",
  blurBrush: "Blur (brush)",
  sharpenBrush: "Sharpen (brush)",
});

const IO = defineMessages("image.io", {
  imagePsdPngJpeg: "Image (PSD/PNG/JPEG)",
  psdAdjustedPixelsEditedLayers: "PSD (adjusted pixels + edited layers)",
  pngAdjustedPixels: "PNG (adjusted pixels)",
  jpegAdjustedPixels: "JPEG (adjusted pixels)",
});

// The commands' category stays English (an identity); the shell shows it
// through its category labels.
defineMessages("commandCategory", { Image: "Image" });

// The German of every message in this bundle (the editor's catalogue for
// a language is all packages' translations together).
defineTranslations("de", de);

const PANEL_ID = "media.paged.image.panel.adjustments";
const CROP_TOOL_ID = "media.paged.image.tool.crop";
const MOVE_TOOL_ID = "media.paged.image.tool.move";
const BUCKET_TOOL_ID = "media.paged.image.tool.bucket";
const GRADIENT_TOOL_ID = "media.paged.image.tool.gradient";
const RED_EYE_TOOL_ID = "media.paged.image.tool.redEye";
const EYEDROPPER_TOOL_ID = "media.paged.image.tool.eyedropper";
const COLOR_SAMPLER_TOOL_ID = "media.paged.image.tool.colorSampler";
const DODGE_TOOL_ID = "media.paged.image.tool.dodge";
const BURN_TOOL_ID = "media.paged.image.tool.burn";
const SPONGE_TOOL_ID = "media.paged.image.tool.sponge";
const BLUR_TOOL_ID = "media.paged.image.tool.blur";
const SHARPEN_TOOL_ID = "media.paged.image.tool.sharpen";
const SPOT_HEAL_TOOL_ID = "media.paged.image.tool.spotHeal";
const PATCH_TOOL_ID = "media.paged.image.tool.patch";
const MARQUEE_RECT_TOOL_ID = "media.paged.image.tool.marqueeRect";
const MARQUEE_ELLIPSE_TOOL_ID = "media.paged.image.tool.marqueeEllipse";
const LASSO_TOOL_ID = "media.paged.image.tool.lasso";
const POLY_LASSO_TOOL_ID = "media.paged.image.tool.polygonal-lasso";
const MAGIC_WAND_TOOL_ID = "media.paged.image.tool.magicWand";
const QUICK_SELECT_TOOL_ID = "media.paged.image.tool.quickSelect";
const BRUSH_TOOL_ID = "media.paged.image.tool.brush";
const PENCIL_TOOL_ID = "media.paged.image.tool.pencil";
const ERASER_TOOL_ID = "media.paged.image.tool.eraser";
const CLONE_TOOL_ID = "media.paged.image.tool.clone";
const HEAL_TOOL_ID = "media.paged.image.tool.heal";
const TYPE_TOOL_ID = "media.paged.image.tool.type";

export function activate(host: BundleHost): BundleHandle {
  const session = createImageSession(host);
  // Every image tool offers a press to the dialog that draws on the
  // canvas first (the Blur Gallery's pins, Curves' targeted adjustment).
  const contributeTool: typeof sdkContributeTool = (h, spec) =>
    sdkContributeTool(
      h,
      spec.gesture
        ? {
            ...spec,
            gesture: () => withCanvasCapture(host, session, spec.gesture!()),
          }
        : spec,
    );
  /** Whether the raster type tool is the one in hand. See the type
   *  tool's gesture wrapper below for why this is tracked here. */
  let typeToolActive = false;
  /** ADR-023 provider handles, and the subscription that tells the host
   *  their values moved. Disposed with the bundle — and disposable
   *  INDIVIDUALLY, which is what makes phase D a migration rather than a
   *  deletion: a duplicate panel retires behind the seam one at a time
   *  and rolls back by dropping one handle. */
  const providerHandles: BindingProviderHandle[] = [];
  let providerInvalidate: Disposable | null = null;
  /** Every command as registered, so each gets its TYPED twin in the
   *  object model (ADR 323) — the untyped registration stays. */
  const untyped: UntypedCommand[] = [];
  const command = (c: CommandContribution) => {
    untyped.push({ id: c.id, title: c.title, handler: c.handler });
    return host.contribute.command(c);
  };

  contributePanel(host, {
    id: PANEL_ID,
    title: t(CMD.image),
    icon: "panel-canvas",
    component: makeImagePanel(session),
    defaultDock: "right",
  });

  command({
    id: "media.paged.image.command.openImage",
    title: t(CMD.openImagePanel),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
    },
  });

  // The selection-driven flow: "Adjust image" on a placed image frame —
  // ingest the frame's original bytes (C-5) and raise the panel; the
  // panel's committed Apply runs the GPU chain + the in-frame composite.
  command({
    id: "media.paged.image.command.adjustSelected",
    title: t(CMD.adjustImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      // Into the image's edit context too, so its tools and Cmd+Z follow
      // (the host's own double-click gesture, from a command).
      void session.ingestSelection().then(async (ok) => {
        const el = session.sourceElement();
        if (ok && el && host.supports("shell.enterEditContext@1")) {
          await host.shell
            .enterEditContext("rasterImage", el)
            .catch(() => false);
        }
      });
    },
  });

  // Auto-enhance: derive auto-levels + a gray-world white balance from the
  // ingested image's histogram (pure CPU readout) and set them on the panel
  // params. Like every edit it's PREVIEW-only — the user commits with Apply.
  command({
    id: "media.paged.image.command.autoEnhance",
    title: t(CMD.autoEnhanceImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      session.autoEnhance();
    },
  });

  // C-6 (I-06) — claim the ingested image's tile resource so the renderer
  // pulls level-0 tiles for the placed frame at its current scale (the
  // honest subset; the mip pyramid + Engine B window eval are the named
  // gap in tile-provider.ts). Degrades honestly when the host wires no
  // resource channel (rendering.resourceProvider@1 is false).
  command({
    id: "media.paged.image.command.claimTiles",
    title: t(CMD.serveImageTilesToTheRenderer),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      session.claimTiles();
    },
  });

  // Crop + straighten TOOL (the on-canvas crop affordance). Registers
  // into the transform rail; its gesture drives the session's crop machine
  // (image_core::crop geometry) and renders the crop frame through the
  // LIVE host.overlay door. The COMMIT rides the commitCrop command (and
  // the panel button) so it's a deliberate, single action.
  // Tool options in the host's bar, where the host reports them back.
  const toolFields = host.supports("tools.settings@1")
    ? toolOptionFields({
        brush: BRUSH_TOOL_ID,
        pencil: PENCIL_TOOL_ID,
        eraser: ERASER_TOOL_ID,
        wand: MAGIC_WAND_TOOL_ID,
        bucket: BUCKET_TOOL_ID,
        gradient: GRADIENT_TOOL_ID,
        eyedropper: EYEDROPPER_TOOL_ID,
        colorSampler: COLOR_SAMPLER_TOOL_ID,
      })
    : null;
  const optionsFor = (toolId: string) =>
    toolFields?.[toolId]
      ? { options: { toolId, fields: toolFields[toolId] } }
      : {};

  contributeTool(host, {
    id: CROP_TOOL_ID,
    title: t(TOOL.crop),
    icon: "tool-crop",
    group: CROP_TOOL_ID,
    section: "transform",
    // shift+x — yields "c" to the built-in Scissors tool (InDesign-canonical);
    // INV-REG-1 (editor registry-invariants) keeps tool shortcuts unique.
    shortcut: "shift+x",
    gesture: () => makeCropGesture(host, session),
  });

  // MOVE (raster) — drag the selected pixels (Alt: copy) or, with no
  // selection, the active layer; arrows nudge 1 px, Shift+arrow 10. It
  // shares the crop tool's rail slot and takes no shortcut of its own:
  // "v" is the host Selection tool, which moves the FRAME.
  contributeTool(host, {
    id: MOVE_TOOL_ID,
    title: t(TOOL.movePixels),
    icon: "tool-select",
    group: CROP_TOOL_ID,
    section: "transform",
    gesture: () => makeMoveGesture(host, session),
  });

  // PAINT BUCKET — floods by colour (wand tolerance / contiguity) with
  // the foreground. Shares the brush slot; no shortcut ("g" is taken).
  contributeTool(host, {
    id: BUCKET_TOOL_ID,
    ...optionsFor(BUCKET_TOOL_ID),
    title: t(TOOL.paintBucket),
    icon: "tool-gradient",
    group: BRUSH_TOOL_ID,
    section: "drawType",
    gesture: () => makeBucketGesture(host, session),
  });

  // GRADIENT — drag to set the line; foreground → background. Shares the
  // brush slot with the bucket (Photoshop pairs them).
  contributeTool(host, {
    id: GRADIENT_TOOL_ID,
    ...optionsFor(GRADIENT_TOOL_ID),
    title: t(TOOL.gradient),
    icon: "tool-gradient",
    group: BRUSH_TOOL_ID,
    section: "drawType",
    gesture: () => makeGradientGesture(host, session),
  });

  // RED EYE — drag a box around the eye; shares the healing brush's slot.
  contributeTool(host, {
    id: RED_EYE_TOOL_ID,
    title: t(TOOL.redEye),
    icon: "tool-heal",
    group: HEAL_TOOL_ID,
    section: "drawType",
    gesture: () => makeRedEyeGesture(host, session),
  });

  // EYEDROPPER (WP4.10) — the colour under the pointer into the
  // foreground (Alt: background); its own slot, with the Color Sampler in
  // its flyout (Photoshop's pairing). No key: the shortcut register is full
  // and `i` is the host's own Eyedropper.
  contributeTool(host, {
    id: EYEDROPPER_TOOL_ID,
    ...optionsFor(EYEDROPPER_TOOL_ID),
    title: t(TOOL.eyedropper),
    icon: "tool-eyedropper",
    group: EYEDROPPER_TOOL_ID,
    section: "drawType",
    gesture: () => makeEyedropperGesture(host, session),
  });
  // COLOR SAMPLER — up to four fixed sampling points, read live.
  contributeTool(host, {
    id: COLOR_SAMPLER_TOOL_ID,
    ...optionsFor(COLOR_SAMPLER_TOOL_ID),
    title: t(TOOL.colorSampler),
    icon: "tool-eyedropper",
    group: EYEDROPPER_TOOL_ID,
    section: "drawType",
    gesture: () => makeColorSamplerGesture(host, session),
  });

  // The crop commit command (also surfaced as the panel's "Apply crop"
  // button): cut the machine's rect out of the engine source + recomposite.
  command({
    id: "media.paged.image.command.commitCrop",
    title: t(CMD.applyCrop),
    category: "Image",
    handler: () => {
      void session.commitCrop();
    },
  });

  // ── SELECTION tools (spec §6.1 — the mask ABI's editor reach) ──
  //
  // Four tools over ONE gesture architecture (the crop pattern: gesture →
  // machine → Rust coverage → marching-ants overlay via
  // host.overlay.setToolPreview). The selection is ENGINE state bound to
  // the ingested source; the committed Apply masks every adjust/filter
  // dispatch (GPU `mix(a, result, mask)`) + the CPU curves pass by it.
  // Modifier convention on all four (read from the gesture events'
  // `modifiers`): shift = add, alt = subtract, shift+alt = intersect.
  // SHORTCUTS (INV-REG-1, globally unique tool shortcuts): "y" is the
  // last free single letter; shift+y / shift+l / shift+w are free in the
  // shift register (draw holds shift+a/b/c/i/j/k/m/n/r/u; this bundle
  // holds shift+x) — verified against both manifests + the editor
  // built-ins at pick time.
  contributeTool(host, {
    id: MARQUEE_RECT_TOOL_ID,
    title: t(TOOL.marqueeRectangle),
    icon: "tool-marquee-rect",
    group: MARQUEE_RECT_TOOL_ID,
    section: "selection",
    shortcut: "y",
    gesture: () => makeSelectionGesture(host, session, "rect"),
  });
  contributeTool(host, {
    id: MARQUEE_ELLIPSE_TOOL_ID,
    title: t(TOOL.marqueeEllipse),
    icon: "tool-marquee-ellipse",
    group: MARQUEE_ELLIPSE_TOOL_ID,
    section: "selection",
    shortcut: "shift+y",
    gesture: () => makeSelectionGesture(host, session, "ellipse"),
  });
  contributeTool(host, {
    id: LASSO_TOOL_ID,
    title: t(TOOL.lasso),
    icon: "tool-lasso",
    group: LASSO_TOOL_ID,
    section: "selection",
    shortcut: "shift+l",
    gesture: () => makeSelectionGesture(host, session, "lasso"),
  });
  // POLYGONAL lasso — the same lasso SLOT, because a designer picks one
  // or the other for a given edge and never wants both on the rail at
  // once. Click places a vertex, Backspace/Delete removes the last,
  // Enter or a click on the FIRST vertex closes, Esc abandons.
  // Closing on the start rather than a double-click is deliberate:
  // `CanvasPointerEvent` carries no `detail`, and reconstructing a
  // double-click from timing needs a threshold constant that is wrong
  // for somebody.
  //
  // No shortcut of its own: it shares the lasso's `shift+l` slot, and
  // stealing another global register for a variant of a tool that is
  // already there would be exactly the land-grab the shortcut note in
  // paged.draw's CLAUDE.md warns about.
  contributeTool(host, {
    id: POLY_LASSO_TOOL_ID,
    title: t(TOOL.polygonalLasso),
    icon: "tool-lasso",
    group: LASSO_TOOL_ID,
    section: "selection",
    gesture: () => makeSelectionGesture(host, session, "polygon"),
  });
  // Magic wand: click-select by color distance. Its tool options carry
  // the tolerance (0–255 per channel, default 32) and the contiguous
  // toggle (default on); see `tool-options.ts` and selection-machine.ts.
  contributeTool(host, {
    id: MAGIC_WAND_TOOL_ID,
    ...optionsFor(MAGIC_WAND_TOOL_ID),
    title: t(TOOL.magicWand),
    icon: "tool-magic-wand",
    group: MAGIC_WAND_TOOL_ID,
    section: "selection",
    shortcut: "shift+w",
    gesture: () => makeSelectionGesture(host, session, "wand"),
  });
  // QUICK selection — paint-to-grow. Shares the wand's SLOT and its
  // shift+w register for the same reason the polygonal lasso shares the
  // lasso's: it is the other way to do the same job, and a designer
  // picks one per edge rather than wanting both on the rail.
  //
  // It grows from the statistics of what the brush has ACTUALLY painted
  // rather than from a threshold anchored on the first pixel, so the
  // result does not depend on precisely where the drag started — the
  // complaint that makes a wand feel unpredictable.
  contributeTool(host, {
    id: QUICK_SELECT_TOOL_ID,
    title: t(TOOL.quickSelection),
    icon: "tool-magic-wand",
    group: MAGIC_WAND_TOOL_ID,
    section: "selection",
    gesture: () => makeSelectionGesture(host, session, "quick"),
  });

  // ── PAINT tools (spec §6.3 — the brush engine's editor reach) ──
  //
  // Three tools over ONE gesture architecture (the selection pattern:
  // gesture → machine → engine doors → overlay affordance). They paint
  // RASTER pixels into the ingested image, which is what distinguishes
  // them from paged.draw's VECTOR Paintbrush / Blob Brush / Eraser on
  // the same rail — hence the "(raster)" in every title. They paint the
  // ACTIVE LAYER of the session's layer stack, and a committed stroke is
  // journaled (undoable, within the stated bound). The exact scope is
  // spelled out in the panel's Brush + Layers sections
  // (BRUSH_SCOPE_NOTE / LAYERS_SCOPE_NOTE), not only here.
  //
  // SHORTCUTS (INV-REG-1, globally unique tool shortcuts): "q" is the
  // last free single letter, and shift+f / shift+e are free in the shift
  // register — verified at pick time against the editor built-ins (v a
  // shift+p u b t shift+t \ p n f m l c e r s o g shift+g i k h z),
  // paged.draw (= - shift+c/u/n/a/m/b/r/j/k/i/d/s/q) and this bundle's
  // own five (shift+x, y, shift+y, shift+l, shift+w). "[" and "]" are
  // deliberately LEFT FREE for brush-size nudging.
  contributeTool(host, {
    id: BRUSH_TOOL_ID,
    ...optionsFor(BRUSH_TOOL_ID),
    title: t(TOOL.brushRaster),
    icon: "tool-paintbrush",
    group: BRUSH_TOOL_ID,
    section: "drawType",
    shortcut: "q",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "brush"),
  });
  contributeTool(host, {
    id: PENCIL_TOOL_ID,
    ...optionsFor(PENCIL_TOOL_ID),
    title: t(TOOL.pencilRaster),
    icon: "tool-pencil",
    group: PENCIL_TOOL_ID,
    section: "drawType",
    shortcut: "shift+f",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "pencil"),
  });
  contributeTool(host, {
    id: ERASER_TOOL_ID,
    ...optionsFor(ERASER_TOOL_ID),
    title: t(TOOL.eraserRaster),
    icon: "tool-erase",
    group: ERASER_TOOL_ID,
    section: "drawType",
    shortcut: "shift+e",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "eraser"),
  });

  // ── RETOUCHING: the two tools that paint FROM the image ──
  //
  // Same gesture, same tip, same spacing/pressure/selection masking as
  // the brush — the entire difference is where the paint layer comes
  // from, which is why the clone stamp needed no new kernel.
  //
  // ALT-CLICK sets the source (Photoshop's convention, handled in the
  // gesture as a separate interaction so the anchor click never paints).
  // The anchor lives on the SESSION, not the stroke, so it survives
  // between strokes — repeated retouching is the normal case.
  //
  // SHORTCUTS: `shift+t` (sTamp) and `j`, the latter matching
  // Photoshop's healing-brush key exactly; both verified free against
  // the editor built-ins and the other plugin manifests at pick time
  // (INV-REG-1 keeps tool shortcuts globally unique).
  contributeTool(host, {
    id: CLONE_TOOL_ID,
    title: t(TOOL.cloneStamp),
    icon: "tool-clone",
    group: CLONE_TOOL_ID,
    section: "drawType",
    shortcut: "shift+t",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "clone"),
  });
  contributeTool(host, {
    id: HEAL_TOOL_ID,
    title: t(TOOL.healingBrush),
    icon: "tool-heal",
    group: HEAL_TOOL_ID,
    section: "drawType",
    shortcut: "j",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "heal"),
  });

  // ── TONING: dodge / burn / sponge ──
  //
  // FILTER STROKES: the same gesture, tip, spacing, pressure and
  // selection masking as the brush, but the dabs deposit no paint — their
  // coverage masks `adjust.dodge_burn` on the layer. They share the clone
  // stamp's rail slot (the retouching slot) and take no shortcut.
  for (const [id, title, tool] of [
    [DODGE_TOOL_ID, TOOL.dodge, "dodge"],
    [BURN_TOOL_ID, TOOL.burn, "burn"],
    [SPONGE_TOOL_ID, TOOL.sponge, "sponge"],
    // Blur / sharpen: the same filter-stroke lane over the unsharp chain;
    // the brush's flow is their strength.
    [BLUR_TOOL_ID, TOOL.blurBrush, "blur"],
    [SHARPEN_TOOL_ID, TOOL.sharpenBrush, "sharpen"],
  ] as const) {
    contributeTool(host, {
      id,
      title: t(title),
      icon: "tool-clone",
      group: CLONE_TOOL_ID,
      section: "drawType",
      cursor: PAINT_CURSOR,
      gesture: () => makeBrushGesture(host, session, tool),
    });
  }

  // SPOT HEALING BRUSH — shares the healing brush's slot; no anchor, no
  // shortcut. The heal lands on release (the engine searches for the
  // source then).
  contributeTool(host, {
    id: SPOT_HEAL_TOOL_ID,
    title: t(TOOL.spotHealingBrush),
    icon: "tool-heal",
    group: HEAL_TOOL_ID,
    section: "drawType",
    cursor: PAINT_CURSOR,
    gesture: () => makeBrushGesture(host, session, "spot-heal"),
  });

  // PATCH — drag the selection onto the area to copy from; it is replaced
  // and healed on release. Shares the healing brush's slot; no shortcut.
  contributeTool(host, {
    id: PATCH_TOOL_ID,
    title: t(TOOL.patch),
    icon: "tool-heal",
    group: HEAL_TOOL_ID,
    section: "drawType",
    gesture: () => makePatchGesture(host, session),
  });

  // GENERATE — the `gen.*` family's editor reach. Fills the CURRENT
  // SELECTION (the whole image when there is none) with a fixed
  // two-stop gradient or with noise, composited through the coverage
  // mask on the GPU. DESTRUCTIVE by design (it swaps the engine-held
  // source like a crop commit) — see fill.rs for why a generator cannot
  // be a re-runnable stage of the adjust chain. The commands carry the
  // defaults (foreground→background linear, noise amount 0.5); the panel's
  // Generate section exposes the pickers.
  command({
    id: "media.paged.image.command.fillSelection",
    title: t(CMD.fillSelectionWithAGradient),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      // Foreground → background, Photoshop's default gradient.
      const { fg, bg } = session.state().colors;
      void session.fillSelection({
        kind: "gradient",
        gradient: "linear",
        c0: [...fg],
        c1: [...bg],
      });
    },
  });
  command({
    id: "media.paged.image.command.fillNoise",
    title: t(CMD.fillSelectionWithNoise),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.fillSelection({ kind: "noise", amount: 0.5 });
    },
  });

  // ── LAYER GRAPH commands (§6.2 — the layer stack's palette reach) ──
  //
  // The panel's Layers section carries the full palette (order,
  // visibility, opacity, blend, lock, the active-layer choice); these
  // are the command-palette reach for the four that deserve a shortcut
  // surface. Undo/redo act on the plugin's OWN pixel journal — paint,
  // fills and bakes on the ingested image — not on the host document's
  // history, which the editor owns and which this plugin never mutates.
  command({
    id: "media.paged.image.command.addLayer",
    title: t(CMD.addImageLayer),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.addLayer();
    },
  });
  // ADD LAYER MASK, Photoshop's two forms. The mask becomes the paint
  // tools' target (the panel's M toggle switches back to pixels).
  for (const [suffix, title, reveal] of [
    ["addLayerMask", CMD.addLayerMaskRevealAll, true],
    ["addLayerMaskHideAll", CMD.addLayerMaskHideAll, false],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(title),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void session.addLayerMask(session.state().layers.active, reveal);
      },
    });
  }
  command({
    id: "media.paged.image.command.bakeAdjustToLayer",
    title: t(CMD.bakeAdjustmentsIntoTheActiveLayer),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.bakeAdjustToLayer();
    },
  });
  command({
    id: "media.paged.image.command.undo",
    title: t(CMD.undoImageEdit),
    category: "Image",
    handler: () => {
      void session.undo();
    },
  });
  command({
    id: "media.paged.image.command.redo",
    title: t(CMD.redoImageEdit),
    category: "Image",
    handler: () => {
      void session.redo();
    },
  });
  // Built engine-side long before anything could reach it: smart
  // objects, pattern fill, shape blur. The panel carries their controls;
  // these are the palette and menu reach.
  // Filters and Image-menu verbs added with the fundamentals.
  for (const [suffix, title, run] of [
    ["median", CMD.median3x3, () => session.applyMedian()],
    ["maximum", CMD.maximum3x3, () => session.applyMorph("max")],
    ["minimum", CMD.minimum3x3, () => session.applyMorph("min")],
    [
      "fillForeground",
      CMD.fillWithTheForegroundColour,
      () => session.fillForeground(),
    ],
    [
      "rotateCw",
      CMD.rotateCanvas90Clockwise,
      () => session.canvasOp("rotate-cw"),
    ],
    [
      "rotateCcw",
      CMD.rotateCanvas90CounterClockwise,
      () => session.canvasOp("rotate-ccw"),
    ],
    ["rotate180", CMD.rotateCanvas180, () => session.canvasOp("rotate-180")],
    [
      "flipHorizontal",
      CMD.flipCanvasHorizontal,
      () => session.canvasOp("flip-h"),
    ],
    ["flipVertical", CMD.flipCanvasVertical, () => session.canvasOp("flip-v")],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(title),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void run();
      },
    });
  }
  // FILTER ▸ … — each one-shot filter opens the generic Filter dialog
  // (live preview on the canvas, OK one undo step, Cancel restores).
  // The table is literal so every command id is readable as written.
  for (const [suffix, id] of [
    ["filterBoxBlur", "boxBlur"],
    ["filterSurfaceBlur", "surfaceBlur"],
    ["filterMotionBlur", "motionBlur"],
    ["filterRadialBlur", "radialBlur"],
    ["filterLensBlur", "lensBlur"],
    ["filterAddNoise", "addNoise"],
    ["filterDespeckle", "despeckle"],
    ["filterDustScratches", "dustScratches"],
    ["filterMedian", "median"],
    ["filterReduceNoise", "reduceNoise"],
    ["filterHighPass", "highPass"],
    ["filterMaximum", "maximum"],
    ["filterMinimum", "minimum"],
    ["filterOffset", "offset"],
    ["filterSmartSharpen", "smartSharpen"],
    ["filterEmboss", "emboss"],
    ["filterFindEdges", "findEdges"],
    ["filterGlowingEdges", "glowingEdges"],
    ["filterMosaic", "mosaic"],
    ["filterHalftone", "halftone"],
    ["filterPaintDaubs", "paintDaubs"],
    ["filterPosterEdges", "posterEdges"],
    ["filterFilmGrain", "filmGrain"],
    ["filterSpatter", "spatter"],
    ["filterCrosshatch", "crosshatch"],
    ["filterBasRelief", "basRelief"],
    ["filterPhotocopy", "photocopy"],
    ["filterStainedGlass", "stainedGlass"],
    ["filterGlass", "glass"],
    ["filterTexturizer", "texturizer"],
    ["filterGradientMap", "gradientMap"],
    ["filterSelectiveColour", "selectiveColour"],
    // WP5.2's families, the Filter Gallery's breadth and its workspace.
    ["filterGallery", "filterGallery"],
    ["filterDisplace", "displace"],
    ["filterPolarCoordinates", "polarCoordinates"],
    ["filterRipple", "ripple"],
    ["filterShear", "shear"],
    ["filterZigzag", "zigzag"],
    ["filterClouds", "clouds"],
    ["filterDifferenceClouds", "differenceClouds"],
    ["filterFibers", "fibers"],
    ["filterLensFlare", "lensFlare"],
    ["filterLightingEffects", "lightingEffects"],
    ["filterWind", "wind"],
    ["filterExtrude", "extrude"],
    ["filterTiles", "tiles"],
    ["filterTraceContour", "traceContour"],
    ["filterCrystallize", "crystallize"],
    ["filterPointillize", "pointillize"],
    ["filterMezzotint", "mezzotint"],
    ["filterColorHalftone", "colorHalftone"],
    ["filterShadowsHighlights", "shadowsHighlights"],
    ["filterHdrToning", "hdrToning"],
    ["filterMatchColor", "matchColor"],
    ["filterReplaceColor", "replaceColor"],
    ["filterDevelop", "develop"],
    ["filterColoredPencil", "coloredPencil"],
    ["filterCutout", "cutout"],
    ["filterDryBrush", "dryBrush"],
    ["filterFresco", "fresco"],
    ["filterNeonGlow", "neonGlow"],
    ["filterPaletteKnife", "paletteKnife"],
    ["filterPlasticWrap", "plasticWrap"],
    ["filterRoughPastels", "roughPastels"],
    ["filterSmudgeStick", "smudgeStick"],
    ["filterSponge", "sponge"],
    ["filterUnderpainting", "underpainting"],
    ["filterWatercolor", "watercolor"],
    ["filterAccentedEdges", "accentedEdges"],
    ["filterAngledStrokes", "angledStrokes"],
    ["filterDarkStrokes", "darkStrokes"],
    ["filterInkOutlines", "inkOutlines"],
    ["filterSprayedStrokes", "sprayedStrokes"],
    ["filterSumiE", "sumiE"],
    ["filterDiffuseGlow", "diffuseGlow"],
    ["filterOceanRipple", "oceanRipple"],
    ["filterChalkCharcoal", "chalkCharcoal"],
    ["filterCharcoal", "charcoal"],
    ["filterChrome", "chrome"],
    ["filterConteCrayon", "conteCrayon"],
    ["filterGraphicPen", "graphicPen"],
    ["filterNotePaper", "notePaper"],
    ["filterPlaster", "plaster"],
    ["filterReticulation", "reticulation"],
    ["filterStamp", "stamp"],
    ["filterTornEdges", "tornEdges"],
    ["filterWaterPaper", "waterPaper"],
    ["filterCraquelure", "craquelure"],
    ["filterGrain", "grain"],
    ["filterMosaicTiles", "mosaicTiles"],
    ["filterPatchwork", "patchwork"],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(CMD.filterDialog, { label: t(filterDef(id).label) }),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void session.openFilterDialog(id);
      },
    });
  }
  // FILTER ▸ BLUR GALLERY ▸ … — the workspace with that blur on.
  for (const [suffix, kind] of [
    ["filterFieldBlur", "field"],
    ["filterIrisBlur", "iris"],
    ["filterTiltShift", "tilt"],
    ["filterPathBlur", "path"],
    ["filterSpinBlur", "spin"],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(CMD.blurGalleryOf, { label: t(BLUR_LABELS[kind]) }),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void session.openBlurGallery(kind);
      },
    });
  }
  // The filters Photoshop runs without a dialog.
  for (const [suffix, label] of [
    ["solarize", ONE_SHOT_LABELS.solarize],
    ["facet", ONE_SHOT_LABELS.facet],
    ["desaturate", ONE_SHOT_LABELS.desaturate],
    ["equalize", ONE_SHOT_LABELS.equalize],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(CMD.oneShotFilter, { label: t(label) }),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void session.applyOneShot(suffix);
      },
    });
  }
  // CURVES ▸ targeted adjustment (I-55): arm it on the composite curve;
  // the panel's curve editor arms it on the curve it shows.
  command({
    id: "media.paged.image.command.curvesTarget",
    title: t(CMD.curvesTarget),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      session.armCurvesTarget(
        "rgb",
        session.state().curvesTarget?.points ?? [
          [0, 0],
          [1, 1],
        ],
      );
    },
  });
  command({
    id: "media.paged.image.command.average",
    title: t(CMD.averageBlur),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.applyAverage();
    },
  });
  // IMAGE ▸ Image Size / Trim / Image Rotation ▸ Arbitrary — dialogs on
  // top of the Image panel.
  for (const [suffix, title, kind] of [
    ["imageSize", CMD.imageSize, "imageSize"],
    ["trim", CMD.trim, "trim"],
    ["rotateArbitrary", CMD.rotateArbitrary, "rotate"],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(title),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        session.openDialog(kind);
      },
    });
  }
  // LAYER ▸ New Fill Layer / New Adjustment Layer and the Layer menu's
  // verbs (Photoshop parity, WP5.3). Each is one undo step in the image's
  // own history; the tables are literal so every command id reads as
  // written.
  for (const [suffix, title, run] of [
    ["newFillSolid", CMD.newFillSolid, () => session.addFillLayer("solid")],
    [
      "newFillGradient",
      CMD.newFillGradient,
      () => session.addFillLayer("gradient"),
    ],
    [
      "newFillPattern",
      CMD.newFillPattern,
      () => session.addFillLayer("pattern"),
    ],
    [
      "blendingOptions",
      CMD.blendingOptions,
      () => session.openBlendingOptions(),
    ],
    [
      "rasterizeLayer",
      CMD.rasterizeLayer,
      () => session.rasterizeLayer(session.state().layers.active),
    ],
    ["layerViaCopy", CMD.layerViaCopy, () => session.layerViaCopy()],
    ["layerViaCut", CMD.layerViaCut, () => session.layerViaCut()],
    ["mergeDown", CMD.mergeDown, () => session.mergeDown()],
    ["mergeVisible", CMD.mergeVisible, () => session.mergeVisible()],
    ["mergeGroup", CMD.mergeGroup, () => session.mergeGroup()],
    ["stampVisible", CMD.stampVisible, () => session.stampVisible()],
    ["flattenImage", CMD.flattenImage, () => session.flattenImage()],
    ["alignLeft", CMD.alignLeft, () => session.alignLayers("left")],
    ["alignHCenter", CMD.alignHCenter, () => session.alignLayers("hcenter")],
    ["alignRight", CMD.alignRight, () => session.alignLayers("right")],
    ["alignTop", CMD.alignTop, () => session.alignLayers("top")],
    ["alignVCenter", CMD.alignVCenter, () => session.alignLayers("vcenter")],
    ["alignBottom", CMD.alignBottom, () => session.alignLayers("bottom")],
    [
      "distributeHorizontal",
      CMD.distributeHorizontal,
      () => session.distributeLayers("horizontal"),
    ],
    [
      "distributeVertical",
      CMD.distributeVertical,
      () => session.distributeLayers("vertical"),
    ],
    [
      "linkLayers",
      CMD.linkLayers,
      () => {
        const a = session.state().layers.active;
        return a > 0 ? session.linkLayers([a - 1, a]) : false;
      },
    ],
    [
      "unlinkLayer",
      CMD.unlinkLayer,
      () => session.unlinkLayer(session.state().layers.active),
    ],
    ["newLayerComp", CMD.newLayerComp, () => session.newLayerComp()],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(title),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void run();
      },
    });
  }
  for (const [suffix, kind] of [
    ["newAdjustmentBrightnessContrast", "brightnessContrast"],
    ["newAdjustmentLevels", "levels"],
    ["newAdjustmentCurves", "curves"],
    ["newAdjustmentExposure", "exposure"],
    ["newAdjustmentVibrance", "vibrance"],
    ["newAdjustmentHueSaturation", "hueSaturation"],
    ["newAdjustmentColorBalance", "colorBalance"],
    ["newAdjustmentBlackWhite", "blackWhite"],
    ["newAdjustmentPhotoFilter", "photoFilter"],
    ["newAdjustmentChannelMixer", "channelMixer"],
    ["newAdjustmentColorLookup", "colorLookup"],
    ["newAdjustmentInvert", "invert"],
    ["newAdjustmentPosterize", "posterize"],
    ["newAdjustmentThreshold", "threshold"],
    ["newAdjustmentGradientMap", "gradientMap"],
    ["newAdjustmentSelectiveColor", "selectiveColor"],
    ["newAdjustmentDevelop", "develop"],
  ] as const) {
    command({
      id: `media.paged.image.command.${suffix}`,
      title: t(CMD.newAdjustment, { kind: adjustmentKindLabel(kind) }),
      category: "Image",
      handler: () => {
        host.shell.openPanel(PANEL_ID);
        void session.addAdjustmentLayerOf(kind);
      },
    });
  }
  command({
    id: "media.paged.image.command.commitImage",
    title: t(CMD.commitImageEditsToTheDocument),
    category: "Image",
    handler: () => {
      void session.commitToDocument();
    },
  });
  command({
    id: "media.paged.image.command.convertLayerToSmart",
    title: t(CMD.convertActiveLayerToSmartObject),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.makeLayerSmart(session.state().layers.active);
    },
  });
  command({
    id: "media.paged.image.command.definePattern",
    title: t(CMD.definePatternFromSelectionImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      session.definePattern();
    },
  });
  command({
    id: "media.paged.image.command.fillPattern",
    title: t(CMD.fillSelectionWithTheDefinedPattern),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.fillWithPattern();
    },
  });
  command({
    id: "media.paged.image.command.shapeBlur",
    title: t(CMD.shapeBlurDefinedPatternAsTheShape),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.shapeBlurWithPattern();
    },
  });

  // SAVE-BACK — bake the adjustments into the SOURCE FILE's bytes.
  //
  // DELIVERY SEAM. This used to read "the host wires NO save-file door",
  // and that stopped being true when K-10 landed `shell.saveFile@1` in
  // the contract — with paged.image named as its consumer. The bundle
  // nevertheless kept staging bytes for the Export Center, so a door
  // added for this plugin went uncalled: the gap had moved from the
  // contract into this file without anyone noticing, which is what a
  // comment stating a fact about someone ELSE's code will eventually do.
  //
  // Now: `applyToFile` COMPUTES and STAGES (reporting size + the honest
  // layer-structure note) and `saveToFile` hands the bytes to the host's
  // saver, PROBED rather than assumed — without the probe the door's
  // `false` would be indistinguishable from a user cancel. The exporters
  // below remain the delivery lane for a host with no saver.
  command({
    id: "media.paged.image.command.applyToFile",
    title: t(CMD.applyAdjustmentsToTheFile),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.applyToFile();
    },
  });

  command({
    id: "media.paged.image.command.saveToFile",
    title: t(CMD.saveTheAdjustedFile),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.saveToFile();
    },
  });

  // BRUSH PRESETS — the `.abr` reader's only caller, and the reason it
  // survives dead-code elimination in the shipped wasm at all. Reads
  // through `shell.pickFile@1` (the same READ door the importer uses);
  // `.abr` carries parameters, not pixels, so nothing is ingested and
  // no handle is retained.
  command({
    id: "media.paged.image.command.loadBrushLibrary",
    title: t(CMD.loadBrushLibraryAbr),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.pickBrushLibrary();
    },
  });

  // RASTER ↔ VECTOR — the conversion pair the "Paths / shapes" catalog
  // row priced as missing. The vector side stays host-owned; these are
  // only the bridge.
  command({
    id: "media.paged.image.command.selectionToPath",
    title: t(CMD.selectionToPathImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.selectionToPath();
    },
  });
  command({
    id: "media.paged.image.command.pathToSelection",
    title: t(CMD.pathToSelectionImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.selectionFromPath();
    },
  });
  command({
    id: "media.paged.image.command.channelToSelection",
    title: t(CMD.luminosityChannelToSelectionImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      session.selectionFromChannel("luma");
    },
  });

  // ── RASTER TYPE ──
  //
  // A click sets the BASELINE origin and the panel's Type section
  // supplies the string, family and size. Deliberately a click and not a
  // drag: this paints a run at a point, it does not author a text BOX —
  // the host's text frame is the thing that does that, and it is better
  // at it.
  //
  // SHORTCUT: `shift+z`, the only free slot in the shift register. `t`
  // (Photoshop's type key) is taken by the host's own type tool, and the
  // free single letters (d/i/k/w/x) are all Photoshop-meaningful for
  // something else — leaving them free is politer than taking one for a
  // plugin tool. Verified against the editor built-ins and every plugin
  // manifest at pick time, as INV-REG-1 requires; the first pick was
  // `shift+u` and it COLLIDED, which the check caught.
  contributeTool(host, {
    id: TYPE_TOOL_ID,
    title: t(TOOL.typeRaster),
    icon: "tool-type",
    group: TYPE_TOOL_ID,
    section: "drawType",
    shortcut: "shift+z",
    // Tracked here because the CONTRACT HAS NO DOOR for it: a bundle
    // can contribute a tool but cannot ask the host which tool is
    // active. The ADR-023 Character provider needs exactly that — its
    // answers are only meaningful while the type tool is in hand — so
    // the flag is kept from the gesture's own activation, which the
    // plugin does own. Filed as an RFI gap; this is the local answer,
    // not a preferred one.
    gesture: () => {
      const g = makeTypeGesture(host, session);
      return {
        ...g,
        onActivate(paged) {
          typeToolActive = true;
          g.onActivate?.(paged);
        },
        onDeactivate(reason) {
          typeToolActive = false;
          g.onDeactivate?.(reason);
        },
      };
    },
  });

  command({
    id: "media.paged.image.command.setType",
    title: t(CMD.setTypeImage),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
    },
  });

  command({
    id: "media.paged.image.command.contentAwareFill",
    title: t(CMD.contentAwareFill),
    category: "Image",
    handler: () => {
      host.shell.openPanel(PANEL_ID);
      void session.fillSelection({ kind: "contentAware" });
    },
  });

  // Selection commands (the panel buttons + command-palette reach).
  command({
    id: "media.paged.image.command.selectAll",
    title: t(CMD.selectAllImage),
    category: "Image",
    handler: () => {
      session.selectAll();
    },
  });
  command({
    id: "media.paged.image.command.deselect",
    title: t(CMD.deselectImage),
    category: "Image",
    handler: () => {
      session.deselect();
    },
  });
  command({
    id: "media.paged.image.command.invertSelection",
    title: t(CMD.invertSelectionImage),
    category: "Image",
    handler: () => {
      session.invertSelection();
    },
  });
  // Fixed v0 sigma (session FEATHER_SIGMA_DEFAULT) — a slider follows.
  command({
    id: "media.paged.image.command.featherSelection",
    title: t(CMD.featherSelectionImage),
    category: "Image",
    handler: () => {
      session.featherSelection();
    },
  });

  // K-2 — the raster importer: opening/dropping a PSD/PNG/JPEG routes
  // its bytes HERE (decode into the session, raise the panel; it does
  // NOT replace the document). Degrades honestly on an older host.
  if (host.supports("contribute.importer@1")) {
    host.contribute.importer({
      id: "media.paged.image.importer.raster",
      title: t(IO.imagePsdPngJpeg),
      extensions: [".psd", ".psb", ".png", ".jpg", ".jpeg"],
      mimeTypes: ["image/vnd.adobe.photoshop", "image/png", "image/jpeg"],
      import: async ({ name, bytes }) => {
        host.shell.openPanel(PANEL_ID);
        await session.importBytes(name, bytes);
      },
    });
  }
  // SAVE-BACK exporters — the delivery lane for the adjusted pixels.
  //
  // PSD: re-emits the (possibly layer-edited) PSD with full
  // carry-through preservation. When the panel is at IDENTITY the bytes
  // are the untouched re-emit (zero-edit ⇒ BYTE-IDENTICAL — §10.4
  // survives); when it is not, the full-resolution adjusted composite is
  // written first (`replace_channel_pixels` on the single canvas-sized
  // content layer, else a flatten into a new single-layer PSD, which the
  // panel/status announces). Null when no PSD is loaded — the Export
  // Center shows the honest empty result.
  //
  // PNG / JPEG: the non-PSD lane, one exporter per format so the
  // registry's declared `extension` is never a lie. The panel's "Apply
  // to file" button picks the source's own format (JPEG only when the
  // ingested bytes WERE a JPEG — a re-encode never invents a lossy
  // format); these two let the user ask for either explicitly.
  if (host.supports("contribute.exporter@1")) {
    host.contribute.exporter({
      id: "media.paged.image.exporter.psd",
      title: t(IO.psdAdjustedPixelsEditedLayers),
      extension: ".psd",
      mimeType: "image/vnd.adobe.photoshop",
      export: () => session.psdExportBytes(),
    });
    host.contribute.exporter({
      id: "media.paged.image.exporter.png",
      title: t(IO.pngAdjustedPixels),
      extension: ".png",
      mimeType: "image/png",
      export: () => session.rasterExportBytes("png"),
    });
    host.contribute.exporter({
      id: "media.paged.image.exporter.jpeg",
      title: t(IO.jpegAdjustedPixels),
      extension: ".jpg",
      mimeType: "image/jpeg",
      export: () => session.rasterExportBytes("jpeg"),
    });
  }

  // ── the rasterImage edit context (ADR-023 / K-13) ────────────────
  //
  // WHY THIS EXISTS AT ALL: a binding provider is consulted only while
  // the edit context it registered against is ACTIVE — it borrows that
  // context's activation rather than inventing a second notion of "who
  // is active". paged.image had no context, so it could serve no host
  // panel; this is the thing the ADR-023 providers below stand on.
  //
  // ENTRY IS DOUBLE-CLICK, and that is a PRODUCT rule rather than a
  // local choice (plugin-sdk DESIGN.md §19). Every plugin that exposes
  // content to the canvas is entered the same way — vector group,
  // spreadsheet, web frame, Word document, raster image — so a user
  // learns the gesture once. paged.image would technically prefer to
  // activate on "I hold this frame", which it knows from its own ingest
  // and not from a gesture; it takes the frame boundary anyway and
  // narrows by DECLINING in the providers, which the binding contract
  // models properly.
  // SAVING THE DOCUMENT keeps the image: edits not yet committed are
  // committed first (the host waits for this, bounded), so a save never
  // writes a document that drops what the frame shows.
  const toolSettingsSub = bindToolSettings(host, session, {
    [BRUSH_TOOL_ID]: "brush",
    [PENCIL_TOOL_ID]: "brush",
    [ERASER_TOOL_ID]: "brush",
    [MAGIC_WAND_TOOL_ID]: "wand",
    [BUCKET_TOOL_ID]: "wand",
    [GRADIENT_TOOL_ID]: "gradient",
    [EYEDROPPER_TOOL_ID]: "eyedropper",
    [COLOR_SAMPLER_TOOL_ID]: "eyedropper",
  });
  const willSave = host.supports("document.onWillSave@1")
    ? host.document.onWillSave(async () => {
        if (session.state().uncommitted) await session.commitToDocument();
      })
    : null;

  if (host.supports("contribute.editContext@1")) {
    host.contribute.editContext({
      // The Edit menu reads "Undo <step>".
      undoLabel: () => session.state().history?.undoLabel ?? null,
      redoLabel: () => session.state().history?.redoLabel ?? null,
      type: "rasterImage",
      entry: "doubleClick",
      // Claimed by OUR OWN METADATA, never by kind. The candidate is a
      // pure snapshot (id / kind / groupChain / this plugin's envelope)
      // and cannot be asked "does this rectangle hold placed raster
      // bytes?" — so matching on kind would claim every rectangle in
      // the document and steal a gesture that belongs to the host. The
      // marker is written at ingest (session `stampOwnership`).
      matches: (c) => c.metadata !== null,
      // THE SURFACE FOLLOWS THE CONTEXT. Inside a raster frame the
      // editing surface should be the RASTER one — its tools, its
      // panel, and (through the binding providers below) its layers.
      // A context that changes what you are editing without changing
      // what you are editing it WITH is only half a context.
      //
      // This is not a trap: the rail treats a non-context tool as an
      // EXIT rather than a dead end (ToolRail commits the context, then
      // activates), so picking the host's pointer walks you back out.
      // Order matters — `toolIds[0]` is the tool the shell focuses on
      // entry, and brush is the one a user who just double-clicked an
      // image almost always wants.
      toolIds: [
        BRUSH_TOOL_ID,
        PENCIL_TOOL_ID,
        ERASER_TOOL_ID,
        CLONE_TOOL_ID,
        HEAL_TOOL_ID,
        TYPE_TOOL_ID,
        MARQUEE_RECT_TOOL_ID,
        MARQUEE_ELLIPSE_TOOL_ID,
        LASSO_TOOL_ID,
        MAGIC_WAND_TOOL_ID,
        CROP_TOOL_ID,
        MOVE_TOOL_ID,
        BUCKET_TOOL_ID,
        GRADIENT_TOOL_ID,
        RED_EYE_TOOL_ID,
        EYEDROPPER_TOOL_ID,
        COLOR_SAMPLER_TOOL_ID,
        DODGE_TOOL_ID,
        BURN_TOOL_ID,
        SPONGE_TOOL_ID,
        BLUR_TOOL_ID,
        SHARPEN_TOOL_ID,
        SPOT_HEAL_TOOL_ID,
        PATCH_TOOL_ID,
      ],
      // The context's OWN panel. Deliberately NOT the host panels it
      // serves (Layers, Character) — naming those here would put host
      // panel IDs in plugin code, the exact coupling ADR-023 removed
      // from the value lane, and the host already infers "serves" from
      // `provides` to decide whether to withhold a raise.
      panelIds: [PANEL_ID],
      onEnter: () => {
        host.log.debug("rasterImage context entered");
      },
      onExit: () => {
        host.log.debug("rasterImage context exited");
        // Leaving the image hands its edits to the document.
        if (session.state().uncommitted) void session.commitToDocument();
      },
      onCommit: () => {
        if (session.state().uncommitted) void session.commitToDocument();
      },
      // HOST UNDO (ADR 012, the in-context tier). While the context is
      // active, Cmd+Z / Shift+Cmd+Z and Edit ▸ Undo/Redo step the image's
      // OWN journal instead of the document's — the document has not
      // changed, the pixels have. The host does NOT fall through to the
      // document's undo mid-session (ADR 012: the boundary is entering
      // and leaving the context), so `onCanUndo` answering false greys
      // Undo out rather than reaching the document; leaving the image
      // (which commits it) is what hands undo back. The step itself is
      // async (a recomposite); the hook only has to say it took it.
      onCanUndo: () => session.state().history?.canUndo ?? false,
      onCanRedo: () => session.state().history?.canRedo ?? false,
      onUndo: () => {
        if (!session.state().history?.canUndo) return false;
        void session.undo();
        return true;
      },
      onRedo: () => {
        if (!session.state().history?.canRedo) return false;
        void session.redo();
        return true;
      },
    });

    // ADR-023 phase D — the two providers that make the HOST panels
    // show RASTER content while this context is active.
    //
    // Registered INSIDE the editContext branch on purpose, following
    // paged.sheet: a provider's lifetime is BORROWED from the context's
    // enter/exit, so a host that cannot host the context must not get a
    // provider either. The door is probed separately and degrades to
    // "no provider" — on a pre-ADR host the panels keep reading core,
    // which is the old behaviour and not a failure.
    if (host.supports("contribute.bindingProvider@1")) {
      // LAYERS — the collection axis. The host Layers panel shows the
      // RASTER stack (groups as tree rows) instead of the document's,
      // which is ADR 024's rule for a plugin content type.
      providerHandles.push(
        host.contribute.bindingProvider(
          "rasterImage",
          makeLayersBindingProvider(session).provider,
        ),
      );
      // CHARACTER — the value axis, and the first provider anywhere
      // with a non-empty `writablePaths` (see its module header).
      providerHandles.push(
        host.contribute.bindingProvider(
          "rasterImage",
          makeTextBindingProvider(session, () =>
            typeToolActive ? TYPE_TOOL_ID : null,
          ).provider,
        ),
      );
      // COLOUR (WP4.10) — the host Color panel's fill / stroke wells are
      // the foreground / background, and a host swatch picks one.
      providerHandles.push(
        host.contribute.bindingProvider(
          "rasterImage",
          makeColorBindingProvider(host, session).provider,
        ),
      );
      // A provider's values change without an ENGINE mutation — a layer
      // toggled inside the plugin's own wasm stack moves nothing on the
      // document, so `host.document.onDidChange` never fires and a
      // panel bound through the seam would show a stale row until
      // something unrelated happened. The handle's own invalidate is
      // the signal for exactly this.
      providerInvalidate = session.onDidChange(() => {
        for (const h of providerHandles) h.invalidate?.();
      });
    }
  }

  // The probe behind the save-back delivery seam (see the applyToFile
  // command): `shell.pickFile@1` is the only file door the contract has,
  // and it READS. Logged, not assumed — if a save door ever appears the
  // log line is the first place the gap stops being true.
  host.log.debug(
    `save-back delivery: exporter registry only (shell.pickFile@1=${host.supports(
      "shell.pickFile@1",
    )} is a READ picker; no save-file door in the contract)`,
  );

  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);

  // F1 — the menu bar. 23 commands and, before plugin-api 0.2.33, no
  // route to one: a raster editor's whole vocabulary lived in Cmd+K.
  const menuSub = contributeMenu(host);

  // ADR 323 — the layer stacks as addressable, typed objects (headless:
  // no edit context, no GPU), plus a typed twin of every command above.
  const objectModel = contributeImageObjectModel(
    host,
    untyped,
    undefined,
    () => session.state().source !== null,
    (frameId, record) => session.liveSelection(frameId, record),
    (frameId, from, to, ops) => session.followCanvasOps(frameId, from, to, ops),
  );
  // ADR 323 — the layer stack's properties as host-rendered PropertyFields
  // (a schema panel of property rows; needs the object model + bindings).
  const propertiesSchema = imagePropertiesPanel();
  const propertyLists =
    objectModel && host.supports("contribute.schemaPanel@1")
      ? (contributeSchemaPanel(host, {
          id: PROPERTIES_PANEL_ID,
          title: propertiesSchema.title,
          icon: propertiesSchema.icon,
          defaultDock: "right",
          schema: propertiesSchema,
        }),
        publishPropertyLists(host))
      : null;

  // PM-0015 — the CPU-lane steps over an encoded picture as actions
  // (actions@1, extensions ADR 344), for data's asset columns and scripts.
  const actionsSub = registerImageActions(host);

  return {
    dispose() {
      actionsSub?.dispose();
      // Providers first, then the subscription that feeds them, then
      // the session they read. Reverse registration order: a handle
      // disposed after its session would be a live provider over a
      // closed engine for however long the host takes to notice.
      propertyLists?.dispose();
      objectModel?.handle.dispose();
      objectModel?.objects.dispose();
      providerInvalidate?.dispose();
      willSave?.dispose();
      toolSettingsSub?.dispose();
      menuSub.dispose();
      providerInvalidate = null;
      for (const h of providerHandles.splice(0)) h.dispose();
      session.dispose();
    },
  };
}

export { manifest, PANEL_ID };
