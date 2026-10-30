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

// The lowering kit's look translator (extensions ADR 347; engine ADR 1045).
//
// A module that lowers a foreign format onto native page items decides an
// item's look in its own code (DrawingML through the shared mapper, a CSS
// filter, a PSD layer style) and states it as a `NativeFx`: a fill, a
// gradient, an outline, an opacity, the effects, colours as `#RRGGBB`. This
// file is the ONE translation of that statement into the engine's ops — the
// `setElementProperty` writes a free frame, a path or an anchored frame
// takes. The module supplies what is its own: the swatch each colour is
// painted with, the gradient swatch, where the item's box starts.
//
// `NativeFx` is `dml_native::native::NativeFx` (platform/shared/dml-native)
// as it serialises, so a module's Rust IR carries it to here unchanged.

import type {
  ElementId,
  Mutation,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

/** A gradient fill. `stops` are `[location 0–100, #RRGGBB]`, in order. */
export interface NativeGradient {
  kind: "linear" | "radial";
  stops: [number, string][];
  /** The engine's angle (counter-clockwise degrees); linear only. */
  angle?: number;
  /** The axis length (linear) or the radius (radial), pt. */
  length?: number;
  /** The axis start (linear) or the centre (radial), pt from the item
   *  box's top-left. */
  start?: [number, number];
}

/** An outline, as the item's stroke fields hold it. */
export interface NativeStroke {
  color: string;
  /** pt. */
  weight: number;
  /** The engine's stroke type (`StrokeStyle/$ID/Dashed`, …). */
  kind?: string;
  /** The dash pattern, pt on/off. */
  dash?: number[];
  cap?: string;
  join?: string;
  miterLimit?: number;
}

/** A drop shadow. */
export interface NativeShadow {
  xOffset: number;
  yOffset: number;
  /** The blur size, pt. */
  size: number;
  /** 0–100. */
  opacity: number;
  color: string;
}

/** An inner shadow, as the engine's editors address it. */
export interface NativeInnerShadow {
  /** Counter-clockwise degrees. */
  angle: number;
  distance: number;
  size: number;
  opacity: number;
  color: string;
}

/** An outer glow. */
export interface NativeGlow {
  size: number;
  opacity: number;
  color: string;
}

/** A gradient feather: `stops` are `[location 0–100, opacity 0–100]`. */
export interface NativeFeather {
  gradientType: string;
  angle?: number;
  stops: [number, number][];
}

/** One entry of an item's effect stack (engine ADR 1008), as the wire's
 *  `EffectEntrySpec` states it with its colour as `#RRGGBB`. An InDesign
 *  kind (`dropShadow`, `innerShadow`, `outerGlow`, `feather`,
 *  `gradientFeather`) carries only its place; its parameters are the
 *  item's own fields. */
export interface NativeEffect {
  kind: string;
  blendMode?: string;
  opacityPct?: number;
  radiusPt?: number;
  color?: string;
  distancePt?: number;
  sizePct?: number;
  startOpacityPct?: number;
  endOpacityPct?: number;
  blurPt?: number;
}

/** What an item carries beyond its geometry, each field omitted when
 *  unset. Colours are `#RRGGBB`, lengths pt, opacities 0–100. */
export interface NativeFx {
  /** A solid fill (its alpha is the item's `opacity`). */
  fill?: string;
  gradient?: NativeGradient;
  stroke?: NativeStroke;
  /** The item's opacity. */
  opacity?: number;
  dropShadow?: NativeShadow;
  innerShadow?: NativeInnerShadow;
  outerGlow?: NativeGlow;
  /** A soft edge's width. */
  feather?: number;
  gradientFeather?: NativeFeather;
  /** The item's effect stack, when it holds an effect InDesign has none
   *  of (a blur, a colour overlay, a reflection): every effect in the
   *  order it is drawn. */
  effectStack?: NativeEffect[];
}

/** What the module decides for {@link nativeFxOps}. */
export interface NativeFxOptions {
  /** The item the ops write: an id, a `$h:` handle bound earlier in the
   *  batch, or the batch's `$created` sentinel. */
  target: ElementId;
  /** The swatch (`Color/…`) a `#RRGGBB` colour is painted with. */
  color: (hex: string) => string;
  /** The gradient swatch a gradient fill is painted with. Without it the
   *  module paints the fill itself, and only the gradient's placement is
   *  written. */
  gradient?: (g: NativeGradient) => string;
  /** Where the item's box starts, in the coordinates the engine reads the
   *  item's gradient start in: the spread for a page item, `[0, 0]` for an
   *  anchored frame (its own box). Without it no start is written, and the
   *  engine's default placement stands. */
  origin?: [number, number];
  /** Whether the item has a fill: a line does not, and takes neither the
   *  gradient nor the gradient feather. Default `true`. */
  filled?: boolean;
}

/**
 * The ops that give an item its look: fill or gradient, outline, opacity,
 * drop and inner shadow, glow, soft edge, gradient feather and the effect
 * stack, in that order. PURE and deterministic; nothing for an absent or empty `fx`.
 *
 * Every path is a free frame's own (`frameFillColor`, `frameOpacity`,
 * `frameDropShadow`, …), which since engine ADR 1045 reaches an anchored
 * frame too: one translation serves both.
 */
export function nativeFxOps(
  fx: NativeFx | undefined,
  opts: NativeFxOptions,
): Mutation[] {
  if (!fx) return [];
  const ops: Mutation[] = [];
  const set = (path: PropertyPath, value: Value) =>
    ops.push({
      op: "setElementProperty",
      args: { elementId: opts.target, path, value },
    });
  const len = (v: number): Value => ({ type: "length", value: v });
  const on: Value = { type: "bool", value: true };
  const text = (v: string): Value => ({ type: "text", value: v });
  const color = (hex: string): Value => ({
    type: "colorRef",
    value: opts.color(hex),
  });
  const filled = opts.filled ?? true;
  const g = filled ? fx.gradient : undefined;
  if (g && opts.gradient) {
    set("frameFillColor", { type: "colorRef", value: opts.gradient(g) });
  } else if (fx.fill != null && filled) {
    set("frameFillColor", color(fx.fill));
  }
  if (g) {
    if (g.angle != null) set("frameGradientFillAngle", len(g.angle));
    if (g.length != null) set("frameGradientFillLength", len(g.length));
    if (g.start && opts.origin) {
      set("frameGradientFillStart", {
        type: "lengths",
        value: [opts.origin[0] + g.start[0], opts.origin[1] + g.start[1]],
      });
    }
  }
  const s = fx.stroke;
  if (s) {
    set("frameStrokeColor", color(s.color));
    set("frameStrokeWeight", len(s.weight));
    if (s.kind) set("frameStrokeType", text(s.kind));
    if (s.dash?.length)
      set("frameStrokeDashArray", { type: "lengths", value: s.dash });
    if (s.cap) set("frameStrokeEndCap", text(s.cap));
    if (s.join) set("frameStrokeJoin", text(s.join));
    if (s.miterLimit != null) set("frameStrokeMiterLimit", len(s.miterLimit));
  }
  if (fx.opacity != null) set("frameOpacity", len(fx.opacity));
  const d = fx.dropShadow;
  if (d) {
    set("frameDropShadow", on);
    set("frameDropShadowXOffset", len(d.xOffset));
    set("frameDropShadowYOffset", len(d.yOffset));
    set("frameDropShadowSize", len(d.size));
    set("frameDropShadowOpacity", len(d.opacity));
    set("frameDropShadowColor", color(d.color));
  }
  const i = fx.innerShadow;
  if (i) {
    set("frameInnerShadowEnabled", on);
    set("frameInnerShadowBlendMode", text("Normal"));
    set("frameInnerShadowAngle", len(i.angle));
    set("frameInnerShadowDistance", len(i.distance));
    set("frameInnerShadowSize", len(i.size));
    set("frameInnerShadowOpacity", len(i.opacity));
    set("frameInnerShadowColor", color(i.color));
  }
  const o = fx.outerGlow;
  if (o) {
    set("frameOuterGlowEnabled", on);
    set("frameOuterGlowBlendMode", text("Normal"));
    set("frameOuterGlowSize", len(o.size));
    set("frameOuterGlowOpacity", len(o.opacity));
    set("frameOuterGlowColor", color(o.color));
  }
  if (fx.feather != null) {
    set("frameFeatherEnabled", on);
    set("frameFeatherWidth", len(fx.feather));
  }
  const gf = filled ? fx.gradientFeather : undefined;
  if (gf) {
    set("frameGradientFeather", {
      type: "gradientFeather",
      value: {
        gradientType: gf.gradientType,
        ...(gf.angle != null ? { angleDeg: gf.angle } : {}),
        stops: gf.stops.map(([locationPct, alphaPct]) => ({
          locationPct,
          alphaPct,
        })),
      },
    });
  }
  // The stack last: its InDesign entries take the parameters written
  // above; an unfilled item draws no gradient feather, so it names none.
  const stack = (fx.effectStack ?? []).filter(
    (e) => filled || e.kind !== "gradientFeather",
  );
  if (stack.length > 0) {
    set("frameEffectStack", {
      type: "effectStack",
      value: {
        entries: stack.map(({ color: hex, ...e }) =>
          hex != null ? { ...e, color: opts.color(hex) } : e,
        ),
      },
    } as Value);
  }
  return ops;
}

/** Every colour `fx` paints with (`#RRGGBB`, as written), in the order
 *  {@link nativeFxOps} uses them: what the module mints swatches for. A
 *  gradient's stops count only when `filled`. */
export function nativeFxColors(
  fx: NativeFx | undefined,
  filled = true,
): string[] {
  if (!fx) return [];
  const out: string[] = [];
  if (filled && fx.fill != null) out.push(fx.fill);
  if (filled) for (const [, hex] of fx.gradient?.stops ?? []) out.push(hex);
  if (fx.stroke) out.push(fx.stroke.color);
  for (const c of [
    fx.dropShadow?.color,
    fx.innerShadow?.color,
    fx.outerGlow?.color,
  ])
    if (c != null) out.push(c);
  for (const e of fx.effectStack ?? []) if (e.color != null) out.push(e.color);
  return out;
}

/** A location as an id segment: to the thousandth, `.` as `p`. */
function idNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000).replace(".", "p");
}

/** `#rgb` / `#RRGGBB` (any case) as `RRGGBB`, or null. */
function hexBody(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const b = m[1]!;
  const full = b.length === 3 ? b[0]! + b[0] + b[1] + b[1] + b[2] + b[2] : b;
  return full.toUpperCase();
}

/** The content-addressed id of a gradient swatch under `prefix`
 *  (`Gradient/u…`): its kind and its stops, so the same ramp is ONE swatch
 *  however often it is used or lowered. */
export function nativeGradientId(prefix: string, g: NativeGradient): string {
  const stops = g.stops
    .map(([at, hex]) => `${idNumber(at)}-${hexBody(hex) ?? "000000"}`)
    .join("-");
  return `${prefix}${g.kind === "radial" ? "R" : "L"}-${stops}`;
}

/** What {@link nativeGradientMintOps} needs from the module. */
export interface GradientMintOptions {
  /** The id prefix ({@link nativeGradientId}). */
  prefix: string;
  /** The swatch a stop's colour names (minted before the gradient). */
  color: (hex: string) => string;
  /** The swatch's name; `n` counts the gradients this call mints. */
  name: (n: number) => string;
  /** The ids the document already holds, read before the batch: core
   *  refuses a duplicate create, and the refusal fails the whole batch.
   *  `null` (the read failed) mints nothing; omitted mints everything. */
  known?: ReadonlySet<string> | null;
}

/** The `createGradient` ops for every distinct gradient of `gradients` the
 *  document does not hold yet, in first-use order. */
export function nativeGradientMintOps(
  gradients: Iterable<NativeGradient>,
  opts: GradientMintOptions,
): Mutation[] {
  if (opts.known === null) return [];
  const seen = new Set<string>();
  const ops: Mutation[] = [];
  for (const g of gradients) {
    const id = nativeGradientId(opts.prefix, g);
    if (seen.has(id) || opts.known?.has(id)) continue;
    seen.add(id);
    ops.push({
      op: "createGradient",
      args: {
        spec: {
          selfId: id,
          name: opts.name(seen.size),
          kind: g.kind === "radial" ? "Radial" : "Linear",
          stops: g.stops.map(([at, hex]) => ({
            stopColor: opts.color(hex),
            locationPct: at,
          })),
        },
      },
    });
  }
  return ops;
}
