// The engine doors of TRANSFORM AND WARP ON PIXELS (WP5.6, image ADR 483):
// Warp (the fifteen styles and a custom mesh, `geom.warp_mesh`), Liquify
// and Puppet Warp (`geom.warp_field` over `paged-warp`'s fields),
// Content-Aware Scale (seam carving) and the Perspective Crop (a canvas
// op over the whole stack). Kept beside `engine.ts`, which spreads
// `wrapWarps` into the engine it wraps, as the smart-object doors are.

/** The engine's decoded-handle shape (engine.ts `DecodedHandleWasm`). */
interface HandleWasm {
  handle: number;
  width: number;
  height: number;
  display: number;
  depth_reduced: boolean;
  free(): void;
}

/** An image-px rectangle. */
export interface WarpRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Photoshop's warp styles by wire name (paged-warp's `WarpStyle`). */
export const WARP_STYLES = [
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fishEye",
  "inflate",
  "squeeze",
  "twist",
] as const;
export type WarpStyleName = (typeof WARP_STYLES)[number] | "none";

/** One Warp style's parameters (Photoshop's −100…100 % as −1…1). */
export interface WarpStyleSpec {
  style: WarpStyleName;
  bend: number;
  horizontal: number;
  vertical: number;
  /** Photoshop's Vertical orientation. */
  verticalOrientation: boolean;
}

/** One Puppet Warp pin: the point it holds and where it is now (px). */
export interface PuppetPin {
  at: [number, number];
  to: [number, number];
}

/** Puppet Warp's options. */
export interface PuppetOptions {
  /** 0 rigid, 1 normal, 2 distort. */
  mode: 0 | 1 | 2;
  /** 0 fewer points, 1 normal, 2 more points. */
  density: 0 | 1 | 2;
  /** px the mesh reaches past what the layer covers. */
  expansion: number;
}

/** Liquify's tools, in the engine's wire order. */
export const LIQUIFY_TOOLS = [
  "forwardWarp",
  "reconstruct",
  "smooth",
  "twirlClockwise",
  "twirlCounterClockwise",
  "pucker",
  "bloat",
  "pushLeft",
  "freeze",
  "thaw",
] as const;
export type LiquifyToolName = (typeof LIQUIFY_TOOLS)[number];

/** One Liquify stroke, image px. */
export interface LiquifyStroke {
  tool: LiquifyToolName;
  /** Brush diameter, px. */
  size: number;
  /** 0…1 each. */
  pressure: number;
  density: number;
  rate: number;
  points: Array<[number, number]>;
}

/** The raw wasm doors (`image_js.d.ts`). */
export interface WarpWasm {
  warp_style_mesh(
    style: string,
    bend: number,
    horizontal: number,
    vertical_distortion: number,
    vertical: boolean,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Float32Array;
  warp_bounds(handle: number): Uint32Array;
  apply_mesh_warp(
    handle: number,
    mesh: Float32Array,
    rect: Uint32Array,
  ): Promise<HandleWasm>;
  apply_liquify(handle: number, strokes: Float32Array): Promise<HandleWasm>;
  apply_puppet_warp(
    handle: number,
    pins: Float32Array,
    mode: number,
    density: number,
    expansion: number,
  ): Promise<HandleWasm>;
  puppet_mesh_edges(
    handle: number,
    pins: Float32Array,
    mode: number,
    density: number,
    expansion: number,
  ): Float32Array;
  puppet_rest_point(
    handle: number,
    pins: Float32Array,
    mode: number,
    density: number,
    expansion: number,
    x: number,
    y: number,
  ): Float32Array;
  apply_content_aware_scale(
    handle: number,
    sx: number,
    sy: number,
    amount: number,
    protect: boolean,
  ): Promise<HandleWasm>;
  layers_perspective_crop(
    quad: Float32Array,
    width: number,
    height: number,
  ): Promise<Uint32Array>;
}

/** The camelCase facade. */
export interface WarpEngine<Info> {
  /** The sixteen control points of a style over `rect` (flat x/y). */
  warpStyleMesh(spec: WarpStyleSpec, rect: WarpRect): number[];
  /** What a warp of `handle` works on: the selection's bounds, else what
   *  the active layer covers, else the canvas. */
  warpBounds(handle: number): WarpRect;
  /** WARP: `rect` of the active layer bent through `mesh` (16 points). */
  applyMeshWarp(
    handle: number,
    mesh: readonly number[],
    rect: WarpRect,
  ): Promise<Info>;
  /** LIQUIFY: the strokes replayed on a fresh mesh warp the layer. */
  applyLiquify(
    handle: number,
    strokes: readonly LiquifyStroke[],
  ): Promise<Info>;
  /** PUPPET WARP of the active layer. */
  applyPuppetWarp(
    handle: number,
    pins: readonly PuppetPin[],
    options: PuppetOptions,
  ): Promise<Info>;
  /** The bent puppet mesh's edges (flat x0, y0, x1, y1 …, image px). */
  puppetMeshEdges(
    handle: number,
    pins: readonly PuppetPin[],
    options: PuppetOptions,
  ): number[];
  /** Where `at` on the bent layer rests in the unbent one. */
  puppetRestPoint(
    handle: number,
    pins: readonly PuppetPin[],
    options: PuppetOptions,
    at: [number, number],
  ): [number, number];
  /** CONTENT-AWARE SCALE of what the active layer covers. */
  applyContentAwareScale(
    handle: number,
    sx: number,
    sy: number,
    amount: number,
    protect: boolean,
  ): Promise<Info>;
  /** PERSPECTIVE CROP of the whole stack: `quad` (NW, NE, SE, SW, px)
   *  drawn upright onto `width`×`height`. Returns the new extent. */
  layersPerspectiveCrop(
    quad: ReadonlyArray<readonly [number, number]>,
    width: number,
    height: number,
  ): Promise<{ width: number; height: number }>;
}

/** The wire form of Liquify strokes (image-js `apply_liquify`). */
export function liquifyWire(strokes: readonly LiquifyStroke[]): Float32Array {
  const out: number[] = [];
  for (const s of strokes) {
    out.push(
      LIQUIFY_TOOLS.indexOf(s.tool),
      s.size,
      s.pressure,
      s.density,
      s.rate,
      s.points.length,
    );
    for (const p of s.points) out.push(p[0], p[1]);
  }
  return Float32Array.from(out);
}

const pinWire = (pins: readonly PuppetPin[]) =>
  Float32Array.from(pins.flatMap((p) => [p.at[0], p.at[1], p.to[0], p.to[1]]));

export function wrapWarps<Info>(
  wasm: WarpWasm,
  info: (h: HandleWasm) => Info,
): WarpEngine<Info> {
  return {
    warpStyleMesh: (s, r) => [
      ...wasm.warp_style_mesh(
        s.style,
        s.bend,
        s.horizontal,
        s.vertical,
        s.verticalOrientation,
        r.x,
        r.y,
        r.w,
        r.h,
      ),
    ],
    warpBounds(handle) {
      const [x = 0, y = 0, w = 0, h = 0] = wasm.warp_bounds(handle);
      return { x, y, w, h };
    },
    async applyMeshWarp(handle, mesh, rect) {
      return info(
        await wasm.apply_mesh_warp(
          handle,
          Float32Array.from(mesh),
          Uint32Array.from([rect.x, rect.y, rect.w, rect.h]),
        ),
      );
    },
    async applyLiquify(handle, strokes) {
      return info(await wasm.apply_liquify(handle, liquifyWire(strokes)));
    },
    async applyPuppetWarp(handle, pins, o) {
      return info(
        await wasm.apply_puppet_warp(
          handle,
          pinWire(pins),
          o.mode,
          o.density,
          o.expansion,
        ),
      );
    },
    puppetMeshEdges: (handle, pins, o) => [
      ...wasm.puppet_mesh_edges(
        handle,
        pinWire(pins),
        o.mode,
        o.density,
        o.expansion,
      ),
    ],
    puppetRestPoint(handle, pins, o, at) {
      const r = wasm.puppet_rest_point(
        handle,
        pinWire(pins),
        o.mode,
        o.density,
        o.expansion,
        at[0],
        at[1],
      );
      return [r[0] ?? at[0], r[1] ?? at[1]];
    },
    async applyContentAwareScale(handle, sx, sy, amount, protect) {
      return info(
        await wasm.apply_content_aware_scale(handle, sx, sy, amount, protect),
      );
    },
    async layersPerspectiveCrop(quad, width, height) {
      const wh = await wasm.layers_perspective_crop(
        Float32Array.from(quad.flatMap((p) => [p[0], p[1]])),
        width,
        height,
      );
      return { width: wh[0] ?? width, height: wh[1] ?? height };
    },
  };
}
