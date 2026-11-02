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

// SAMPLED STYLE — what the Eyedropper's object mode picks up from one
// element and writes onto the selection: frame fill colour and tint, stroke
// colour and weight, opacity. One implementation (PM-0017): the editor's
// Eyedropper is the tool; paged.draw's copy of it is gone.
//
// HONEST SCOPE: these are the element's typed PROPERTIES. Gradients, images,
// effects and overlapping art are not sampled (the pixel mode of the
// Eyedropper is the other way to pick a colour up).
//
//  · KIND-DEPENDENT SUPPORT: a graphic line refuses a fill. Each target is
//    written only the members its OWN property snapshot exposes, so a mixed
//    selection does not poison the batch (engine batches are atomic).
//  · `undefined` is unreadable on the source (skipped); `null` is
//    explicitly none (applied as a clear: no fill). A null tint or opacity
//    carries no information and is skipped.

/** The appearance one click samples. */
export interface SampledStyle {
  fillColor?: string | null;
  fillTint?: number | null;
  strokeColor?: string | null;
  strokeWeight?: number | null;
  opacity?: number | null;
}

/** One entry of an element's property snapshot, as far as this reads it. */
export interface SampledEntry {
  path: string;
  value?: { type: string; value?: unknown } | null;
}

/** Distill a property snapshot into the sampled style, or `null` when
 *  nothing relevant is readable. Pure. */
export function sampledStyleFrom(
  props: { entries: readonly SampledEntry[] } | null | undefined,
): SampledStyle | null {
  if (!props) return null;
  const style: SampledStyle = {};
  let any = false;
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
    }
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
  }
  return ops.length === 0 ? null : { op: "batch", args: { ops } };
}
