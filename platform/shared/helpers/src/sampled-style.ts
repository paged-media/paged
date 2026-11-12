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

// SAMPLED STYLE — the appearance one element lends another: what the
// Eyedropper's object mode picks up from one element and writes onto the
// selection, and what paged.slide's Format Painter copies from a shape and
// pastes onto others. One implementation (PM-0017, P2): the editor's
// Eyedropper and slide's painter both sample and write through this file;
// paged.draw's copy of the eyedropper is gone.
//
// WHAT IS SAMPLED: the element's typed appearance PROPERTIES — fill colour
// and tint, stroke colour and weight, opacity (the typed members), and the
// rest of the look (`look`): every other fill, stroke and gradient path,
// every effect's settings, the blend modes and the content's opacity.
// Geometry, size, text and the fill rule (which the outline decides) stay
// the target's. Images and overlapping art are not sampled (the pixel mode
// of the Eyedropper is the other way to pick a colour up).
//
//  · KIND-DEPENDENT SUPPORT: a graphic line refuses a fill. Each target is
//    written only the paths its OWN property snapshot exposes, so a mixed
//    selection does not poison the batch (engine batches are atomic).
//  · `undefined` is unreadable on the source (skipped); a null fill or
//    stroke colour is explicitly none (applied as a clear: no fill). A null
//    tint, opacity or `look` value carries no information and is skipped.
//  · An effect switched OFF on the source goes as its switch alone: writing
//    any of its settings would switch it on in the target (the engine
//    materialises an effect from any of its fields).

/** The appearance one click samples. */
export interface SampledStyle {
  fillColor?: string | null;
  fillTint?: number | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
  opacity?: number | null;
  /** The rest of the look, path by path (absent when there is none). */
  look?: SampledEntry[];
}

/** One entry of an element's property snapshot, as far as this reads it. */
export interface SampledEntry {
  path: string;
  value?: { type: string; value?: unknown } | null;
}

/** The look's paths: fill, line, gradient and every effect by prefix. */
const LOOK_PREFIXES = [
  "frameFill",
  "frameStroke",
  "frameGradient",
  "frameDropShadow",
  "frameInnerShadow",
  "frameOuterGlow",
  "frameInnerGlow",
  "frameBevel",
  "frameSatin",
  "frameFeather",
  "frameDirectionalFeather",
] as const;
const LOOK_PATHS = new Set<string>([
  "frameOpacity",
  "frameBlendMode",
  "frameContentOpacity",
  "frameContentBlendMode",
]);
/** Not appearance: how a path is filled, which the outline decides. */
const LOOK_EXCLUDED = new Set<string>(["frameFillRule"]);

/** Is `path` part of an element's appearance (what this file samples)? */
export function isAppearancePath(path: string): boolean {
  return (
    !LOOK_EXCLUDED.has(path) &&
    (LOOK_PATHS.has(path) || LOOK_PREFIXES.some((p) => path.startsWith(p)))
  );
}

/** The effects with a switch of their own: their prefix and the switch's
 *  path (`frameBevel…`, `frameBevelEnabled`). */
const SWITCHED: readonly [string, string][] = [
  ["frameDropShadow", "frameDropShadow"],
  ["frameInnerShadow", "frameInnerShadowEnabled"],
  ["frameOuterGlow", "frameOuterGlowEnabled"],
  ["frameInnerGlow", "frameInnerGlowEnabled"],
  ["frameBevel", "frameBevelEnabled"],
  ["frameSatin", "frameSatinEnabled"],
  ["frameFeather", "frameFeatherEnabled"],
  ["frameDirectionalFeather", "frameDirectionalFeatherEnabled"],
  ["frameGradientFeather", "frameGradientFeather"],
];

/** `entries` without the settings of the effects they switch off (the
 *  switch itself stays, off). Pure. */
export function withoutOffEffects<E extends SampledEntry>(
  entries: readonly E[],
): E[] {
  const isOff = (path: string) =>
    entries.some((e) => e.path === path && e.value?.value === false);
  const off = new Map(SWITCHED.filter(([, sw]) => isOff(sw)));
  // The longest prefix a path starts with owns it.
  const owner = (path: string) =>
    SWITCHED.map(([p]) => p)
      .filter((p) => path.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
  return entries.filter((e) => {
    const o = owner(e.path);
    return !o || !off.has(o) || e.path === off.get(o);
  });
}

/** The typed members' paths (sampled as members, not in `look`). */
const TYPED = new Set([
  "frameFillColor",
  "frameFillTint",
  "frameStrokeColor",
  "frameStrokeWeight",
  "frameOpacity",
]);

/** Distill a property snapshot into the sampled style, or `null` when
 *  nothing relevant is readable. Pure. */
export function sampledStyleFrom(
  props: { entries: readonly SampledEntry[] } | null | undefined,
): SampledStyle | null {
  if (!props) return null;
  const style: SampledStyle = {};
  let any = false;
  const look: SampledEntry[] = [];
  for (const entry of props.entries) {
    const v = entry.value;
    if (!v) continue;
    if (entry.path === "frameFillColor" && v.type === "colorRef") {
      style.fillColor = v.value as string | null;
      any = true;
    } else if (entry.path === "frameFillTint" && v.type === "length") {
      style.fillTint = v.value as number | null;
      any = true;
    } else if (entry.path === "frameStrokeColor" && v.type === "colorRef") {
      style.strokeColor = v.value as string | null;
      any = true;
    } else if (entry.path === "frameStrokeWeight" && v.type === "length") {
      style.strokeWeight = v.value as number | null;
      any = true;
    } else if (entry.path === "frameOpacity" && v.type === "length") {
      style.opacity = v.value as number | null;
      any = true;
    } else if (
      !TYPED.has(entry.path) &&
      isAppearancePath(entry.path) &&
      v.value !== null &&
      v.value !== undefined
    ) {
      look.push({ path: entry.path, value: v });
    }
  }
  const kept = withoutOffEffects(look);
  if (kept.length > 0) {
    style.look = kept;
    any = true;
  }
  return any ? style : null;
}
/** One apply target: the element and the property paths its own snapshot
 *  exposes. */
export interface SampledTarget<Id = unknown> {
  id: Id;
  supports: ReadonlySet<string>;
}

/** The ONE `batch` applying `style` to `targets` (readable members × the
 *  paths each target supports: one undo step), or `null` when there is
 *  nothing to write. */
export function applySampledStyle<Id>(
  targets: readonly SampledTarget<Id>[],
  style: SampledStyle,
): {
  op: "batch";
  args: {
    ops: {
      op: "setElementProperty";
      args: { elementId: Id; path: string; value: unknown };
    }[];
  };
} | null {
  const ops: {
    op: "setElementProperty";
    args: { elementId: Id; path: string; value: unknown };
  }[] = [];
  const write = (elementId: Id, path: string, value: unknown) =>
    ops.push({ op: "setElementProperty", args: { elementId, path, value } });
  for (const { id, supports } of targets) {
    if (style.fillColor !== undefined && supports.has("frameFillColor"))
      write(id, "frameFillColor", { type: "colorRef", value: style.fillColor });
    if (
      style.fillTint !== undefined &&
      style.fillTint !== null &&
      supports.has("frameFillTint")
    )
      write(id, "frameFillTint", { type: "length", value: style.fillTint });
    if (style.strokeColor !== undefined && supports.has("frameStrokeColor"))
      write(id, "frameStrokeColor", {
        type: "colorRef",
        value: style.strokeColor,
      });
    if (style.strokeWeight !== undefined && supports.has("frameStrokeWeight"))
      write(id, "frameStrokeWeight", {
        type: "length",
        value: style.strokeWeight,
      });
    if (
      style.opacity !== undefined &&
      style.opacity !== null &&
      supports.has("frameOpacity")
    )
      write(id, "frameOpacity", { type: "length", value: style.opacity });
    for (const e of style.look ?? [])
      if (supports.has(e.path)) write(id, e.path, e.value);
  }
  return ops.length === 0 ? null : { op: "batch", args: { ops } };
}
