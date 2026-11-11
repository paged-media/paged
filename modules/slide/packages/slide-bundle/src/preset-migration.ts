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

// The lift of the earlier live-preset labels (slide ADR 717, amendment of
// 2026-11-11). A preset is the engine's live shape now (engine ADR 1096):
// the engine refits a resized preset, routes a glued connector and serves the
// adjust handles. A document saved before that labels its preset shapes with
// `preset`, `box` and `connector` instead; when such a document opens, the
// slide engine reads it (`migrate`, slide-native `migrate`) and the bundle
// writes the engine's preset on each path that still draws it, the preset key
// on the shape's text frame and the labels without the old keys, in one batch:
// one named undo step ("Update shapes"), as the host has no write outside the
// undo history. Export reads an old document through the
// same lift, so it writes the same deck whether or not the batch ran.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import type { PresetLift, SlideEngine } from "./engine.js";
import { LABEL_KEY } from "./object-model.js";

/** Whether a slide label still carries the earlier live-preset keys (a
 *  chart frame's `box` is the chart's own). */
export function isOldLabel(label: string): boolean {
  let data: Record<string, unknown> | undefined;
  try {
    data = (JSON.parse(label) as { data?: Record<string, unknown> }).data;
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  if ("preset" in data || "connector" in data || "part" in data) return true;
  return "box" in data && !("chart" in data);
}

/** Whether any element of the document's tree has such a label. */
export async function hasOldLabels(host: BundleHost): Promise<boolean> {
  const walk = (nodes: readonly SceneTreeNode[] | undefined): boolean =>
    (nodes ?? []).some((n) => {
      const label = n.pluginMetadata?.find((m) => m.key === LABEL_KEY)?.value;
      return (label != null && isOldLabel(label)) || walk(n.children);
    });
  return walk(await host.document.tree());
}

/** The batch that writes `lifts`: the engine's preset on each path, the
 *  preset key on each text frame of a lifted shape (so it follows the
 *  shape's resize), then each label without the old keys. `null` when there
 *  is nothing to write. */
export function liftMutation(
  lifts: readonly PresetLift[],
): MutationInput | null {
  const ops: MutationInput[] = [];
  for (const l of lifts) {
    const elementId = { kind: l.kind, id: l.id } as ElementId;
    if (l.kind === "polygon" && l.preset) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameShapePreset",
          value: { type: "text", value: JSON.stringify(l.preset) },
        },
      } as MutationInput);
    }
    if (l.kind === "textFrame" && l.presetText) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameShapePresetText",
          value: { type: "text", value: l.presetText },
        },
      } as MutationInput);
    }
    ops.push({
      op: "setPluginMetadata",
      args: { elementId, key: LABEL_KEY, value: l.label },
    } as MutationInput);
  }
  return ops.length > 0
    ? ({ op: "batch", args: { ops } } as MutationInput)
    : null;
}

/** Lift the open document once, if it carries the earlier labels. Returns
 *  how many elements were written. */
export async function liftOldLabels(
  host: BundleHost,
  engine: () => Promise<SlideEngine>,
): Promise<number> {
  if (!host.supports("documents.exportPaged@1")) return 0;
  if (!(await hasOldLabels(host))) return 0;
  const paged = await host.documents.exportPaged();
  const lifts = (await engine()).migrate(paged);
  const m = liftMutation(lifts);
  if (!m) return 0;
  const out = await host.document.mutate(m, { label: "Update shapes" });
  if (!out.applied) {
    host.log.warn(
      `paged.slide: the earlier preset labels were not lifted (${JSON.stringify(out.error)})`,
    );
    return 0;
  }
  return lifts.length;
}
