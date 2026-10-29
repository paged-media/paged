// The layer manifest (`PGIL`) read and written in TypeScript, so the
// object model can read and change a stored layer stack WITHOUT the
// engine: a property write is a manifest edit, and needs neither the
// wasm's one-stack-per-realm slot (which the interactive session owns)
// nor a GPU.
//
// The format is the engine's (image-js/src/layers_persist.rs): a compact
// manifest plus the buffers it names by slot. Versions 1–7 are read;
// version 7 is written (fill layers, typed adjustment layers, the
// Photoshop-parity properties and layer comps since 4, the styles' state
// since 5, the colour mode since 6, image ADR 479; a smart object's
// placement, file, filters and record since 7, image ADR 482). `writePgil(readPgil(m, b))` reproduces the
// engine's own export byte for byte, including the slot order — the
// object-model spec proves that against the real wasm, so a drift in
// either codec fails there rather than in a document.

const MAGIC = [0x50, 0x47, 0x49, 0x4c]; // "PGIL"
export const PGIL_VERSION = 7;

export interface PgilRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PgilGroup {
  id: number;
  name: string;
  visible: boolean;
  /** 0–1, as the engine holds it (an f32). */
  opacity: number;
  /** The `compose.*` kernel id. */
  blend: string;
  passThrough: boolean;
  parent: number | null;
  maskEnabled: boolean;
  /** Canvas-sized coverage, one byte per pixel. */
  mask: Uint8Array | null;
  /** The colour label (0 none … 7 gray). */
  color: number;
}

export type PgilLayerKind = "pixels" | "adjustment" | "smart" | "fill";

/** A TYPED adjustment layer's payload (kind code 4): `Adjustment::values`
 *  of `kind`, a Color Lookup's cube and look name. */
export interface PgilTyped {
  kind: string;
  values: Float32Array;
  blob: Float32Array;
  label: string;
}

/** A FILL layer's payload (kind code 3): `FillSource::values` of `kind`,
 *  a pattern's tile (straight RGBA8) and name, and whether its render is
 *  due. */
export interface PgilFill {
  kind: string;
  values: Float32Array;
  tile: Uint8Array | null;
  tileWidth: number;
  tileHeight: number;
  name: string;
  stale: boolean;
}

/** The Photoshop-parity properties (version 4's per-layer block). */
export interface PgilExt {
  fillOpacity: number;
  /** 0 none, 1 shallow, 2 deep. */
  knockout: number;
  /** Bits: 1 transparency, 2 position, 4 all. */
  locks: number;
  color: number;
  link: number | null;
  /** Blend If's 32 sliders, or null. */
  blendIf: Uint8Array | null;
  /** Bytes a later version appended (kept as they are). */
  tail: Uint8Array;
}

/** A layer comp's record of one layer. */
export interface PgilCompEntry {
  id: number;
  visible: boolean;
  pixels: Uint8Array | null;
  depth: 8 | 16;
  rect: PgilRect | null;
  appearance: {
    opacity: number;
    fillOpacity: number;
    blend: string;
    knockout: number;
    blendIf: Uint8Array | null;
  } | null;
}

export interface PgilComp {
  id: number;
  name: string;
  /** Bits: 1 visibility, 2 position, 4 appearance. */
  flags: number;
  entries: PgilCompEntry[];
}

export const DEFAULT_EXT: Readonly<PgilExt> = {
  fillOpacity: 1,
  knockout: 0,
  locks: 0,
  color: 0,
  link: null,
  blendIf: null,
  tail: new Uint8Array(0),
};

export interface PgilSmart {
  width: number;
  height: number;
  scale: number;
  /** Straight RGBA8, `width·height·4` — empty when the source is a
   *  file decoded on demand (`ext.file`). */
  source: Uint8Array;
  /** Version 7 (image ADR 482); null for an older manifest's smart
   *  object, which meant the top-left corner at `scale`. */
  ext: PgilSmartExt | null;
}

/** A smart object's version-7 block (`layers_persist.rs` `write_smart`). */
export interface PgilSmartExt {
  /** The corners, eight numbers, or null (the legacy placement). */
  placement: number[] | null;
  file: {
    bytes: Uint8Array;
    name: string;
    /** The file type's four bytes as a big-endian u32. */
    type: number;
    uuid: string;
    linked: boolean;
    path: string;
  } | null;
  /** The smart filters as JSON ("" none). */
  filters: string;
  filterMask: {
    data: Uint8Array;
    /** x −1: canvas-sized. */
    x: number;
    y: number;
    w: number;
    h: number;
    outside: number;
  } | null;
  /** The vector source as JSON ("" none). */
  vector: string;
  /** 1 warped, 2 filters pending. */
  flags: number;
  /** The PSD placed-layer record, or null. */
  record: Uint8Array | null;
}

export interface PgilLayer {
  /** Stable within the stack: survives reorder, persisted. */
  id: number;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: string;
  clipped: boolean;
  group: number | null;
  maskEnabled: boolean;
  kind: PgilLayerKind;
  depth: 8 | 16;
  /** The layer's pixels: canvas-sized, or `rect`-sized when bounded. */
  pixels: Uint8Array;
  rect: PgilRect | null;
  /** Raw f32; 0 = none. */
  blendGamma: number;
  mask: Uint8Array | null;
  /** A bounded mask's rectangle and the coverage outside it. */
  maskRect: (PgilRect & { outside: number }) | null;
  /** A CHAIN adjustment layer's `AdjustParams::to_wire` block. */
  adjust: Float32Array | null;
  /** A typed adjustment layer (an `adjustment` with no `adjust` block). */
  typed: PgilTyped | null;
  fill: PgilFill | null;
  smart: PgilSmart | null;
  ext: PgilExt;
}

export interface PgilStack {
  version: number;
  width: number;
  height: number;
  active: number;
  nextId: number;
  groups: PgilGroup[];
  /** Bottom-first. */
  layers: PgilLayer[];
  comps: PgilComp[];
  /** Version 5: the layer styles' shared state (a layer's own style rides
   *  in its ext block's tail, as the engine's `lfx2` bytes). */
  styles: PgilStyles;
  /** Version 6 (image ADR 479): the document's colour mode — 0 RGB,
   *  1 Grayscale, 2 CMYK, 3 Lab — and the CMYK profile it converts
   *  through (`null`: none). */
  mode: PgilMode;
}

export interface PgilMode {
  color: number;
  profile: Uint8Array | null;
}

export const DEFAULT_MODE: Readonly<PgilMode> = { color: 0, profile: null };

/** The document's Global Light and the patterns its styles draw. */
export interface PgilStyles {
  angle: number;
  altitude: number;
  patterns: {
    name: string;
    width: number;
    height: number;
    scale: number;
    angle: number;
    /** Straight RGBA8, `width·height·4`. */
    tile: Uint8Array;
  }[];
}

export const DEFAULT_STYLES: Readonly<PgilStyles> = {
  angle: 120,
  altitude: 30,
  patterns: [],
};

class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): number {
    const at = this.at;
    if (at + n > this.b.length) throw new Error("layer manifest is truncated");
    this.at += n;
    return at;
  }
  u8 = () => this.b[this.need(1)]!;
  u32 = () => this.view.getUint32(this.need(4), true);
  i32 = () => this.view.getInt32(this.need(4), true);
  i64 = () => Number(this.view.getBigInt64(this.need(8), true));
  f32 = () => this.view.getFloat32(this.need(4), true);
  f64 = () => this.view.getFloat64(this.need(8), true);
  str = () => {
    const n = this.u32();
    const at = this.need(n);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.b.subarray(at, at + n),
    );
  };
  bytes = (n: number) => {
    const at = this.need(n);
    return this.b.subarray(at, at + n);
  };
  f32s = () => {
    const n = this.u32();
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = this.f32();
    return out;
  };
  /** A length-prefixed block, read as a manifest of its own. */
  block = () => new Reader(this.bytes(this.u32()));
  rest = () => this.bytes(this.b.length - this.at);
  blendIf = () => (this.u8() === 0 ? null : this.bytes(32).slice());
}

class Writer {
  private chunks: number[] = [];
  private scratch = new DataView(new ArrayBuffer(8));
  private push(n: number) {
    for (let i = 0; i < n; i++) this.chunks.push(this.scratch.getUint8(i));
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i]!);
  }
  u8 = (v: number) => this.chunks.push(v & 0xff);
  u32 = (v: number) => (this.scratch.setUint32(0, v, true), this.push(4));
  i32 = (v: number) => (this.scratch.setInt32(0, v, true), this.push(4));
  i64 = (v: number) => (
    this.scratch.setBigInt64(0, BigInt(v), true),
    this.push(8)
  );
  f32 = (v: number) => (this.scratch.setFloat32(0, v, true), this.push(4));
  f64 = (v: number) => (this.scratch.setFloat64(0, v, true), this.push(8));
  str = (s: string) => {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.raw(b);
  };
  done = () => Uint8Array.from(this.chunks);
  f32s = (v: ArrayLike<number>) => {
    this.u32(v.length);
    for (let k = 0; k < v.length; k++) this.f32(v[k]!);
  };
  blendIf = (b: Uint8Array | null) => {
    if (b) {
      this.u8(1);
      this.raw(b);
    } else this.u8(0);
  };
}

function readSmartExt(
  r: Reader,
  buf: (slot: number) => Uint8Array,
): PgilSmartExt {
  const placement =
    r.u8() !== 0 ? Array.from({ length: 8 }, () => r.f64()) : null;
  const fileSlot = r.i64();
  const file =
    fileSlot < 0
      ? null
      : {
          bytes: buf(fileSlot),
          name: r.str(),
          type: r.u32(),
          uuid: r.str(),
          linked: r.u8() !== 0,
          path: r.str(),
        };
  const filters = r.str();
  let filterMask: PgilSmartExt["filterMask"] = null;
  if (filters !== "") {
    const maskSlot = r.i64();
    if (maskSlot >= 0) {
      filterMask = {
        data: buf(maskSlot),
        x: r.i32(),
        y: r.i32(),
        w: r.u32(),
        h: r.u32(),
        outside: r.u8(),
      };
    }
  }
  const vector = r.str();
  const flags = r.u8();
  const recordSlot = r.i64();
  return {
    placement,
    file,
    filters,
    filterMask,
    vector,
    flags,
    record: recordSlot < 0 ? null : buf(recordSlot),
  };
}

function writeSmartExt(
  w: Writer,
  ext: PgilSmartExt | null,
  slot: (b: Uint8Array) => number,
): void {
  if (ext?.placement) {
    w.u8(1);
    for (const v of ext.placement) w.f64(v);
  } else w.u8(0);
  if (ext?.file) {
    w.i64(slot(ext.file.bytes));
    w.str(ext.file.name);
    w.u32(ext.file.type);
    w.str(ext.file.uuid);
    w.u8(ext.file.linked ? 1 : 0);
    w.str(ext.file.path);
  } else w.i64(-1);
  w.str(ext?.filters ?? "");
  if (ext && ext.filters !== "") {
    const m = ext.filterMask;
    if (m) {
      w.i64(slot(m.data));
      w.i32(m.x);
      w.i32(m.y);
      w.u32(m.w);
      w.u32(m.h);
      w.u8(m.outside);
    } else w.i64(-1);
  }
  w.str(ext?.vector ?? "");
  w.u8(ext?.flags ?? 0);
  w.i64(ext?.record ? slot(ext.record) : -1);
}

/** Decode a manifest and resolve its slots against `buffers`. Throws a
 *  reason (never a half-read stack). */
export function readPgil(
  manifest: Uint8Array,
  buffers: readonly Uint8Array[],
): PgilStack {
  const r = new Reader(manifest);
  for (const m of MAGIC)
    if (r.u8() !== m) throw new Error("not a layer manifest");
  const version = r.u32();
  if (version < 1 || version > PGIL_VERSION) {
    throw new Error(
      `layer manifest version ${version} (this reader reads 1–${PGIL_VERSION})`,
    );
  }
  const width = r.u32();
  const height = r.u32();
  const active = r.u32();
  const nextId = r.u32();
  const buf = (slot: number) => {
    const b = buffers[slot];
    if (!b) throw new Error(`layer manifest: no buffer ${slot}`);
    return b;
  };
  const opt = (v: number) => (v < 0 ? null : v);
  const groups: PgilGroup[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const id = r.u32();
    const name = r.str();
    const visible = r.u8() !== 0;
    const opacity = r.f32();
    const blend = r.str();
    const passThrough = r.u8() !== 0;
    const parent = opt(r.i64());
    let maskEnabled = true;
    let mask: Uint8Array | null = null;
    if (version >= 2) {
      maskEnabled = r.u8() !== 0;
      const slot = opt(r.i64());
      mask = slot === null ? null : buf(slot);
    }
    let color = 0;
    if (version >= 4) {
      const e = r.block();
      color = Math.min(7, e.u8());
    }
    groups.push({
      id,
      name,
      visible,
      opacity,
      blend,
      passThrough,
      parent,
      maskEnabled,
      mask,
      color,
    });
  }
  const layers: PgilLayer[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const id = r.u32();
    const name = r.str();
    const visible = r.u8() !== 0;
    const locked = r.u8() !== 0;
    const opacity = r.f32();
    const blend = r.str();
    const clipped = r.u8() !== 0;
    const group = opt(r.i64());
    const maskEnabled = r.u8() !== 0;
    const kindCode = r.u8();
    const depth = r.u8();
    if (depth !== 8 && depth !== 16)
      throw new Error(`layer manifest: depth ${depth}`);
    const pixels = buf(r.u32());
    let rect: PgilRect | null = null;
    let blendGamma = 0;
    if (version >= 3) {
      const x = r.i32(),
        y = r.i32(),
        w = r.u32(),
        h = r.u32();
      rect = x >= 0 ? { x, y, w, h } : null;
      blendGamma = r.f32();
    }
    const maskSlot = opt(r.i64());
    let maskRect: PgilLayer["maskRect"] = null;
    if (version >= 3) {
      const x = r.i32(),
        y = r.i32(),
        w = r.u32(),
        h = r.u32(),
        outside = r.u8();
      maskRect = x >= 0 ? { x, y, w, h, outside } : null;
    }
    const mask = maskSlot === null ? null : buf(maskSlot);
    let kind: PgilLayerKind;
    let adjust: Float32Array | null = null;
    let typed: PgilTyped | null = null;
    let fill: PgilFill | null = null;
    let smart: PgilSmart | null = null;
    if (kindCode === 0) kind = "pixels";
    else if (kindCode === 1) {
      kind = "adjustment";
      const count = r.u32();
      adjust = new Float32Array(count);
      for (let k = 0; k < count; k++) adjust[k] = r.f32();
    } else if (kindCode === 2) {
      kind = "smart";
      const sw = r.u32(),
        sh = r.u32(),
        scale = r.f32();
      smart = { width: sw, height: sh, scale, source: buf(r.u32()), ext: null };
      if (version >= 7) smart.ext = readSmartExt(r.block(), buf);
    } else if (kindCode === 3 && version >= 4) {
      kind = "fill";
      const fk = r.str();
      const values = r.f32s();
      const tileSlot = opt(r.i64());
      const tileWidth = r.u32(),
        tileHeight = r.u32();
      const fname = r.str();
      const stale = r.u8() !== 0;
      fill = {
        kind: fk,
        values,
        tile: tileSlot === null ? null : buf(tileSlot),
        tileWidth,
        tileHeight,
        name: fname,
        stale,
      };
    } else if (kindCode === 4 && version >= 4) {
      kind = "adjustment";
      typed = {
        kind: r.str(),
        values: r.f32s(),
        blob: r.f32s(),
        label: r.str(),
      };
    } else throw new Error(`layer manifest: layer kind ${kindCode}`);
    let ext: PgilExt = { ...DEFAULT_EXT };
    if (version >= 4) {
      const e = r.block();
      ext = {
        fillOpacity: e.f32(),
        knockout: e.u8(),
        locks: e.u8(),
        color: e.u8(),
        link: opt(e.i64()),
        blendIf: e.blendIf(),
        tail: e.rest().slice(),
      };
    }
    layers.push({
      id,
      name,
      visible,
      locked,
      opacity,
      blend,
      clipped,
      group,
      maskEnabled,
      kind,
      depth,
      pixels,
      rect,
      blendGamma,
      mask,
      maskRect,
      adjust,
      typed,
      fill,
      smart,
      ext,
    });
  }
  const comps: PgilComp[] = [];
  if (version >= 4) {
    for (let n = r.u32(), i = 0; i < n; i++) {
      const id = r.u32();
      const name = r.str();
      const flags = r.u8();
      const entries: PgilCompEntry[] = [];
      for (let m = r.u32(), k = 0; k < m; k++) {
        const lid = r.u32();
        const visible = r.u8() !== 0;
        const slot = opt(r.i64());
        const depth = r.u8() === 16 ? 16 : 8;
        const x = r.i32(),
          y = r.i32(),
          w = r.u32(),
          h = r.u32();
        const appearance =
          r.u8() === 0
            ? null
            : {
                opacity: r.f32(),
                fillOpacity: r.f32(),
                blend: r.str(),
                knockout: r.u8(),
                blendIf: r.blendIf(),
              };
        entries.push({
          id: lid,
          visible,
          pixels: slot === null ? null : buf(slot),
          depth,
          rect: x >= 0 ? { x, y, w, h } : null,
          appearance,
        });
      }
      comps.push({ id, name, flags, entries });
    }
  }
  const styles: PgilStyles = { ...DEFAULT_STYLES, patterns: [] };
  if (version >= 5) {
    styles.angle = r.f32();
    styles.altitude = r.f32();
    for (let n = r.u32(), i = 0; i < n; i++) {
      const name = r.str();
      const pw = r.u32(),
        ph = r.u32();
      const scale = r.f32(),
        angle = r.f32();
      styles.patterns.push({
        name,
        width: pw,
        height: ph,
        scale,
        angle,
        tile: buf(r.u32()),
      });
    }
  }
  const mode: PgilMode = { ...DEFAULT_MODE };
  if (version >= 6) {
    mode.color = r.u8();
    const at = r.i64();
    mode.profile = at >= 0 ? buf(at) : null;
  }
  return {
    version,
    width,
    height,
    active,
    nextId,
    groups,
    layers,
    comps,
    styles,
    mode,
  };
}

/** Encode a stack as the engine's version-7 export: the manifest first,
 *  then the buffers, slots assigned in the engine's order (group masks,
 *  then per layer: pixels, mask, smart source). */
export function writePgil(stack: PgilStack): Uint8Array[] {
  const w = new Writer();
  const buffers: Uint8Array[] = [];
  const slot = (b: Uint8Array) => (buffers.push(b), buffers.length - 1);
  w.raw(MAGIC);
  w.u32(PGIL_VERSION);
  w.u32(stack.width);
  w.u32(stack.height);
  w.u32(stack.active);
  w.u32(stack.nextId);
  w.u32(stack.groups.length);
  for (const g of stack.groups) {
    w.u32(g.id);
    w.str(g.name);
    w.u8(g.visible ? 1 : 0);
    w.f32(g.opacity);
    w.str(g.blend);
    w.u8(g.passThrough ? 1 : 0);
    w.i64(g.parent ?? -1);
    w.u8(g.maskEnabled ? 1 : 0);
    w.i64(g.mask ? slot(g.mask) : -1);
    w.u32(1);
    w.u8(g.color);
  }
  w.u32(stack.layers.length);
  for (const l of stack.layers) {
    w.u32(l.id);
    w.str(l.name);
    w.u8(l.visible ? 1 : 0);
    w.u8(l.locked ? 1 : 0);
    w.f32(l.opacity);
    w.str(l.blend);
    w.u8(l.clipped ? 1 : 0);
    w.i64(l.group ?? -1);
    w.u8(l.maskEnabled ? 1 : 0);
    w.u8(
      l.kind === "pixels"
        ? 0
        : l.kind === "adjustment"
          ? l.typed
            ? 4
            : 1
          : l.kind === "smart"
            ? 2
            : 3,
    );
    w.u8(l.depth);
    w.u32(slot(l.pixels));
    if (l.rect) {
      w.i32(l.rect.x);
      w.i32(l.rect.y);
      w.u32(l.rect.w);
      w.u32(l.rect.h);
    } else {
      w.i32(-1);
      w.i32(-1);
      w.u32(0);
      w.u32(0);
    }
    w.f32(l.blendGamma);
    w.i64(l.mask ? slot(l.mask) : -1);
    if (l.mask && l.maskRect) {
      w.i32(l.maskRect.x);
      w.i32(l.maskRect.y);
      w.u32(l.maskRect.w);
      w.u32(l.maskRect.h);
      w.u8(l.maskRect.outside);
    } else {
      w.i32(-1);
      w.i32(-1);
      w.u32(0);
      w.u32(0);
      w.u8(0);
    }
    if (l.kind === "adjustment" && l.typed) {
      w.str(l.typed.kind);
      w.f32s(l.typed.values);
      w.f32s(l.typed.blob);
      w.str(l.typed.label);
    } else if (l.kind === "adjustment") {
      const a = l.adjust ?? new Float32Array(0);
      w.u32(a.length);
      for (const v of a) w.f32(v);
    } else if (l.kind === "smart") {
      const s = l.smart!;
      w.u32(s.width);
      w.u32(s.height);
      w.f32(s.scale);
      w.u32(slot(s.source));
      const e = new Writer();
      writeSmartExt(e, s.ext, slot);
      const block = e.done();
      w.u32(block.length);
      w.raw(block);
    } else if (l.kind === "fill") {
      const f = l.fill!;
      w.str(f.kind);
      w.f32s(f.values);
      w.i64(f.tile ? slot(f.tile) : -1);
      w.u32(f.tile ? f.tileWidth : 0);
      w.u32(f.tile ? f.tileHeight : 0);
      w.str(f.name);
      w.u8(f.stale ? 1 : 0);
    }
    const e = new Writer();
    e.f32(l.ext.fillOpacity);
    e.u8(l.ext.knockout);
    e.u8(l.ext.locks);
    e.u8(l.ext.color);
    e.i64(l.ext.link ?? -1);
    e.blendIf(l.ext.blendIf);
    e.raw(l.ext.tail);
    const eb = e.done();
    w.u32(eb.length);
    w.raw(eb);
  }
  w.u32(stack.comps.length);
  for (const c of stack.comps) {
    w.u32(c.id);
    w.str(c.name);
    w.u8(c.flags);
    w.u32(c.entries.length);
    for (const e of c.entries) {
      w.u32(e.id);
      w.u8(e.visible ? 1 : 0);
      w.i64(e.pixels ? slot(e.pixels) : -1);
      w.u8(e.depth);
      if (e.pixels && e.rect) {
        w.i32(e.rect.x);
        w.i32(e.rect.y);
        w.u32(e.rect.w);
        w.u32(e.rect.h);
      } else {
        w.i32(-1);
        w.i32(-1);
        w.u32(0);
        w.u32(0);
      }
      if (e.appearance) {
        w.u8(1);
        w.f32(e.appearance.opacity);
        w.f32(e.appearance.fillOpacity);
        w.str(e.appearance.blend);
        w.u8(e.appearance.knockout);
        w.blendIf(e.appearance.blendIf);
      } else w.u8(0);
    }
  }
  w.f32(stack.styles.angle);
  w.f32(stack.styles.altitude);
  w.u32(stack.styles.patterns.length);
  for (const p of stack.styles.patterns) {
    w.str(p.name);
    w.u32(p.width);
    w.u32(p.height);
    w.f32(p.scale);
    w.f32(p.angle);
    w.u32(slot(p.tile));
  }
  w.u8(stack.mode.color);
  w.i64(stack.mode.profile ? slot(stack.mode.profile) : -1);
  return [w.done(), ...buffers];
}

/** A deep-enough copy to edit without touching the original (buffers
 *  are shared: an edit REPLACES a buffer, never writes into one). */
export function clonePgil(s: PgilStack): PgilStack {
  return {
    ...s,
    groups: s.groups.map((g) => ({ ...g })),
    layers: s.layers.map((l) => ({
      ...l,
      rect: l.rect ? { ...l.rect } : null,
      maskRect: l.maskRect ? { ...l.maskRect } : null,
      adjust: l.adjust ? l.adjust.slice() : null,
      typed: l.typed ? { ...l.typed, values: l.typed.values.slice() } : null,
      fill: l.fill ? { ...l.fill, values: l.fill.values.slice() } : null,
      smart: l.smart
        ? { ...l.smart, ext: l.smart.ext ? { ...l.smart.ext } : null }
        : null,
      ext: { ...l.ext },
    })),
    comps: s.comps.map((c) => ({
      ...c,
      entries: c.entries.map((e) => ({ ...e })),
    })),
    styles: { ...s.styles, patterns: s.styles.patterns.map((p) => ({ ...p })) },
    mode: { ...s.mode },
  };
}

/** The engine's one-layer stack over an image (`LayerStack::from_image`):
 *  layer id 1, "Background", next id 2. */
export function stackFromImage(
  width: number,
  height: number,
  rgba: Uint8Array,
): PgilStack {
  return {
    version: PGIL_VERSION,
    width,
    height,
    active: 0,
    nextId: 2,
    groups: [],
    layers: [
      {
        id: 1,
        name: "Background",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "compose.normal",
        clipped: false,
        group: null,
        maskEnabled: true,
        kind: "pixels",
        depth: 8,
        pixels: rgba,
        rect: null,
        blendGamma: 0,
        mask: null,
        maskRect: null,
        adjust: null,
        typed: null,
        fill: null,
        smart: null,
        ext: { ...DEFAULT_EXT },
      },
    ],
    comps: [],
    styles: { ...DEFAULT_STYLES, patterns: [] },
    mode: { ...DEFAULT_MODE },
  };
}
