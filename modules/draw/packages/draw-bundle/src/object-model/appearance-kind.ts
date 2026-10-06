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

// `appearance` — an element's APPEARANCE STACK (fills, strokes, their
// order) and its GRAPHIC-STYLE link (ADR 323).
//
// CORE-BACKED. The stack lives on the element's own `x-paged:` envelope
// and its front-most layers bake onto the frame's real paint (the
// commands/appearance.ts model); a write is the metadata stamp PLUS the
// bake, in ONE batch — one undo step, where `commitAppearance` takes
// two. ORDER is the list order (bottom → top; the last entry bakes).
// A style link is the graphic-styles apply batch (base paint + bake +
// stamp), `null` breaks it.
//
// EFFECTS are NOT here: drop shadow, glows, feathers, bevel, satin are
// core frame paths (`frameDropShadow*`, `frameOuterGlow*`, …) reached at
// the element's own core address, and IDML fixes their order — there is
// no effect STACK to reorder (recorded as a gap). A BAKED stack (the
// group bake) is refused: its layers are page items, release it first.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  PluginMetadataEnvelope,
  PropertySchema,
} from "@paged-media/plugin-api";

import {
  appearanceOf,
  bakeAppearanceMutations,
  withAppearance,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "../commands/appearance";
import { appearanceBakeOf, stampDrawMetadata } from "../commands/appearance-bake";
import {
  applyGraphicStyleBatchFor,
  findGraphicStyle,
  graphicStyleOverridden,
  graphicStyleRefOf,
  readGraphicAppearance,
  readGraphicStyleLibrary,
  withGraphicStyleRef,
} from "../commands/graphic-styles";
import {
  BOOL,
  FILL_LAYER,
  STROKE_LAYER,
  addressOf,
  bareIdOf,
  coreAddressOf,
  derived,
  elementOfId,
  localIdOf,
  refuse,
  ro,
  row,
  treeItems,
  val,
} from "./shared";

export const APPEARANCE_KIND = "appearance";

export const APPEARANCE_SCHEMA: readonly PropertySchema[] = [
  row(
    "fills",
    { kind: "list", of: FILL_LAYER },
    {
      title: "Fills",
      summary:
        "Extra fill layers, bottom → top; the LAST one bakes to the frame's fill. Order is list order.",
      default: [],
    },
  ),
  row(
    "strokes",
    { kind: "list", of: STROKE_LAYER },
    {
      title: "Strokes",
      summary:
        "Extra stroke layers, bottom → top; the LAST one bakes to the frame's stroke. Order is list order.",
      default: [],
    },
  ),
  row(
    "graphicStyle",
    { kind: "ref", to: `plugin:media.paged.draw/graphicStyle` },
    {
      title: "Graphic style",
      nullable: true,
      summary: "The linked graphic style; setting it applies the style, null breaks the link (keeps the look).",
    },
  ),
  derived("graphicStyleOverridden", BOOL, "True when the element was edited directly since its style was applied."),
  ro("baked", BOOL, "True when the stack is baked into a group of real page items (release it to edit here)."),
];

/** The kinds that can carry an appearance envelope. */
const CARRIERS = new Set(["polygon", "graphicLine", "rectangle", "oval", "textFrame"]);

const DEFAULT_TINT = 100;
const DEFAULT_OPACITY = 100;
const DEFAULT_BLEND = "Normal";

/** A stored fill, every field explicit (what a read answers). */
export const fullFill = (f: FillLayer) => ({
  color: f.color,
  tint: f.tint ?? DEFAULT_TINT,
  opacity: f.opacity ?? DEFAULT_OPACITY,
  blendMode: f.blendMode ?? DEFAULT_BLEND,
});
export const fullStroke = (s: StrokeLayer) => ({
  color: s.color,
  weight: s.weight,
  opacity: s.opacity ?? DEFAULT_OPACITY,
  blendMode: s.blendMode ?? DEFAULT_BLEND,
});

/** A written fill in the stack's own shape: the defaults the commands
 *  never store stay absent, so a stack written here digests exactly like
 *  one the Appearance panel built (graphic-style override detection). */
const storedFill = (f: ReturnType<typeof fullFill>): FillLayer => ({
  color: f.color,
  tint: f.tint,
  ...(f.opacity !== DEFAULT_OPACITY ? { opacity: f.opacity } : {}),
  ...(f.blendMode !== DEFAULT_BLEND ? { blendMode: f.blendMode } : {}),
});
const storedStroke = (s: ReturnType<typeof fullStroke>): StrokeLayer => ({
  color: s.color,
  weight: s.weight,
  ...(s.opacity !== DEFAULT_OPACITY ? { opacity: s.opacity } : {}),
  ...(s.blendMode !== DEFAULT_BLEND ? { blendMode: s.blendMode } : {}),
});

async function supportedPaths(host: BundleHost, id: ElementId): Promise<Set<string>> {
  const props = await host.document.elementProperties(id).catch(() => null);
  return new Set((props?.entries ?? []).map((e) => e.path));
}

export function makeAppearanceKind(host: BundleHost): ObjectKindContribution {
  const elementOf = (address: string): ElementId | null => {
    const id = localIdOf(address, APPEARANCE_KIND);
    const el = id ? elementOfId(id) : null;
    return el && CARRIERS.has(el.kind) ? el : null;
  };
  const envelopeOf = (id: ElementId) => host.document.getMetadata(id).catch(() => null);

  return {
    kind: APPEARANCE_KIND,
    title: "Appearance",
    schema: APPEARANCE_SCHEMA,
    hostOf: (address) => localIdOf(address, APPEARANCE_KIND),
    async list() {
      // Every element that CAN carry an appearance — an empty stack is a
      // stack (`fills` reads []), so a selector over any item resolves.
      return treeItems(await host.document.tree())
        .filter((id) => CARRIERS.has(id.kind))
        .map((id) => addressOf(APPEARANCE_KIND, coreAddressOf(id)));
    },
    async get(address, path): Promise<ObjectValue> {
      const el = elementOf(address);
      if (!el) return refuse("unknownAddress", `${address} cannot carry an appearance`);
      const env = await envelopeOf(el);
      const stack = appearanceOf(env);
      switch (path) {
        case "fills":
          return val(stack.fills.map(fullFill));
        case "strokes":
          return val(stack.strokes.map(fullStroke));
        case "graphicStyle": {
          const ref = graphicStyleRefOf(env);
          return val(ref ? addressOf("graphicStyle", ref.id) : null);
        }
        case "graphicStyleOverridden": {
          const ref = graphicStyleRefOf(env);
          if (!ref) return { kind: "absent" };
          return val(graphicStyleOverridden(ref, (await readGraphicAppearance(host, el)).appearance));
        }
        case "baked":
          return val(appearanceBakeOf(env) !== null);
        default:
          return refuse("unknownPath", `appearance has no "${path}"`);
      }
    },
    async batch(ops: readonly ObjectOp[]) {
      const byElement = new Map<string, { el: ElementId; ops: ObjectOp[] }>();
      for (const op of ops) {
        if (op.op !== "set") {
          return {
            kind: "rejected",
            reason: `appearance ${op.op}: an appearance belongs to its element — set its fills / strokes`,
          };
        }
        const el = elementOf(op.address);
        if (!el) return { kind: "rejected", reason: `${op.address} cannot carry an appearance` };
        const key = `${el.kind}:${String(el.id)}`;
        const entry = byElement.get(key) ?? { el, ops: [] };
        entry.ops.push(op);
        byElement.set(key, entry);
      }
      const mutations: MutationInput[] = [];
      for (const { el, ops: own } of byElement.values()) {
        const env: PluginMetadataEnvelope | null = await envelopeOf(el);
        if (appearanceBakeOf(env)) {
          return {
            kind: "rejected",
            reason: `${coreAddressOf(el)}: the appearance is BAKED into a group of page items — release it first`,
          };
        }
        const styleOps = own.filter((o) => o.op === "set" && o.path === "graphicStyle");
        if (styleOps.length > 0 && own.length > styleOps.length) {
          return {
            kind: "rejected",
            reason: "set graphicStyle in its own batch: a style replaces the whole stack",
          };
        }
        const supported = await supportedPaths(host, el);
        if (styleOps.length > 0) {
          const target = (styleOps.at(-1) as { value: unknown }).value;
          if (target === null) {
            mutations.push(stampDrawMetadata(el, withGraphicStyleRef(env, null)));
            continue;
          }
          const id = bareIdOf(String(target), "graphicStyle");
          const style = findGraphicStyle(await readGraphicStyleLibrary(host), id);
          if (!style) return { kind: "rejected", reason: `no graphic style "${id}"` };
          const batch = applyGraphicStyleBatchFor({ elementId: el, style, supported, prev: env });
          mutations.push(...(batch.op === "batch" ? batch.args.ops : [batch]));
          continue;
        }
        const stack: AppearanceStack = appearanceOf(env);
        for (const op of own) {
          if (op.op !== "set") continue;
          if (op.path === "fills") {
            stack.fills = (op.value as ReturnType<typeof fullFill>[]).map(storedFill);
          } else if (op.path === "strokes") {
            stack.strokes = (op.value as ReturnType<typeof fullStroke>[]).map(storedStroke);
          } else {
            return { kind: "rejected", reason: `appearance has no writable "${op.path}"` };
          }
        }
        mutations.push(stampDrawMetadata(el, withAppearance(env, stack)));
        // The bake, filtered to the element's own vocabulary: a refused
        // property would roll the WHOLE atomic batch back (a GraphicLine
        // has no fill slot).
        mutations.push(
          ...bakeAppearanceMutations(el, stack).filter(
            (m) => m.op !== "setElementProperty" || supported.has(m.args.path),
          ),
        );
      }
      return { kind: "mutations", mutations };
    },
  };
}
