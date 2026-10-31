// SELECTION AND MASKING in the image session (image ADR 470, WP5.5): the
// Color Range dialog, Grow / Similar, Focus Area, the Select and Mask
// workspace, Quick Mask, the Channels and Paths panels and the display
// view. The session owns one controller (`session.masking()`); the
// controller holds only dialog state — channels, paths and the selection
// itself are engine state, and every change to them is one undo step on
// the image's undo list.

import { defineMessages, t } from "@paged-media/strings";

import type { ImageEngine } from "./engine";
import {
  COLOR_RANGE_DEFAULTS,
  defaultColorRange,
  defaultRefine,
  MAGNETIC_DEFAULTS,
  type ColorRangeOptions,
  type DisplayView,
  type MagneticOptions,
  type MaskingInfo,
  type MaskMode,
  type MatteView,
  type RefineOptions,
  type RefineOutput,
} from "./masking-engine";

export const MK = defineMessages("image.masking", {
  noImage: "Open an image first (double-click an image frame).",
  noSelection: "Make a selection first.",
  failed: "{what} failed: {error}",
  colorRange: "Color Range",
  colorRangeApplied: "Color Range: {percent}% of the image selected.",
  outOfGamut:
    "Out of Gamut needs a soft-proofing CMYK profile, which the image module's colour settings do not have yet.",
  grown: "Grow: {percent}% of the image selected.",
  similar: "Similar: {percent}% of the image selected.",
  focusArea: "Focus Area: {percent}% of the image selected.",
  quickMaskOn:
    "Quick Mask on: paint with the brushes — white selects, black masks. Toggle Quick Mask again to turn the paint into the selection.",
  quickMaskOff: "Quick Mask off: the painted mask is the selection.",
  savedSelection: "Selection saved as channel “{name}”.",
  loadedSelection: "Channel “{name}” loaded as the selection.",
  channelDeleted: "Channel deleted.",
  pathMade: "Work path “{name}” made from the selection.",
  pathSelected: "Path “{name}” loaded as the selection.",
  refineOpen:
    "Select and Mask: adjust the edge, paint with the Refine Edge brush, then choose OK.",
  refineDone: "Select and Mask: output to {output}.",
  refineCancelled: "Select and Mask cancelled; the selection is unchanged.",
  matting:
    "No matting model is installed; the classical colour solve refines the edge.",
  refineFirst:
    "The Refine Edge brush works inside Select and Mask — choose Select ▸ Select and Mask first.",
  noChannel: "Save a selection as a channel first.",
});

/** A matting provider (WP8.2 fills this door): given the image and the
 *  trimap (0 background, 128 unknown, 255 foreground), an alpha per
 *  pixel, or null to leave the classical solve in charge. */
export interface MattingProvider {
  solve(
    rgba: Uint8Array,
    width: number,
    height: number,
    trimap: Uint8Array,
  ): Promise<Uint8Array | null>;
}

export interface MaskingUiState {
  info: MaskingInfo;
  view: DisplayView;
  /** The Color Range dialog (null when closed). */
  colorRange: {
    opts: ColorRangeOptions;
    /** The preview coverage, one byte per pixel of the image. */
    preview: Uint8Array | null;
    /** The selection preview on the canvas. */
    canvasPreview: "none" | MatteView;
  } | null;
  focusArea: {
    range: number;
    noise: number;
    preview: Uint8Array | null;
  } | null;
  /** The Select and Mask workspace (null when closed). */
  refine: {
    opts: RefineOptions;
    view: MatteView;
    opacity: number;
    output: RefineOutput;
    brushRadius: number;
    alpha: Uint8Array | null;
  } | null;
  magnetic: MagneticOptions;
  /** Select ▸ Load Selection's dialog (null when closed). */
  load: { channel: number; mode: MaskMode; invert: boolean } | null;
}

export interface MaskingDeps {
  engine(): ImageEngine | null;
  source(): { handle: number; width: number; height: number } | null;
  setStatus(s: string): void;
  emit(): void;
  refreshSelection(): void;
  /** The stack changed what it shows (a mask, a new layer): re-fold. */
  recomposite(): Promise<boolean>;
  /** Put the composite back in the frame through the current view. */
  redisplay(): Promise<boolean>;
  /** The channels / paths changed: the session has uncommitted edits. */
  markEdited(): void;
  wand(): { tolerance: number; contiguous: boolean };
}

const EMPTY: MaskingInfo = {
  channels: [],
  paths: [],
  quickMask: null,
  editChannel: null,
};

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export interface MaskingController {
  state(): MaskingUiState;
  /** The engine the doors run on (null before an image is open). */
  engine(): ImageEngine | null;
  /** Re-read the channels and paths (after an undo, an ingest). */
  refresh(): void;
  setView(view: DisplayView): Promise<boolean>;

  openColorRange(): boolean;
  setColorRange(patch: Partial<ColorRangeOptions>): Promise<boolean>;
  /** An eyedropper click at an image pixel: `replace` the samples, `add`
   *  one, or `subtract` (drop the samples near that colour). */
  sampleColorRange(
    x: number,
    y: number,
    how: "replace" | "add" | "subtract",
  ): Promise<boolean>;
  setColorRangePreview(mode: "none" | MatteView): Promise<boolean>;
  colorRangeOk(mode?: MaskMode): Promise<boolean>;
  colorRangeCancel(): Promise<boolean>;

  grow(): boolean;
  similar(): boolean;

  openFocusArea(): boolean;
  setFocusArea(patch: { range?: number; noise?: number }): Promise<boolean>;
  focusAreaOk(mode?: MaskMode): Promise<boolean>;
  focusAreaCancel(): Promise<boolean>;

  toggleQuickMask(): Promise<boolean>;

  saveSelection(name?: string): boolean;
  loadSelection(id: number, mode?: MaskMode, invert?: boolean): boolean;
  deleteChannel(id: number): boolean;
  renameChannel(id: number, name: string): boolean;
  duplicateChannel(id: number): boolean;
  newSpotChannel(
    name: string,
    colour: [number, number, number],
    solidity: number,
  ): boolean;
  setSpot(
    id: number,
    colour: [number, number, number],
    solidity: number,
  ): boolean;
  /** Paint a channel with the brushes (`null`: the layers again). */
  editChannel(id: number | null): boolean;

  pathFromSelection(name?: string, tolerance?: number): boolean;
  makeSelectionFromPath(id: number, feather?: number, mode?: MaskMode): boolean;
  deletePath(id: number): boolean;
  renamePath(id: number, name: string): boolean;
  duplicatePath(id: number): boolean;

  openRefine(): Promise<boolean>;
  setRefine(patch: Partial<RefineOptions>): Promise<boolean>;
  setRefineView(view: MatteView, opacity?: number): Promise<boolean>;
  setRefineOutput(output: RefineOutput): void;
  setRefineBrush(radius: number): void;
  /** The Refine Edge brush at an image point (`erase`: Alt). */
  refineBrush(x: number, y: number, erase: boolean): Promise<boolean>;
  refineOk(): Promise<boolean>;
  refineCancel(): Promise<boolean>;
  setMattingProvider(p: MattingProvider | null): void;
  /** Say where the Refine Edge brush works (a click outside the
   *  workspace). */
  refineHint(): void;

  /** Select ▸ Load Selection's dialog. */
  openLoadSelection(): boolean;
  setLoadSelection(patch: {
    channel?: number;
    mode?: MaskMode;
    invert?: boolean;
  }): void;
  loadSelectionOk(): boolean;
  loadSelectionCancel(): void;

  magneticOptions(): MagneticOptions;
  setMagneticOptions(o: Partial<MagneticOptions>): void;
}

export function createMaskingController(deps: MaskingDeps): MaskingController {
  const ui: MaskingUiState = {
    info: EMPTY,
    view: { kind: "composite" },
    colorRange: null,
    focusArea: null,
    refine: null,
    magnetic: { ...MAGNETIC_DEFAULTS },
    load: null,
  };
  let matting: MattingProvider | null = null;

  /** Run `f` against the engine and the bound image; a refusal becomes
   *  the status line, named. */
  const run = <T>(
    what: string,
    f: (e: ImageEngine, src: { width: number; height: number }) => T,
  ): T | null => {
    const e = deps.engine();
    const src = deps.source();
    if (!e || !src) {
      deps.setStatus(t(MK.noImage));
      return null;
    }
    try {
      return f(e, src);
    } catch (err) {
      deps.setStatus(t(MK.failed, { what, error: errText(err) }));
      return null;
    }
  };

  const refresh = () => {
    const e = deps.engine();
    try {
      ui.info = e && deps.source() ? e.maskingList() : EMPTY;
    } catch {
      ui.info = EMPTY;
    }
  };

  const percent = () => {
    const e = deps.engine();
    const s = e?.selectionStats();
    return s ? Math.round(s.coverage * 1000) / 10 : 0;
  };

  /** After a selection step: re-read, say what happened. */
  const selected = (msg: string) => {
    deps.refreshSelection();
    refresh();
    deps.setStatus(t(msg, { percent: percent() }));
    return true;
  };

  /** After a channel / path step. */
  const changed = (msg?: string, vars?: Record<string, string | number>) => {
    refresh();
    deps.markEdited();
    if (msg) deps.setStatus(t(msg, vars));
    else deps.emit();
    return true;
  };

  const applyView = async (view: DisplayView): Promise<boolean> => {
    const e = deps.engine();
    if (!e) return false;
    try {
      e.viewSet(view);
    } catch (err) {
      deps.setStatus(t(MK.failed, { what: "View", error: errText(err) }));
      return false;
    }
    ui.view = view;
    deps.emit();
    return deps.redisplay();
  };

  const nameOf = (id: number) =>
    ui.info.channels.find((c) => c.id === id)?.name ??
    ui.info.paths.find((p) => p.id === id)?.name ??
    String(id);

  // ── Color Range ──────────────────────────────────────────────────

  const colorRangePreview = async (): Promise<boolean> => {
    const cr = ui.colorRange;
    const e = deps.engine();
    const src = deps.source();
    if (!cr || !e || !src) return false;
    if (cr.opts.select === "outOfGamut") {
      cr.preview = null;
      deps.setStatus(t(MK.outOfGamut));
      return false;
    }
    if (cr.opts.select === "sampled" && cr.opts.samples.length === 0) {
      cr.preview = new Uint8Array(src.width * src.height);
      deps.emit();
      return true;
    }
    try {
      cr.preview = await e.colorRangePreview(cr.opts, src.width, src.height);
    } catch (err) {
      deps.setStatus(
        t(MK.failed, { what: t(MK.colorRange), error: errText(err) }),
      );
      return false;
    }
    deps.emit();
    if (cr.canvasPreview !== "none") return deps.redisplay();
    return true;
  };

  // ── Select and Mask ──────────────────────────────────────────────

  const refinePreview = async (): Promise<boolean> => {
    const r = ui.refine;
    const e = deps.engine();
    const src = deps.source();
    if (!r || !e || !src) return false;
    try {
      e.samSetParams(r.opts);
      if (matting) {
        const rgba = e.tile(src.handle, 0, 0, src.width, src.height);
        const alpha = await matting.solve(
          rgba,
          src.width,
          src.height,
          e.samTrimap(),
        );
        e.samSetMatte(alpha);
      }
      r.alpha = e.samPreview();
    } catch (err) {
      deps.setStatus(
        t(MK.failed, { what: "Select and Mask", error: errText(err) }),
      );
      return false;
    }
    deps.emit();
    return deps.redisplay();
  };

  const closeRefine = async () => {
    ui.refine = null;
    await applyView({ kind: "composite" });
  };

  return {
    // A fresh snapshot per read: the controller mutates `ui` in place, and
    // a render memoized on an unchanged identity would show stale state.
    state: () => ({
      ...ui,
      colorRange: ui.colorRange && {
        ...ui.colorRange,
        opts: { ...ui.colorRange.opts },
      },
      focusArea: ui.focusArea && { ...ui.focusArea },
      refine: ui.refine && { ...ui.refine, opts: { ...ui.refine.opts } },
      load: ui.load && { ...ui.load },
      magnetic: { ...ui.magnetic },
    }),
    engine: () => (deps.source() ? deps.engine() : null),
    refresh() {
      refresh();
      deps.emit();
    },
    setView: (view) => applyView(view),

    openColorRange() {
      if (!deps.engine() || !deps.source()) {
        deps.setStatus(t(MK.noImage));
        return false;
      }
      ui.colorRange = {
        opts: ui.colorRange?.opts ?? defaultColorRange(),
        preview: null,
        canvasPreview: "none",
      };
      deps.emit();
      return true;
    },
    async setColorRange(patch) {
      const cr = ui.colorRange;
      if (!cr) return false;
      const next = { ...cr.opts, ...patch };
      // A tonal preset brings its own defaults when chosen.
      if (patch.select && patch.select !== cr.opts.select) {
        const d =
          COLOR_RANGE_DEFAULTS[
            patch.select as keyof typeof COLOR_RANGE_DEFAULTS
          ];
        if (d) Object.assign(next, d, patch);
        else if (patch.fuzziness === undefined && cr.opts.select !== "sampled")
          next.fuzziness = 40;
      }
      cr.opts = next;
      return colorRangePreview();
    },
    async sampleColorRange(x, y, how) {
      const cr = ui.colorRange;
      if (!cr) return false;
      const lab = run(t(MK.colorRange), (e) =>
        e.colorRangeSample(Math.floor(x), Math.floor(y)),
      );
      if (!lab) return false;
      const sample = { lab, x: x, y: y };
      let samples = cr.opts.samples;
      if (how === "replace") samples = [sample];
      else if (how === "add") samples = [...samples, sample].slice(-8);
      else {
        // The minus eyedropper drops the samples within the fuzziness's
        // reach of the clicked colour (the box model has no holes).
        const reach = Math.max(cr.opts.fuzziness / 3, 1);
        samples = samples.filter(
          (s) =>
            Math.max(
              0.85 * Math.abs(s.lab[0] - lab[0]),
              Math.abs(s.lab[1] - lab[1]),
              Math.abs(s.lab[2] - lab[2]),
            ) > reach,
        );
      }
      cr.opts = { ...cr.opts, select: "sampled", samples };
      return colorRangePreview();
    },
    async setColorRangePreview(mode) {
      const cr = ui.colorRange;
      if (!cr) return false;
      cr.canvasPreview = mode;
      await colorRangePreview();
      return applyView(
        mode === "none" ? { kind: "composite" } : { kind: "matte", mode },
      );
    },
    async colorRangeOk(mode = "replace") {
      const cr = ui.colorRange;
      const e = deps.engine();
      const src = deps.source();
      if (!cr || !e || !src) return false;
      if (cr.opts.select === "outOfGamut") {
        deps.setStatus(t(MK.outOfGamut));
        return false;
      }
      try {
        await e.selectColorRange(cr.opts, src.width, src.height, mode);
      } catch (err) {
        deps.setStatus(
          t(MK.failed, { what: t(MK.colorRange), error: errText(err) }),
        );
        return false;
      }
      ui.colorRange = null;
      if (ui.view.kind === "matte") await applyView({ kind: "composite" });
      return selected(MK.colorRangeApplied);
    },
    async colorRangeCancel() {
      ui.colorRange = null;
      if (ui.view.kind === "matte") await applyView({ kind: "composite" });
      deps.emit();
      return true;
    },

    grow() {
      const w = deps.wand();
      return (
        run("Grow", (e) => e.selectionGrow(w.tolerance, true)) !== null &&
        selected(MK.grown)
      );
    },
    similar() {
      const w = deps.wand();
      return (
        run("Similar", (e) => e.selectionGrow(w.tolerance, false)) !== null &&
        selected(MK.similar)
      );
    },

    openFocusArea() {
      if (!deps.engine() || !deps.source()) {
        deps.setStatus(t(MK.noImage));
        return false;
      }
      ui.focusArea = { range: 0.5, noise: 0, preview: null };
      deps.emit();
      return true;
    },
    async setFocusArea(patch) {
      const fa = ui.focusArea;
      if (!fa) return false;
      Object.assign(fa, patch);
      const p = run("Focus Area", (e) =>
        e.focusAreaPreview(fa.range, fa.noise),
      );
      if (!p) return false;
      fa.preview = p;
      deps.emit();
      return true;
    },
    async focusAreaOk(mode = "replace") {
      const fa = ui.focusArea;
      if (!fa) return false;
      const ok = run("Focus Area", (e) =>
        e.selectionFocusArea(fa.range, fa.noise, mode),
      );
      if (ok === null) return false;
      ui.focusArea = null;
      return selected(MK.focusArea);
    },
    async focusAreaCancel() {
      ui.focusArea = null;
      deps.emit();
      return true;
    },

    async toggleQuickMask() {
      const e = deps.engine();
      if (!e || !deps.source()) {
        deps.setStatus(t(MK.noImage));
        return false;
      }
      try {
        if (e.quickMaskActive()) {
          e.quickMaskExit();
          deps.refreshSelection();
          refresh();
          ui.view = { kind: "composite" };
          deps.setStatus(t(MK.quickMaskOff));
        } else {
          e.quickMaskEnter();
          refresh();
          ui.view = { kind: "quickMask" };
          deps.setStatus(t(MK.quickMaskOn));
        }
      } catch (err) {
        deps.setStatus(
          t(MK.failed, { what: "Quick Mask", error: errText(err) }),
        );
        return false;
      }
      deps.markEdited();
      await deps.redisplay();
      return true;
    },

    saveSelection(name = "") {
      const id = run("Save Selection", (e) => e.channelSaveSelection(name));
      if (id === null) return false;
      refresh();
      return changed(MK.savedSelection, { name: nameOf(id) });
    },
    loadSelection(id, mode = "replace", invert = false) {
      const ok = run("Load Selection", (e) =>
        e.channelLoadSelection(id, invert, mode),
      );
      if (ok === null) return false;
      deps.refreshSelection();
      deps.setStatus(t(MK.loadedSelection, { name: nameOf(id) }));
      return true;
    },
    deleteChannel(id) {
      return (
        run("Delete channel", (e) => e.channelDelete(id)) !== null &&
        changed(MK.channelDeleted)
      );
    },
    renameChannel(id, name) {
      return (
        run("Rename channel", (e) => e.channelRename(id, name)) !== null &&
        changed()
      );
    },
    duplicateChannel(id) {
      return (
        run("Duplicate channel", (e) => e.channelDuplicate(id)) !== null &&
        changed()
      );
    },
    newSpotChannel(name, colour, solidity) {
      return (
        run("New spot channel", (e) =>
          e.channelNewSpot(name, colour, solidity),
        ) !== null && changed()
      );
    },
    setSpot(id, colour, solidity) {
      return (
        run("Channel options", (e) =>
          e.channelSetSpot(id, colour, solidity),
        ) !== null && changed()
      );
    },
    editChannel(id) {
      const ok = run("Edit channel", (e) => e.channelSetEdit(id)) !== null;
      if (ok) {
        refresh();
        deps.emit();
      }
      return ok;
    },

    pathFromSelection(name = "", tolerance = 0.5) {
      const id = run("Make Work Path", (e) =>
        e.pathFromSelection(name, 128, tolerance),
      );
      if (id === null) return false;
      refresh();
      return changed(MK.pathMade, { name: nameOf(id) });
    },
    makeSelectionFromPath(id, feather = 0, mode = "replace") {
      const ok = run("Make Selection", (e) =>
        e.pathMakeSelection(id, feather, mode),
      );
      if (ok === null) return false;
      deps.refreshSelection();
      deps.setStatus(t(MK.pathSelected, { name: nameOf(id) }));
      return true;
    },
    deletePath(id) {
      return run("Delete path", (e) => e.pathDelete(id)) !== null && changed();
    },
    renamePath(id, name) {
      return (
        run("Rename path", (e) => e.pathRename(id, name)) !== null && changed()
      );
    },
    duplicatePath(id) {
      return (
        run("Duplicate path", (e) => e.pathDuplicate(id)) !== null && changed()
      );
    },

    async openRefine() {
      const e = deps.engine();
      if (!e || !deps.source()) {
        deps.setStatus(t(MK.noImage));
        return false;
      }
      if (!e.selectionStats()) {
        deps.setStatus(t(MK.noSelection));
        return false;
      }
      try {
        e.samBegin();
      } catch (err) {
        deps.setStatus(
          t(MK.failed, { what: "Select and Mask", error: errText(err) }),
        );
        return false;
      }
      ui.refine = {
        opts: defaultRefine(),
        view: "overlay",
        opacity: 0.5,
        output: "selection",
        brushRadius: 10,
        alpha: null,
      };
      deps.setStatus(t(matting ? MK.refineOpen : MK.matting));
      try {
        e.viewSet({ kind: "matte", mode: "overlay", opacity: 0.5 });
        ui.view = { kind: "matte", mode: "overlay", opacity: 0.5 };
      } catch {
        // The view is a display nicety; the workspace works without it.
      }
      return refinePreview();
    },
    async setRefine(patch) {
      if (!ui.refine) return false;
      ui.refine.opts = { ...ui.refine.opts, ...patch };
      return refinePreview();
    },
    async setRefineView(view, opacity) {
      const r = ui.refine;
      if (!r) return false;
      r.view = view;
      if (opacity !== undefined) r.opacity = opacity;
      return applyView({ kind: "matte", mode: view, opacity: r.opacity });
    },
    setRefineOutput(output) {
      if (!ui.refine) return;
      ui.refine.output = output;
      deps.emit();
    },
    setRefineBrush(radius) {
      if (!ui.refine) return;
      ui.refine.brushRadius = Math.max(1, radius);
      deps.emit();
    },
    async refineBrush(x, y, erase) {
      const r = ui.refine;
      if (!r) return false;
      const ok = run("Refine Edge brush", (e) =>
        e.samPaintBand(x, y, r.brushRadius, erase),
      );
      if (ok === null) return false;
      return refinePreview();
    },
    async refineOk() {
      const r = ui.refine;
      const e = deps.engine();
      if (!r || !e) return false;
      try {
        e.samSetParams(r.opts);
        e.samCommit(r.output);
      } catch (err) {
        deps.setStatus(
          t(MK.failed, { what: "Select and Mask", error: errText(err) }),
        );
        return false;
      }
      const output = r.output;
      await closeRefine();
      if (output === "selection") deps.refreshSelection();
      else await deps.recomposite();
      refresh();
      deps.setStatus(t(MK.refineDone, { output }));
      return true;
    },
    async refineCancel() {
      deps.engine()?.samCancel();
      await closeRefine();
      deps.setStatus(t(MK.refineCancelled));
      return true;
    },
    setMattingProvider(p) {
      matting = p;
    },
    refineHint() {
      deps.setStatus(t(MK.refineFirst));
    },

    openLoadSelection() {
      refresh();
      const first = ui.info.channels.find((c) => c.kind !== "quickMask");
      if (!deps.engine() || !deps.source()) {
        deps.setStatus(t(MK.noImage));
        return false;
      }
      if (!first) {
        deps.setStatus(t(MK.noChannel));
        return false;
      }
      ui.load = { channel: first.id, mode: "replace", invert: false };
      deps.emit();
      return true;
    },
    setLoadSelection(patch) {
      if (!ui.load) return;
      ui.load = { ...ui.load, ...patch };
      deps.emit();
    },
    loadSelectionOk() {
      const l = ui.load;
      if (!l) return false;
      ui.load = null;
      const ok = run("Load Selection", (e) =>
        e.channelLoadSelection(l.channel, l.invert, l.mode),
      );
      if (ok === null) return false;
      deps.refreshSelection();
      deps.setStatus(t(MK.loadedSelection, { name: nameOf(l.channel) }));
      return true;
    },
    loadSelectionCancel() {
      ui.load = null;
      deps.emit();
    },

    magneticOptions: () => ui.magnetic,
    setMagneticOptions(o) {
      ui.magnetic = { ...ui.magnetic, ...o };
      deps.emit();
    },
  };
}
