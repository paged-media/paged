/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// paged.image's TEMPLATE FIELD KINDS (extensions ADR 335; engine ADR 1000,
// amendment 2026-10-23): the parts of an edited image a template can open
// to a filler. A field sits on the image's frame; the engine grants the
// filler `select`, `document.metadata` (this module's own label on the
// frame) and the grants below on that frame only, and checks every write.
//
//   kind               definition                       value
//   picture            { layer?, frame? }               { name, bytes } (read: { name, pending })
//   adjustmentPreset   { allowed, layer?, frame? }      a preset's name
//   layerVisibility    { layer, frame? }                a boolean
//
// `layer` names a layer by its NAME (a session never sees the engine's
// layer ids persisted); `frame` is a Self id, the field's own item when
// absent. Every write is one `host.objects` batch, so one undo step, and
// lands through the object model's own planner (the label-hash commit).
//
// THE GRANT. A write moves this module's label (`document.metadata`) and,
// when the new composite is the identity (one plain visible layer), places
// the baked image (`image.replace`). Any other stack is stored PENDING:
// the frame keeps its previous image until a GPU realm re-composites it.
// The picture's read answers `pending` so a form, a CLI and a check can
// say so instead of showing a stale frame as filled.

import type {
  ObjectsSurface,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";

import { ADJUST_ROWS } from "./adjust";
import {
  imageAddress,
  KIND_PREFIX,
  layerAddress,
  parseImageAddress,
} from "./image-objects";

type Ctx = { objects: ObjectsSurface };

export const PICTURE_FIELD = "media.paged.image.picture";
export const ADJUSTMENT_PRESET_FIELD = "media.paged.image.adjustmentPreset";
export const LAYER_VISIBILITY_FIELD = "media.paged.image.layerVisibility";

/** The manifest's `contributes.objectModel.templateFields[]`. */
export const IMAGE_TEMPLATE_FIELDS: readonly { kind: string; title: string }[] =
  [
    { kind: PICTURE_FIELD, title: "Picture (keeps the adjustments)" },
    { kind: ADJUSTMENT_PRESET_FIELD, title: "Adjustment preset" },
    { kind: LAYER_VISIBILITY_FIELD, title: "Layer visibility" },
  ];

/** The adjustment layer a preset field writes when `layer` is absent. */
export const DEFAULT_PRESET_LAYER = "Preset";

const GRANTS = ["image.replace"] as const;

// ------------------------------------------------------------ helpers

/** A refused write's reason as a sentence: the engine's typed refusal
 *  (`notPermitted`, `locked`) named, any other reason as it came. */
export function refusalSentence(reason: string | undefined, code?: string) {
  if (!reason) return `the write was refused (${code ?? "failed"})`;
  try {
    const e = (
      JSON.parse(reason) as {
        error?: { kind?: string; details?: Record<string, unknown> };
      }
    ).error;
    const d = e?.details ?? {};
    if (e?.kind === "notPermitted")
      return `not permitted: ${String(d["permission"])} on ${String(d["target"])}`;
    if (e?.kind === "locked") return `${String(d["node"])} is locked`;
    if (typeof d["what"] === "string") return d["what"];
    if (e?.kind) return `the engine refused the write (${e.kind})`;
  } catch {
    /* a plain sentence */
  }
  return reason;
}

const refused = (problem: string): TemplateFieldWrite => ({
  ok: false,
  problem,
});

const defOf = (field: TemplateFieldRef): Record<string, unknown> =>
  field.def && typeof field.def === "object"
    ? (field.def as Record<string, unknown>)
    : {};

const frameOf = (field: TemplateFieldRef): string => {
  const f = defOf(field)["frame"];
  return typeof f === "string" && f.length > 0 ? f : field.targetId;
};

const layerNameOf = (field: TemplateFieldRef): string | null => {
  const l = defOf(field)["layer"];
  return typeof l === "string" && l.length > 0 ? l : null;
};

const written = (r: {
  applied: boolean;
  reason?: string;
  code?: string;
}): TemplateFieldWrite =>
  r.applied ? { ok: true } : refused(refusalSentence(r.reason, r.code));

interface LayerInfo {
  address: string;
  name: string;
  kind: string;
}

/** The frame's layers, top first (the object model's list order). */
async function layersOf(ctx: Ctx, frameId: string): Promise<LayerInfo[]> {
  const all = await ctx.objects.query(`${KIND_PREFIX}layer`);
  const out: LayerInfo[] = [];
  for (const address of all) {
    if (parseImageAddress(address)?.frameId !== frameId) continue;
    const [name, kind] = await Promise.all([
      ctx.objects.get(address, "name"),
      ctx.objects.get(address, "kind"),
    ]);
    out.push({
      address,
      name: name.kind === "value" ? String(name.value) : "",
      kind: kind.kind === "value" ? String(kind.value) : "",
    });
  }
  return out;
}

/** The layer a field names, or a problem sentence. Without a name, the
 *  bottom pixel layer (an untouched image's one "Background"). */
async function layerFor(
  ctx: Ctx,
  field: TemplateFieldRef,
  want?: (l: LayerInfo) => boolean,
): Promise<LayerInfo | string> {
  const frame = frameOf(field);
  const layers = await layersOf(ctx, frame);
  if (layers.length === 0) return `${frame} holds no image`;
  const name = layerNameOf(field);
  if (name === null) {
    const bottom = [...layers].reverse().find((l) => l.kind !== "adjustment");
    return bottom ?? `${frame} has no pixel layer`;
  }
  const hit = layers.find((l) => l.name === name && (!want || want(l)));
  return hit ?? `${frame} has no layer "${name}"`;
}

const pendingOf = async (ctx: Ctx, frame: string): Promise<boolean> => {
  const v = await ctx.objects.get(imageAddress(frame), "pending");
  return v.kind === "value" && v.value === true;
};

// ------------------------------------------------------------ picture

const pictureKind: TemplateFieldKindContribution = {
  kind: PICTURE_FIELD,
  title: "Picture (keeps the adjustments)",
  control: { kind: "picture" },
  grants: GRANTS,
  async read(ctx: Ctx, field) {
    const layer = await layerFor(ctx, field, (l) => l.kind !== "adjustment");
    if (typeof layer === "string") return null;
    return {
      name: layer.name,
      pending: await pendingOf(ctx, frameOf(field)),
    };
  },
  async write(ctx: Ctx, field, value) {
    const v = value as { name?: unknown; bytes?: unknown } | null;
    if (!v || !(v.bytes instanceof Uint8Array) || v.bytes.length === 0)
      return refused("choose an image file");
    const layer = await layerFor(ctx, field, (l) => l.kind !== "adjustment");
    if (typeof layer === "string") return refused(layer);
    return written(await ctx.objects.set(layer.address, "content", v.bytes));
  },
};

// --------------------------------------------------- adjustmentPreset

interface Preset {
  name: string;
  rows: Record<string, unknown>;
}

const ROW_DEFAULT = new Map(ADJUST_ROWS.map((r) => [r.path, r.default]));

/** The presets a field allows, or a problem naming the first bad one. */
function presetsOf(field: TemplateFieldRef): Preset[] | string {
  const raw = defOf(field)["allowed"];
  if (!Array.isArray(raw) || raw.length === 0)
    return "the field lists no presets";
  const out: Preset[] = [];
  for (const p of raw) {
    const name = (p as { name?: unknown })?.name;
    const rows = (p as { rows?: unknown })?.rows;
    if (typeof name !== "string" || !rows || typeof rows !== "object")
      return "a preset is { name, rows }";
    for (const path of Object.keys(rows))
      if (!ROW_DEFAULT.has(path))
        return `preset "${name}" sets "${path}", which is no adjustment parameter`;
    out.push({ name, rows: rows as Record<string, unknown> });
  }
  return out;
}

/** Every parameter's value under `preset` (the rest at their defaults). */
const targetOf = (preset: Preset) =>
  new Map(
    ADJUST_ROWS.map((r) => [
      r.path,
      r.path in preset.rows ? preset.rows[r.path] : r.default,
    ]),
  );

const same = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b))
    : JSON.stringify(a) === JSON.stringify(b);

const presetLayerName = (field: TemplateFieldRef) =>
  layerNameOf(field) ?? DEFAULT_PRESET_LAYER;

async function presetLayer(ctx: Ctx, field: TemplateFieldRef) {
  const name = presetLayerName(field);
  return (
    (await layersOf(ctx, frameOf(field))).find(
      (l) => l.name === name && l.kind === "adjustment",
    ) ?? null
  );
}

const adjustmentPresetKind: TemplateFieldKindContribution = {
  kind: ADJUSTMENT_PRESET_FIELD,
  title: "Adjustment preset",
  control: { kind: "choice", options: [] },
  grants: GRANTS,
  describe(_ctx, field) {
    const presets = presetsOf(field);
    return {
      kind: "choice",
      options:
        typeof presets === "string"
          ? []
          : presets.map((p) => ({ value: p.name })),
    };
  },
  async read(ctx: Ctx, field) {
    const presets = presetsOf(field);
    const layer = await presetLayer(ctx, field);
    if (typeof presets === "string" || !layer) return null;
    const adjustment = layer.address.replace(
      `${KIND_PREFIX}layer/`,
      `${KIND_PREFIX}adjustment/`,
    );
    const now = await ctx.objects.getAll(adjustment);
    const value = (path: string) => {
      const v = now[path];
      return v?.kind === "value" ? v.value : undefined;
    };
    const match = presets.find((p) =>
      [...targetOf(p)].every(([path, want]) => same(value(path), want)),
    );
    return match?.name ?? null;
  },
  async write(ctx: Ctx, field, value) {
    const presets = presetsOf(field);
    if (typeof presets === "string") return refused(presets);
    const preset = presets.find((p) => p.name === value);
    if (!preset)
      return refused(
        typeof value === "string" && value.length > 0
          ? `"${value}" is not one of this field's presets`
          : "choose a preset",
      );
    const layer = await presetLayer(ctx, field);
    if (!layer) {
      // A new adjustment layer, on top, carrying the preset's rows, and
      // named in the same batch (one undo step): it takes the stack's
      // next layer id.
      const frame = frameOf(field);
      const next = await ctx.objects.get(imageAddress(frame), "nextLayerId");
      if (next.kind !== "value") return refused(`${frame} holds no image`);
      return written(
        await ctx.objects.batch([
          {
            op: "create",
            kind: `${KIND_PREFIX}adjustment`,
            within: imageAddress(frame),
            props: { ...preset.rows },
          },
          {
            op: "set",
            address: layerAddress("layer", frame, next.value as number),
            path: "name",
            value: presetLayerName(field),
          },
        ]),
      );
    }
    const adjustment = layer.address.replace(
      `${KIND_PREFIX}layer/`,
      `${KIND_PREFIX}adjustment/`,
    );
    const now = await ctx.objects.getAll(adjustment);
    const ops = [...targetOf(preset)]
      .filter(([path, want]) => {
        const v = now[path];
        return !(v?.kind === "value" && same(v.value, want));
      })
      .map(([path, want]) => ({
        op: "set" as const,
        address: adjustment,
        path,
        value: want,
      }));
    if (ops.length === 0) return { ok: true };
    return written(await ctx.objects.batch(ops));
  },
};

// ---------------------------------------------------- layerVisibility

const layerVisibilityKind: TemplateFieldKindContribution = {
  kind: LAYER_VISIBILITY_FIELD,
  title: "Layer visibility",
  control: { kind: "toggle" },
  grants: GRANTS,
  async read(ctx: Ctx, field) {
    if (layerNameOf(field) === null) return null;
    const layer = await layerFor(ctx, field);
    if (typeof layer === "string") return null;
    const v = await ctx.objects.get(layer.address, "visible");
    return v.kind === "value" ? v.value === true : null;
  },
  async write(ctx: Ctx, field, value) {
    if (typeof value !== "boolean") return refused("the value is on or off");
    if (layerNameOf(field) === null) return refused("the field names no layer");
    const layer = await layerFor(ctx, field);
    if (typeof layer === "string") return refused(layer);
    return written(await ctx.objects.set(layer.address, "visible", value));
  },
};

/** Every paged.image template field kind. */
export const imageTemplateFields = (): TemplateFieldKindContribution[] => [
  pictureKind,
  adjustmentPresetKind,
  layerVisibilityKind,
];
