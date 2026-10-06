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

// `graphicStyle` — one entry of the graphic-style LIBRARY (ADR 323).
//
// PLUGIN STATE, written with the label-hash pattern (src/recipe-store.ts):
// the new library in a content-addressed part + the document label in
// the registry's ONE commit. Illustrator's semantics ride along in the
// SAME commit: editing a style RE-APPLIES it to every linked element
// (`applyGraphicStyleBatchFor` per follower — base paint, bake, stamp),
// overrides included (commands/graphic-styles.ts decision 2), and
// deleting one unlinks every follower first. So "change the style" and
// "the page follows" are one undo step, where the commands pay one per
// element plus an unundoable library write.
//
// The BASE paint follows the top layers (the bake rule): a write is
// projected with the full rectangle vocabulary, exactly as Save reads a
// rectangle, so `baseStroke*` of a style with strokes is its top stroke.

import type {
  BundleHost,
  MutationInput,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
} from "@paged-media/plugin-api";

import type { FillLayer, StrokeLayer } from "../commands/appearance";
import { stampDrawMetadata } from "../commands/appearance-bake";
import {
  GRAPHIC_STYLES_PART,
  GRAPHIC_STYLE_BASE_PATHS,
  applyGraphicStyleBatchFor,
  findGraphicStyle,
  graphicStyleLinkCounts,
  graphicStyleLinks,
  graphicStyleRefusalOf,
  mintGraphicStyleId,
  projectGraphicAppearance,
  readGraphicAppearance,
  readGraphicStyleLibrary,
  removeGraphicStyleFrom,
  serializeGraphicStyleLibrary,
  upsertGraphicStyle,
  withGraphicStyleRef,
  type GraphicStyle,
  type GraphicStyleBase,
  type GraphicStyleLibrary,
} from "../commands/graphic-styles";
import { planRecipeWrite } from "../recipe-store";
import { fullFill, fullStroke } from "./appearance-kind";
import {
  BLEND_MODE,
  COLOR,
  FILL_LAYER,
  INT,
  LEN,
  PCT,
  STROKE_LAYER,
  TEXT,
  addressOf,
  derived,
  localIdOf,
  refuse,
  row,
  val,
} from "./shared";

export const GRAPHIC_STYLE_KIND = "graphicStyle";

/** `base*` rows ↔ the `GraphicStyleBase` fields (exhaustive: a new base
 *  field fails typecheck until it has a row). */
const BASE_ROWS: Record<keyof GraphicStyleBase, { path: string; type: PropertySchema["type"] }> = {
  fill: { path: "baseFill", type: COLOR },
  fillTint: { path: "baseFillTint", type: PCT },
  stroke: { path: "baseStroke", type: COLOR },
  strokeWeight: { path: "baseStrokeWeight", type: LEN },
  opacity: { path: "baseOpacity", type: PCT },
  blendMode: { path: "baseBlendMode", type: BLEND_MODE },
};

export const GRAPHIC_STYLE_SCHEMA: readonly PropertySchema[] = [
  row("name", TEXT, { title: "Name", summary: "The style's name — what a persisted reference selects by." }),
  row("fills", { kind: "list", of: FILL_LAYER }, { title: "Fills", summary: "Fill layers, bottom → top.", default: [] }),
  row("strokes", { kind: "list", of: STROKE_LAYER }, { title: "Strokes", summary: "Stroke layers, bottom → top.", default: [] }),
  ...Object.values(BASE_ROWS).map((b) =>
    row(b.path, b.type, {
      nullable: true,
      summary: "The object-level paint; a top fill / stroke layer claims its slot (the bake rule).",
    }),
  ),
  derived("linkedCount", INT, "How many elements follow this style."),
];

const baseKeyOf = (path: string): keyof GraphicStyleBase | null => {
  for (const [k, b] of Object.entries(BASE_ROWS)) if (b.path === path) return k as keyof GraphicStyleBase;
  return null;
};

type FullFill = ReturnType<typeof fullFill>;
type FullStroke = ReturnType<typeof fullStroke>;

const storedFill = (f: FullFill): FillLayer => ({
  color: f.color,
  tint: f.tint,
  ...(f.opacity !== 100 ? { opacity: f.opacity } : {}),
  ...(f.blendMode !== "Normal" ? { blendMode: f.blendMode } : {}),
});
const storedStroke = (s: FullStroke): StrokeLayer => ({
  color: s.color,
  weight: s.weight,
  ...(s.opacity !== 100 ? { opacity: s.opacity } : {}),
  ...(s.blendMode !== "Normal" ? { blendMode: s.blendMode } : {}),
});

/** Apply one write to a style (pure). `null` = no such path. */
function applyPath(style: GraphicStyle, path: string, value: unknown): GraphicStyle | null {
  const a = style.appearance;
  if (path === "name") return { ...style, name: String(value) };
  if (path === "fills") {
    return { ...style, appearance: { ...a, stack: { ...a.stack, fills: (value as FullFill[]).map(storedFill) } } };
  }
  if (path === "strokes") {
    return { ...style, appearance: { ...a, stack: { ...a.stack, strokes: (value as FullStroke[]).map(storedStroke) } } };
  }
  const key = baseKeyOf(path);
  if (!key) return null;
  return { ...style, appearance: { ...a, base: { ...a.base, [key]: value } } };
}

/** The bake rule over the full rectangle vocabulary (what Save reads). */
const project = (style: GraphicStyle): GraphicStyle => ({
  ...style,
  appearance: projectGraphicAppearance(style.appearance, GRAPHIC_STYLE_BASE_PATHS),
});

export function makeGraphicStyleKind(host: BundleHost): ObjectKindContribution {
  const idOf = (address: string) => localIdOf(address, GRAPHIC_STYLE_KIND);

  /** Re-apply `style` to every follower (Illustrator: a style edit
   *  propagates, overrides included). Baked followers are skipped. */
  async function propagate(style: GraphicStyle): Promise<MutationInput[]> {
    const out: MutationInput[] = [];
    for (const link of await graphicStyleLinks(host, style.id)) {
      const read = await readGraphicAppearance(host, link.id);
      if (graphicStyleRefusalOf(read.envelope)) continue;
      const batch = applyGraphicStyleBatchFor({
        elementId: link.id,
        style,
        supported: read.supported,
        prev: read.envelope,
      });
      out.push(...(batch.op === "batch" ? batch.args.ops : [batch]));
    }
    return out;
  }

  return {
    kind: GRAPHIC_STYLE_KIND,
    title: "Graphic style",
    schema: GRAPHIC_STYLE_SCHEMA,
    hostOf: () => "doc",
    async list() {
      return (await readGraphicStyleLibrary(host)).styles.map((s) => addressOf(GRAPHIC_STYLE_KIND, s.id));
    },
    async get(address, path): Promise<ObjectValue> {
      const id = idOf(address);
      const style = id ? findGraphicStyle(await readGraphicStyleLibrary(host), id) : null;
      if (!style) return refuse("unknownAddress", `no graphic style ${address}`);
      if (path === "name") return val(style.name);
      if (path === "fills") return val(style.appearance.stack.fills.map(fullFill));
      if (path === "strokes") return val(style.appearance.stack.strokes.map(fullStroke));
      if (path === "linkedCount") return val((await graphicStyleLinkCounts(host))[style.id] ?? 0);
      const key = baseKeyOf(path);
      if (key) return val(style.appearance.base[key]);
      return refuse("unknownPath", `graphicStyle has no "${path}"`);
    },
    async batch(ops: readonly ObjectOp[]): Promise<ObjectWrite> {
      let library: GraphicStyleLibrary = await readGraphicStyleLibrary(host);
      const changed = new Set<string>();
      const removed = new Set<string>();
      for (const op of ops) {
        if (op.op === "create") {
          let style: GraphicStyle = {
            id: mintGraphicStyleId(library),
            name: `Graphic style ${library.styles.length + 1}`,
            appearance: {
              stack: { fills: [], strokes: [] },
              base: { fill: null, fillTint: null, stroke: null, strokeWeight: null, opacity: null, blendMode: null },
            },
          };
          for (const [path, value] of Object.entries(op.props ?? {})) {
            const next = applyPath(style, path, value);
            if (!next) return { kind: "rejected", reason: `graphicStyle has no writable "${path}"` };
            style = next;
          }
          library = upsertGraphicStyle(library, project(style));
          continue;
        }
        const id = idOf(op.op === "invoke" ? "" : op.address);
        const style = id ? findGraphicStyle(library, id) : null;
        if (!style) return { kind: "rejected", reason: `no graphic style ${op.op === "invoke" ? "" : op.address}` };
        if (op.op === "delete") {
          library = removeGraphicStyleFrom(library, style.id);
          removed.add(style.id);
          continue;
        }
        if (op.op !== "set") return { kind: "rejected", reason: `graphicStyle cannot ${op.op}` };
        const next = applyPath(style, op.path, op.value);
        if (!next) return { kind: "rejected", reason: `graphicStyle has no writable "${op.path}"` };
        library = upsertGraphicStyle(library, project(next));
        if (op.path !== "name") changed.add(style.id);
      }
      const plan = await planRecipeWrite(host, GRAPHIC_STYLES_PART, serializeGraphicStyleLibrary(library));
      if (typeof plan === "string") return { kind: "rejected", reason: plan };
      const mutations: MutationInput[] = [plan.mutation];
      for (const id of changed) {
        if (removed.has(id)) continue;
        mutations.push(...(await propagate(findGraphicStyle(library, id)!)));
      }
      for (const id of removed) {
        for (const link of await graphicStyleLinks(host, id)) {
          const env = await host.document.getMetadata(link.id).catch(() => null);
          mutations.push(stampDrawMetadata(link.id, withGraphicStyleRef(env, null)));
        }
      }
      return { kind: "mutations", mutations };
    },
  };
}
