// The engine doors of SELECTION AND MASKING (image ADR 470, WP5.5):
// Color Range, Grow / Similar, Focus Area, Select and Mask, Quick Mask,
// the document's channels and paths, the display view and the Magnetic
// Lasso. Kept beside `engine.ts` (which spreads `maskingEngine` into the
// engine it wraps) so the selection lane reads as one file.
//
// Every door that changes the selection, a channel or a path is ONE undo
// step on the image's undo list (the layer stack's), engine-side.

/** The raw wasm exports these doors wrap. */
export interface MaskingWasm {
  color_range_sample(x: number, y: number): Float32Array;
  color_range_preview(
    kind: number,
    fuzziness: number,
    invert: boolean,
    samples: Float32Array,
    localized: boolean,
    range: number,
    hue: number,
    lower: number,
    upper: number,
    midtones: boolean,
  ): Promise<Uint8Array>;
  selection_color_range(
    kind: number,
    fuzziness: number,
    invert: boolean,
    samples: Float32Array,
    localized: boolean,
    range: number,
    hue: number,
    lower: number,
    upper: number,
    midtones: boolean,
    mode: number,
  ): Promise<void>;
  selection_grow(tolerance: number, contiguous: boolean): void;
  selection_focus_area(range: number, noise: number, mode: number): void;
  focus_area_preview(range: number, noise: number): Uint8Array;
  view_set(kind: string, arg: string, opacity: number, spots: boolean): void;
  view_active(): boolean;
  view_apply(rgba: Uint8Array, w: number, h: number): Uint8Array;
  quick_mask_enter(): number;
  quick_mask_exit(): void;
  quick_mask_active(): boolean;
  masking_list(): string;
  channel_save_selection(name: string): number;
  channel_load_selection(id: number, invert: boolean, mode: number): void;
  channel_delete(id: number): void;
  channel_rename(id: number, name: string): void;
  channel_duplicate(id: number): number;
  channel_new_spot(
    name: string,
    r: number,
    g: number,
    b: number,
    solidity: number,
  ): number;
  channel_set_spot(
    id: number,
    r: number,
    g: number,
    b: number,
    solidity: number,
  ): void;
  channel_set_edit(id: number): void;
  channel_clear_preview(): void;
  path_from_selection(
    name: string,
    threshold: number,
    tolerance: number,
  ): number;
  path_add(
    name: string,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
  ): number;
  path_get(id: number): string;
  path_make_selection(id: number, feather: number, mode: number): void;
  path_delete(id: number): void;
  path_rename(id: number, name: string): void;
  path_duplicate(id: number): number;
  sam_begin(): void;
  sam_set_params(
    radius: number,
    smartRadius: boolean,
    smooth: number,
    feather: number,
    contrast: number,
    shiftEdge: number,
    decontaminate: boolean,
    amount: number,
  ): void;
  sam_paint_band(x: number, y: number, radius: number, erase: boolean): void;
  sam_trimap(): Uint8Array;
  sam_set_matte(alpha: Uint8Array): void;
  sam_preview(): Uint8Array;
  sam_commit(output: string): void;
  sam_cancel(): void;
  magnetic_begin(
    x: number,
    y: number,
    width: number,
    contrast: number,
    frequency: number,
  ): Float32Array;
  magnetic_move(x: number, y: number): Float32Array;
  magnetic_anchor(x: number, y: number): Float32Array;
  magnetic_undo_anchor(): Float32Array;
  magnetic_anchors(): Float32Array;
  magnetic_close(mode: number): boolean;
  magnetic_cancel(): void;
}

/** One Color Range sample: its Lab (D50) and where it was taken. */
export interface ColorRangeSample {
  lab: [number, number, number];
  x: number;
  y: number;
}

/** What Color Range selects by. */
export type ColorRangeSelect =
  | "sampled"
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "magentas"
  | "highlights"
  | "midtones"
  | "shadows"
  | "skinTones"
  | "outOfGamut";

/** The Color Range dialog's state, in Photoshop's units. */
export interface ColorRangeOptions {
  select: ColorRangeSelect;
  /** Fuzziness: 0…200 for sampled colours and skin tones, 0…100 % for
   *  the tonal presets. */
  fuzziness: number;
  samples: ColorRangeSample[];
  localized: boolean;
  /** Localized range, % of the image's longer side. */
  range: number;
  /** Tonal limits on 0…255. */
  lower: number;
  upper: number;
  invert: boolean;
}

/** Photoshop's defaults per selection kind. */
export const COLOR_RANGE_DEFAULTS: Record<
  "highlights" | "midtones" | "shadows",
  { fuzziness: number; lower: number; upper: number }
> = {
  highlights: { fuzziness: 20, lower: 190, upper: 255 },
  midtones: { fuzziness: 40, lower: 105, upper: 150 },
  shadows: { fuzziness: 20, lower: 0, upper: 65 },
};

export const HUE_CENTRES: Partial<Record<ColorRangeSelect, number>> = {
  reds: 0,
  yellows: 60,
  greens: 120,
  cyans: 180,
  blues: 240,
  magentas: 300,
};

export function defaultColorRange(): ColorRangeOptions {
  return {
    select: "sampled",
    fuzziness: 40,
    samples: [],
    localized: false,
    range: 100,
    lower: 0,
    upper: 255,
    invert: false,
  };
}

/** A channel in the Channels panel. */
export interface ChannelInfo {
  id: number;
  name: string;
  kind: "alpha" | "spot" | "quickMask";
  colour: [number, number, number] | null;
  solidity: number | null;
  /** Fraction of the canvas selected (0…1). */
  coverage: number;
}

/** A path in the Paths panel. */
export interface PathInfo {
  id: number;
  name: string;
  /** The WORK PATH (image ADR 476): the temporary path the Pen and the
   *  shape tools draw into, until Save Path names it. */
  work: boolean;
  subpaths: number;
  anchors: number;
}

export interface MaskingInfo {
  channels: ChannelInfo[];
  paths: PathInfo[];
  quickMask: number | null;
  editChannel: number | null;
}

/** A stored path: per subpath its closed flag and its anchors as
 *  `[x, y, inX, inY, outX, outY]` (image px). */
export interface StoredPath {
  id: number;
  name: string;
  closed: boolean[];
  anchors: number[][];
}

/** The Select and Mask sliders. */
export interface RefineOptions {
  radius: number;
  smartRadius: boolean;
  smooth: number;
  feather: number;
  contrast: number;
  shiftEdge: number;
  decontaminate: boolean;
  amount: number;
}

export function defaultRefine(): RefineOptions {
  return {
    radius: 0,
    smartRadius: false,
    smooth: 0,
    feather: 0,
    contrast: 0,
    shiftEdge: 0,
    decontaminate: false,
    amount: 100,
  };
}

/** Select and Mask's view modes (and Color Range's selection preview). */
export type MatteView =
  "overlay" | "onBlack" | "onWhite" | "blackWhite" | "onLayers";

/** What the frame shows. */
export type DisplayView =
  | { kind: "composite"; spots?: boolean }
  | { kind: "component"; channel: "red" | "green" | "blue" | "alpha" | "luma" }
  | { kind: "channel"; id: number }
  | { kind: "quickMask" }
  | { kind: "matte"; mode: MatteView; opacity?: number };

export type RefineOutput = "selection" | "layerMask" | "newLayerWithMask";

/** The Magnetic Lasso's options (Photoshop's defaults: 10 px, 10 %, 57). */
export interface MagneticOptions {
  width: number;
  contrast: number;
  frequency: number;
}

export const MAGNETIC_DEFAULTS: MagneticOptions = {
  width: 10,
  contrast: 10,
  frequency: 57,
};

const MODE: Record<string, number> = {
  replace: 0,
  add: 1,
  subtract: 2,
  intersect: 3,
};

/** Combine modes as the doors take them. */
export type MaskMode = "replace" | "add" | "subtract" | "intersect";

/** The flat Color Range arguments for `opts` over a `w`×`h` image. */
function rangeArgs(opts: ColorRangeOptions, w: number, h: number) {
  const tonal =
    opts.select === "highlights" ||
    opts.select === "midtones" ||
    opts.select === "shadows";
  const hue = HUE_CENTRES[opts.select];
  const kind =
    opts.select === "sampled"
      ? 0
      : hue !== undefined
        ? 1
        : tonal
          ? 2
          : opts.select === "skinTones"
            ? 3
            : -1;
  if (kind < 0)
    throw new Error(
      "Out of Gamut needs a soft-proofing CMYK profile, which the image module's colour settings do not have yet",
    );
  const samples = new Float32Array(opts.samples.length * 5);
  opts.samples.forEach((s, i) => {
    samples.set([s.lab[0], s.lab[1], s.lab[2], s.x, s.y], i * 5);
  });
  return [
    kind,
    tonal ? opts.fuzziness / 100 : opts.fuzziness,
    opts.invert,
    samples,
    opts.localized,
    (Math.max(w, h) * opts.range) / 100,
    hue ?? 0,
    opts.lower,
    opts.upper,
    opts.select === "midtones",
  ] as const;
}

/** The doors, as the engine exposes them. */
export interface MaskingEngine {
  /** The Lab (D50) of the bound image's pixel — an eyedropper sample. */
  colorRangeSample(x: number, y: number): [number, number, number];
  /** Color Range's coverage over the bound image, not applied (it also
   *  becomes the `matte` view's coverage). */
  colorRangePreview(
    opts: ColorRangeOptions,
    w: number,
    h: number,
  ): Promise<Uint8Array>;
  /** Select ▸ Color Range, folded under `mode`. One undo step. */
  selectColorRange(
    opts: ColorRangeOptions,
    w: number,
    h: number,
    mode: MaskMode,
  ): Promise<void>;
  /** Select ▸ Grow (`contiguous`) / Similar. One undo step. */
  selectionGrow(tolerance: number, contiguous: boolean): void;
  /** Select ▸ Focus Area (range and noise 0…1). One undo step. */
  selectionFocusArea(range: number, noise: number, mode: MaskMode): void;
  focusAreaPreview(range: number, noise: number): Uint8Array;
  viewSet(view: DisplayView): void;
  viewActive(): boolean;
  viewApply(rgba: Uint8Array, w: number, h: number): Uint8Array;
  quickMaskEnter(): number;
  quickMaskExit(): void;
  quickMaskActive(): boolean;
  maskingList(): MaskingInfo;
  channelSaveSelection(name: string): number;
  channelLoadSelection(id: number, invert: boolean, mode: MaskMode): void;
  channelDelete(id: number): void;
  channelRename(id: number, name: string): void;
  channelDuplicate(id: number): number;
  channelNewSpot(
    name: string,
    colour: [number, number, number],
    solidity: number,
  ): number;
  channelSetSpot(
    id: number,
    colour: [number, number, number],
    solidity: number,
  ): void;
  /** Paint channel `id` with the pixel tools (`null`: the layers). */
  channelSetEdit(id: number | null): void;
  channelClearPreview(): void;
  pathFromSelection(name: string, threshold: number, tolerance: number): number;
  pathAdd(
    name: string,
    subpaths: { closed: boolean; anchors: number[] }[],
  ): number;
  pathGet(id: number): StoredPath;
  pathMakeSelection(id: number, feather: number, mode: MaskMode): void;
  pathDelete(id: number): void;
  pathRename(id: number, name: string): void;
  pathDuplicate(id: number): number;
  samBegin(): void;
  samSetParams(p: RefineOptions): void;
  samPaintBand(x: number, y: number, radius: number, erase: boolean): void;
  samTrimap(): Uint8Array;
  samSetMatte(alpha: Uint8Array | null): void;
  samPreview(): Uint8Array;
  samCommit(output: RefineOutput): void;
  samCancel(): void;
  magneticBegin(x: number, y: number, opts: MagneticOptions): number[];
  magneticMove(x: number, y: number): number[];
  magneticAnchor(x: number, y: number): number[];
  magneticUndoAnchor(): number[];
  magneticAnchors(): number[];
  magneticClose(mode: MaskMode): boolean;
  magneticCancel(): void;
}

export function maskingEngine(wasm: MaskingWasm): MaskingEngine {
  return {
    colorRangeSample(x, y) {
      const l = wasm.color_range_sample(x, y);
      return [l[0], l[1], l[2]];
    },
    colorRangePreview: (opts, w, h) =>
      wasm.color_range_preview(...rangeArgs(opts, w, h)),
    selectColorRange: (opts, w, h, mode) =>
      wasm.selection_color_range(...rangeArgs(opts, w, h), MODE[mode]),
    selectionGrow: (tol, contiguous) => wasm.selection_grow(tol, contiguous),
    selectionFocusArea: (range, noise, mode) =>
      wasm.selection_focus_area(range, noise, MODE[mode]),
    focusAreaPreview: (range, noise) => wasm.focus_area_preview(range, noise),
    viewSet(v) {
      switch (v.kind) {
        case "composite":
          return wasm.view_set("composite", "", 0, !!v.spots);
        case "component":
          return wasm.view_set("component", v.channel, 0, false);
        case "channel":
          return wasm.view_set("channel", String(v.id), 0, false);
        case "quickMask":
          return wasm.view_set("quickMask", "", 0, false);
        case "matte":
          return wasm.view_set("matte", v.mode, v.opacity ?? 0.5, false);
      }
    },
    viewActive: () => wasm.view_active(),
    viewApply: (rgba, w, h) => wasm.view_apply(rgba, w, h),
    quickMaskEnter: () => wasm.quick_mask_enter(),
    quickMaskExit: () => wasm.quick_mask_exit(),
    quickMaskActive: () => wasm.quick_mask_active(),
    maskingList: () => JSON.parse(wasm.masking_list()) as MaskingInfo,
    channelSaveSelection: (name) => wasm.channel_save_selection(name),
    channelLoadSelection: (id, invert, mode) =>
      wasm.channel_load_selection(id, invert, MODE[mode]),
    channelDelete: (id) => wasm.channel_delete(id),
    channelRename: (id, name) => wasm.channel_rename(id, name),
    channelDuplicate: (id) => wasm.channel_duplicate(id),
    channelNewSpot: (name, c, s) =>
      wasm.channel_new_spot(name, c[0], c[1], c[2], s),
    channelSetSpot: (id, c, s) =>
      wasm.channel_set_spot(id, c[0], c[1], c[2], s),
    channelSetEdit: (id) => wasm.channel_set_edit(id ?? -1),
    channelClearPreview: () => wasm.channel_clear_preview(),
    pathFromSelection: (name, threshold, tolerance) =>
      wasm.path_from_selection(name, threshold, tolerance),
    pathAdd(name, subpaths) {
      const closed = Uint8Array.from(subpaths.map((s) => (s.closed ? 1 : 0)));
      const lens = Uint32Array.from(subpaths.map((s) => s.anchors.length / 6));
      const anchors = Float32Array.from(subpaths.flatMap((s) => s.anchors));
      return wasm.path_add(name, closed, lens, anchors);
    },
    pathGet: (id) => JSON.parse(wasm.path_get(id)) as StoredPath,
    pathMakeSelection: (id, feather, mode) =>
      wasm.path_make_selection(id, feather, MODE[mode]),
    pathDelete: (id) => wasm.path_delete(id),
    pathRename: (id, name) => wasm.path_rename(id, name),
    pathDuplicate: (id) => wasm.path_duplicate(id),
    samBegin: () => wasm.sam_begin(),
    samSetParams: (p) =>
      wasm.sam_set_params(
        p.radius,
        p.smartRadius,
        p.smooth,
        p.feather,
        p.contrast,
        p.shiftEdge,
        p.decontaminate,
        p.amount,
      ),
    samPaintBand: (x, y, r, erase) => wasm.sam_paint_band(x, y, r, erase),
    samTrimap: () => wasm.sam_trimap(),
    samSetMatte: (alpha) => wasm.sam_set_matte(alpha ?? new Uint8Array(0)),
    samPreview: () => wasm.sam_preview(),
    samCommit: (output) => wasm.sam_commit(output),
    samCancel: () => wasm.sam_cancel(),
    magneticBegin: (x, y, o) =>
      Array.from(
        wasm.magnetic_begin(x, y, o.width, o.contrast / 100, o.frequency),
      ),
    magneticMove: (x, y) => Array.from(wasm.magnetic_move(x, y)),
    magneticAnchor: (x, y) => Array.from(wasm.magnetic_anchor(x, y)),
    magneticUndoAnchor: () => Array.from(wasm.magnetic_undo_anchor()),
    magneticAnchors: () => Array.from(wasm.magnetic_anchors()),
    magneticClose: (mode) => wasm.magnetic_close(MODE[mode]),
    magneticCancel: () => wasm.magnetic_cancel(),
  };
}
