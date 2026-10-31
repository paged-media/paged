// The engine doors of SMART OBJECTS in full (image ADR 482, WP5.14): the
// transform (a placement's four corners), the smart filters' detached GPU
// pass (base, fade, land), the contents (Edit Contents as a nested
// document, Replace, Relink, Embed, Export) and new smart layers from
// pixels or page items. Kept beside `engine.ts`, which spreads
// `wrapSmart` into the engine it wraps, as the vector doors are.

/** The engine's decoded-handle shape (engine.ts `DecodedHandleWasm`). */
interface HandleWasm {
  handle: number;
  width: number;
  height: number;
  display: number;
  depth_reduced: boolean;
  free(): void;
}

/** A placement: the corners top-left, top-right, bottom-right,
 *  bottom-left of the source, in image px (`[x0, y0, …, x3, y3]`). */
export type Quad = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** One smart filter as the engine reports it. */
export interface SmartFilterInfo {
  /** The Filter dialog's catalogue id; empty for a filter read from a
   *  PSD that paged has no counterpart for (`known` false). */
  id: string;
  name: string;
  values: Record<string, number | boolean | number[]> | null;
  enabled: boolean;
  /** 0…1 (the filter's blending options). */
  opacity: number;
  mode: string;
  known: boolean;
}

export interface SmartFiltersInfo {
  enabled: boolean;
  maskEnabled: boolean;
  maskLinked: boolean;
  hasMask: boolean;
  filters: SmartFilterInfo[];
}

/** A smart object's state (`layers_smart_info`). */
export interface SmartInfo {
  quad: number[];
  /** The source's own size, px. */
  width: number;
  height: number;
  /** The scale the placement draws the source at. */
  scale: number;
  file: {
    name: string;
    type: string;
    linked: boolean;
    path: string | null;
    available: boolean;
    bytes: number;
  } | null;
  /** A vector smart object's page items. */
  vector: { items: string[]; region: number[]; pxPerPt: number } | null;
  filters: SmartFiltersInfo | null;
  pendingFilters: boolean;
  /** A warp paged does not draw: the render stays Photoshop's. */
  warped: boolean;
  /** How deep the open contents are nested (0: the document). */
  nested: number;
}

/** What the panel sends to set the filters. `from` is the entry's index
 *  in the list it came from (a PSD filter keeps its form while it is the
 *  same filter). */
export interface SmartFiltersEdit {
  enabled: boolean;
  maskEnabled?: boolean;
  filters: Array<{
    id: string;
    name?: string;
    values: Record<string, unknown>;
    enabled: boolean;
    opacity: number;
    mode: string;
    from?: number;
  }>;
}

/** The raw wasm exports these doors wrap. */
export interface SmartWasm {
  layers_smart_info(index: number): string;
  layers_smart_transform(index: number, quad: Float64Array): boolean;
  layers_smart_pending(): Uint32Array;
  layers_smart_filter_base(index: number): HandleWasm;
  layers_smart_filter_fade(
    input: number,
    output: number,
    opacity: number,
  ): HandleWasm;
  layers_smart_filter_land(index: number, base: number, result: number): void;
  layers_smart_filter_associate(
    handle: number,
    dissociate: boolean,
  ): HandleWasm;
  layers_smart_set_filters(label: string, index: number, json: string): boolean;
  layers_smart_filter_mask(index: number, op: string): boolean;
  layers_smart_replace(
    index: number,
    bytes: Uint8Array,
    name: string,
    link: string,
  ): boolean;
  layers_smart_embed(index: number): boolean;
  layers_smart_contents(index: number): Uint8Array;
  layers_smart_add(
    name: string,
    rgba: Uint8Array,
    width: number,
    height: number,
    quad: Float64Array,
    items: string,
  ): number;
  layers_smart_vector_source(
    index: number,
    rgba: Uint8Array,
    width: number,
    height: number,
    pxPerPt: number,
  ): boolean;
  layers_smart_notes(): string;
  smart_contents_open(index: number): Promise<HandleWasm>;
  smart_contents_close(save: boolean): Promise<HandleWasm>;
  smart_contents_depth(): number;
}

/** The camelCase facade. */
export interface SmartEngine<Info> {
  /** The state of smart object `index`, or null when it is not one. */
  smartInfo(index: number): SmartInfo | null;
  /** Place the source on `quad` and re-render. One undo step; true when
   *  its smart filters still have to run (`runSmartFilters`). */
  smartTransform(index: number, quad: Quad): boolean;
  /** The layers whose smart filters still have to run. */
  smartPending(): number[];
  /** The unfiltered render as a new flat handle. */
  smartFilterBase(index: number): Info;
  smartFilterFade(input: number, output: number, opacity: number): Info;
  /** `handle` as associated colour (or back): the blurs of a smart
   *  filter pass run over it (`ASSOCIATED_FILTERS`). */
  smartFilterAssociate(handle: number, dissociate: boolean): Info;
  /** Land a filter result through the filter mask (no undo step). */
  smartFilterLand(index: number, base: number, result: number): void;
  smartSetFilters(
    label: string,
    index: number,
    edit: SmartFiltersEdit,
  ): boolean;
  smartFilterMask(
    index: number,
    op: "selection" | "invert" | "clear" | "hide-all",
  ): boolean;
  /** Replace the contents (`link` keeps a linked object linked). */
  smartReplace(
    index: number,
    bytes: Uint8Array,
    name: string,
    link?: string,
  ): boolean;
  smartEmbed(index: number): boolean;
  smartContents(index: number): Uint8Array;
  smartAdd(
    name: string,
    rgba: Uint8Array,
    width: number,
    height: number,
    quad: Quad,
    vector?: { items: string[]; region: number[]; pxPerPt: number },
  ): number;
  smartVectorSource(
    index: number,
    rgba: Uint8Array,
    width: number,
    height: number,
    pxPerPt: number,
  ): boolean;
  smartNotes(): string[];
  smartContentsOpen(index: number): Promise<Info>;
  smartContentsClose(save: boolean): Promise<Info>;
  smartContentsDepth(): number;
}

export function wrapSmart<Info>(
  wasm: SmartWasm,
  info: (h: HandleWasm) => Info,
): SmartEngine<Info> {
  return {
    smartInfo(index) {
      try {
        return JSON.parse(wasm.layers_smart_info(index)) as SmartInfo;
      } catch {
        return null;
      }
    },
    smartTransform: (index, quad) =>
      wasm.layers_smart_transform(index, Float64Array.from(quad)),
    smartPending: () => Array.from(wasm.layers_smart_pending()),
    smartFilterBase: (index) => info(wasm.layers_smart_filter_base(index)),
    smartFilterFade: (input, output, opacity) =>
      info(wasm.layers_smart_filter_fade(input, output, opacity)),
    smartFilterAssociate: (handle, dissociate) =>
      info(wasm.layers_smart_filter_associate(handle, dissociate)),
    smartFilterLand: (index, base, result) =>
      wasm.layers_smart_filter_land(index, base, result),
    smartSetFilters: (label, index, edit) =>
      wasm.layers_smart_set_filters(label, index, JSON.stringify(edit)),
    smartFilterMask: (index, op) => wasm.layers_smart_filter_mask(index, op),
    smartReplace: (index, bytes, name, link = "") =>
      wasm.layers_smart_replace(index, bytes, name, link),
    smartEmbed: (index) => wasm.layers_smart_embed(index),
    smartContents: (index) => wasm.layers_smart_contents(index),
    smartAdd: (name, rgba, width, height, quad, vector) =>
      wasm.layers_smart_add(
        name,
        rgba,
        width,
        height,
        Float64Array.from(quad),
        vector ? JSON.stringify(vector) : "",
      ),
    smartVectorSource: (index, rgba, width, height, pxPerPt) =>
      wasm.layers_smart_vector_source(index, rgba, width, height, pxPerPt),
    smartNotes: () => wasm.layers_smart_notes().split("\n").filter(Boolean),
    smartContentsOpen: async (index) =>
      info(await wasm.smart_contents_open(index)),
    smartContentsClose: async (save) =>
      info(await wasm.smart_contents_close(save)),
    smartContentsDepth: () => wasm.smart_contents_depth(),
  };
}

/** The filters that run over associated colour on a smart object (the
 *  blurs; image-js `smart::ASSOCIATED_FILTERS`). */
export const ASSOCIATED_FILTERS: ReadonlySet<string> = new Set([
  "gaussianBlur",
  "boxBlur",
  "motionBlur",
  "radialBlur",
  "lensBlur",
  "surfaceBlur",
]);

/** The corners of a `width × height` source placed at `(x, y)`. */
export function rectQuad(
  x: number,
  y: number,
  width: number,
  height: number,
): Quad {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

/** A numeric transform as the panel's fields hold it: scale in percent
 *  (negative mirrors), rotation and skew in degrees, a move in px. */
export interface TransformFields {
  scaleX: number;
  scaleY: number;
  rotate: number;
  skewX: number;
  skewY: number;
  moveX: number;
  moveY: number;
}

export const IDENTITY_FIELDS: Readonly<TransformFields> = {
  scaleX: 100,
  scaleY: 100,
  rotate: 0,
  skewX: 0,
  skewY: 0,
  moveX: 0,
  moveY: 0,
};

/** `q` transformed about its centre by `f` — Photoshop's Free Transform
 *  with the reference point in the middle: scale, skew, rotate, then
 *  move (each corner, so a perspective quad keeps its shape). */
export function transformQuad(q: Quad, f: TransformFields): Quad {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const sx = f.scaleX / 100;
  const sy = f.scaleY / 100;
  const kx = Math.tan((f.skewX * Math.PI) / 180);
  const ky = Math.tan((f.skewY * Math.PI) / 180);
  const r = (f.rotate * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    let x = (q[2 * i]! - cx) * sx;
    let y = (q[2 * i + 1]! - cy) * sy;
    [x, y] = [x + kx * y, y + ky * x];
    [x, y] = [x * cos - y * sin, x * sin + y * cos];
    out.push(x + cx + f.moveX, y + cy + f.moveY);
  }
  return out as unknown as Quad;
}

/** The quad's corners moved one by one (Distort / Perspective). */
export function moveCorner(
  q: Quad,
  corner: number,
  dx: number,
  dy: number,
): Quad {
  const out = [...q];
  out[2 * corner] = out[2 * corner]! + dx;
  out[2 * corner + 1] = out[2 * corner + 1]! + dy;
  return out as unknown as Quad;
}
