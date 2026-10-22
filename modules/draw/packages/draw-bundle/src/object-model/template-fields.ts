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

// paged.draw's TEMPLATE FIELD KINDS (extensions ADR 335; engine ADR 1000,
// amendment 2026-10-23): the parts of a drawing a template can open to a
// filler. A field sits on one page item (its `x-paged:template` label
// names the kind, the definition below and the grants); the engine grants
// `select`, `document.metadata` and those grants on THAT item only, and
// checks every write here like any other.
//
//   kind           definition                           value        writes (one batch each)
//   paint          { channel, allowed?, target? }       swatch id    fill/stroke colour, or the
//                                                                    appearance stack's top layer
//   graphicStyle   { allowed?, targets? }               style id     the style apply batch
//   textOnPath     { path? }                            text         the attached story's text
//   symbolChoice   { allowed? }                         symbol id    the instance leaf re-shaped
//                                                                    in place (one-piece symbols)
//
// `allowed` lists ids or names; absent, every swatch / style / symbol the
// document holds is a choice. A value is answered as an id and taken as
// an id or a name.
//
// Two limits, both the engine's permission model rather than this code:
//   · a symbol is re-placed IN PLACE, by rewriting the instance leaf's
//     path, paint and link. A rebuild (delete + insert) would mint a new
//     element, which needs `document.add-item` and `item.delete` and loses
//     the field's own label — so only one-piece symbols can be chosen.
//   · a text-on-path story is not hosted by a text frame, and the engine
//     decides a story's permissions by its text frame (`frame_for`). A
//     filler's write to it is refused unless the template grants
//     `text.edit` document-wide; the field reports that refusal.

import type {
  BundleHost,
  ElementId,
  ObjectsSurface,
  PluginMetadataEnvelope,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";
import { formatAddress } from "@paged-media/plugin-sdk";

import { appearanceOf } from "../commands/appearance";
import { stampDrawMetadata } from "../commands/appearance-bake";
import { framePathMutationFor } from "../commands/compound-path";
import {
  graphicStyleRefOf,
  readGraphicStyleLibrary,
} from "../commands/graphic-styles";
import { offsetTable } from "../commands/pattern";
import {
  readSymbolLibrary,
  registrationPointOf,
  symbolBoundsOf,
  symbolInstanceOf,
  withSymbolInstance,
  DEFAULT_SYMBOL_REGISTRATION,
  type SymbolDefinition,
} from "../commands/symbols";
import { textOnPathOf } from "../commands/text-on-path";
import { addressOf, coreAddressOf, DRAW_ID, treeItems } from "./shared";
import { defineMessages, t } from "@paged-media/strings";

/** The field kinds' titles and their refusals, in the editor's locale. */
const P = defineMessages("draw.templateField", {
  writeRefused: "the write was refused",
  notPermitted: "not permitted: {permission} on {target}",
  locked: "{node} is locked",
  engineRefused: "the engine refused the write",
  chooseColour: "choose a colour",
  notOneColour: `"{value}" is not one of this field's colours`,
  chooseStyle: "choose a style",
  notOneStyle: `"{value}" is not one of this field's styles`,
  chooseSymbol: "choose a symbol",
  notOneSymbol: `"{value}" is not one of this field's symbols`,
  fillLayersUnread: "the fill layers of {target} cannot be read",
  strokeLayersUnread: "the stroke layers of {target} cannot be read",
  textString: "the text must be a string",
  oneLine: "text on a path is one line: remove the line breaks",
  noText: "{target} carries no text on its path",
  multiPiece: `"{name}" has {count} pieces; a symbol field swaps one-piece symbols`,
  notInstance: "{id} is not a symbol instance",
  noPath: "{id} has no path to re-shape",
  noMeasurablePath: "{id} has no measurable path",
  paintTitle: "Fill or stroke colour",
  graphicStyleTitle: "Graphic style",
  textOnPathTitle: "Text on a path",
  symbolTitle: "Symbol",
});

const CHOOSE = {
  colour: P.chooseColour,
  style: P.chooseStyle,
  symbol: P.chooseSymbol,
} as const;
const NOT_ONE = {
  colour: P.notOneColour,
  style: P.notOneStyle,
  symbol: P.notOneSymbol,
} as const;

type Ctx = { objects: ObjectsSurface };
type Option = { value: string; label?: string };

export const PAINT_FIELD = `${DRAW_ID}.paint`;
export const GRAPHIC_STYLE_FIELD = `${DRAW_ID}.graphicStyle`;
export const TEXT_ON_PATH_FIELD = `${DRAW_ID}.textOnPath`;
export const SYMBOL_CHOICE_FIELD = `${DRAW_ID}.symbolChoice`;

/** The manifest's `contributes.objectModel.templateFields[]`. */
export const DRAW_TEMPLATE_FIELDS: readonly { kind: string; title: string }[] =
  [
    { kind: PAINT_FIELD, title: "Fill or stroke colour" },
    { kind: GRAPHIC_STYLE_FIELD, title: "Graphic style" },
    { kind: TEXT_ON_PATH_FIELD, title: "Text on a path" },
    { kind: SYMBOL_CHOICE_FIELD, title: "Symbol" },
  ];

// ------------------------------------------------------------ helpers

/** A refused write's reason as a sentence: the engine's typed refusal
 *  (`notPermitted`, `locked`) named, any other reason as it came. */
export function refusalSentence(reason: string | undefined, code?: string) {
  if (!reason) return `${t(P.writeRefused)} (${code ?? "failed"})`;
  try {
    const e = (
      JSON.parse(reason) as {
        error?: { kind?: string; details?: Record<string, unknown> };
      }
    ).error;
    const d = e?.details ?? {};
    if (e?.kind === "notPermitted")
      return t(P.notPermitted, {
        permission: String(d["permission"]),
        target: String(d["target"]),
      });
    if (e?.kind === "locked") return t(P.locked, { node: String(d["node"]) });
    if (typeof d["what"] === "string") return d["what"];
    if (e?.kind) return `${t(P.engineRefused)} (${e.kind})`;
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

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

/** The page item a Self id names, with its kind (the tree knows it). */
async function itemOf(host: BundleHost, selfId: string): Promise<ElementId> {
  const found = treeItems(await host.document.tree()).find(
    (id) => String(id.id) === selfId,
  );
  if (!found) throw new Error(`no page item ${selfId}`);
  return found;
}

const envelopeOf = (host: BundleHost, id: ElementId) =>
  host.document
    .getMetadata(id)
    .catch((): PluginMetadataEnvelope | null => null);

/** A write's refusal as one sentence (the engine's own when it has one). */
const writeProblem = (r: {
  applied: boolean;
  reason?: string;
  code?: string;
}): TemplateFieldWrite =>
  r.applied ? { ok: true } : refused(refusalSentence(r.reason, r.code));

/** The library entries a field offers: `allowed` (ids or names) in its
 *  own order, or every entry. Unknown `allowed` entries are dropped. */
function choicesOf<T extends { id: string; name: string }>(
  entries: readonly T[],
  allowed: readonly string[] | null,
): T[] {
  if (!allowed) return [...entries];
  const out: T[] = [];
  for (const a of allowed) {
    const hit = entries.find((e) => e.id === a || e.name === a);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** The entry a written value names among the choices, or a problem. */
function chosen<T extends { id: string; name: string }>(
  choices: readonly T[],
  value: unknown,
  what: "colour" | "style" | "symbol",
): T | string {
  if (typeof value !== "string" || value.length === 0) return t(CHOOSE[what]);
  const hit = choices.find((c) => c.id === value || c.name === value);
  return hit ?? t(NOT_ONE[what], { value });
}

const choiceControl = (
  choices: readonly { id: string; name: string }[],
): TemplateFieldControl => ({
  kind: "choice",
  options: choices.map((c): Option => ({ value: c.id, label: c.name })),
});

// -------------------------------------------------------------- paint

type Channel = "fill" | "stroke";

const channelOf = (field: TemplateFieldRef): Channel =>
  defOf(field)["channel"] === "stroke" ? "stroke" : "fill";

async function swatches(
  host: BundleHost,
): Promise<{ id: string; name: string }[]> {
  const all = (await host.document.collection("swatches")) as readonly {
    selfId: string;
    name: string;
  }[];
  return all.map((s) => ({ id: s.selfId, name: s.name }));
}

async function paintChoices(host: BundleHost, field: TemplateFieldRef) {
  return choicesOf(await swatches(host), strings(defOf(field)["allowed"]));
}

/** The item a paint field paints: `def.target` (a Self id), else the
 *  field's own item. */
const paintTarget = (field: TemplateFieldRef): string => {
  const t = defOf(field)["target"];
  return typeof t === "string" && t.length > 0 ? t : field.targetId;
};

const paintKind = (host: BundleHost): TemplateFieldKindContribution => ({
  kind: PAINT_FIELD,
  title: t(P.paintTitle),
  control: { kind: "choice", options: [] },
  grants: ["appearance.fill", "appearance.stroke"],
  async describe(_ctx, field) {
    return choiceControl(await paintChoices(host, field));
  },
  async read(ctx: Ctx, field) {
    const el = await itemOf(host, paintTarget(field));
    const channel = channelOf(field);
    const stack = appearanceOf(await envelopeOf(host, el));
    const top = channel === "fill" ? stack.fills.at(-1) : stack.strokes.at(-1);
    if (top) return top.color;
    const v = await ctx.objects.get(
      coreAddressOf(el),
      channel === "fill" ? "frameFillColor" : "frameStrokeColor",
    );
    return v.kind === "value" && typeof v.value === "string" ? v.value : null;
  },
  async write(ctx: Ctx, field, value) {
    const pick = chosen(await paintChoices(host, field), value, "colour");
    if (typeof pick === "string") return refused(pick);
    const el = await itemOf(host, paintTarget(field));
    const channel = channelOf(field);
    const stack = appearanceOf(await envelopeOf(host, el));
    const layers = channel === "fill" ? stack.fills : stack.strokes;
    // A stack: its top layer is what bakes to the frame, so the colour
    // goes there (the appearance kind writes the stack and the bake).
    if (layers.length > 0) {
      const appearance = addressOf("appearance", coreAddressOf(el));
      const path = channel === "fill" ? "fills" : "strokes";
      const current = await ctx.objects.get(appearance, path);
      if (current.kind !== "value" || !Array.isArray(current.value))
        return refused(
          t(channel === "fill" ? P.fillLayersUnread : P.strokeLayersUnread, {
            target: field.targetId,
          }),
        );
      const next = (current.value as { color: string }[]).map((l, i, all) =>
        i === all.length - 1 ? { ...l, color: pick.id } : l,
      );
      return writeProblem(await ctx.objects.set(appearance, path, next));
    }
    return writeProblem(
      await ctx.objects.set(
        coreAddressOf(el),
        channel === "fill" ? "frameFillColor" : "frameStrokeColor",
        pick.id,
      ),
    );
  },
});

// ------------------------------------------------------- graphicStyle

async function styleChoices(host: BundleHost, field: TemplateFieldRef) {
  const library = await readGraphicStyleLibrary(host);
  return choicesOf(library.styles, strings(defOf(field)["allowed"]));
}

/** The items a style field styles: the field's item, then `def.targets`
 *  (Self ids; each needs its own grants in the template). */
const styleTargets = (field: TemplateFieldRef): string[] => {
  const extra = strings(defOf(field)["targets"]) ?? [];
  return [field.targetId, ...extra.filter((t) => t !== field.targetId)];
};

const graphicStyleKind = (host: BundleHost): TemplateFieldKindContribution => ({
  kind: GRAPHIC_STYLE_FIELD,
  title: t(P.graphicStyleTitle),
  control: { kind: "choice", options: [] },
  grants: ["appearance.fill", "appearance.stroke", "appearance.opacity"],
  async describe(_ctx, field) {
    return choiceControl(await styleChoices(host, field));
  },
  async read(_ctx, field) {
    const el = await itemOf(host, field.targetId);
    return graphicStyleRefOf(await envelopeOf(host, el))?.id ?? null;
  },
  async write(ctx: Ctx, field, value) {
    const pick = chosen(await styleChoices(host, field), value, "style");
    if (typeof pick === "string") return refused(pick);
    const ops = [];
    for (const target of styleTargets(field)) {
      const el = await itemOf(host, target);
      ops.push({
        op: "set" as const,
        address: addressOf("appearance", coreAddressOf(el)),
        path: "graphicStyle",
        value: addressOf("graphicStyle", pick.id),
      });
    }
    return writeProblem(await ctx.objects.batch(ops));
  },
});

// --------------------------------------------------------- textOnPath

async function storyOnPath(
  host: BundleHost,
  field: TemplateFieldRef,
): Promise<string | null> {
  const p = defOf(field)["path"];
  const el = await itemOf(
    host,
    typeof p === "string" && p.length > 0 ? p : field.targetId,
  );
  return textOnPathOf(await envelopeOf(host, el))?.story ?? null;
}

const textOnPathKind = (host: BundleHost): TemplateFieldKindContribution => ({
  kind: TEXT_ON_PATH_FIELD,
  title: t(P.textOnPathTitle),
  control: { kind: "text" },
  grants: ["text.edit"],
  async read(ctx: Ctx, field) {
    const story = await storyOnPath(host, field);
    if (!story) return null;
    const v = await ctx.objects.get(
      formatAddress({ kind: "story", id: story }),
      "content",
    );
    return v.kind === "value" && typeof v.value === "string" ? v.value : null;
  },
  async write(ctx: Ctx, field, value) {
    if (typeof value !== "string") return refused(t(P.textString));
    if (/[\r\n]/.test(value)) return refused(t(P.oneLine));
    const story = await storyOnPath(host, field);
    if (!story) return refused(t(P.noText, { target: field.targetId }));
    return writeProblem(
      await ctx.objects.set(
        formatAddress({ kind: "story", id: story }),
        "content",
        value,
      ),
    );
  },
});

// -------------------------------------------------------- symbolChoice

async function symbolChoices(host: BundleHost, field: TemplateFieldRef) {
  const library = await readSymbolLibrary(host);
  return choicesOf(library.symbols, strings(defOf(field)["allowed"]));
}

/** The one batch that turns the instance leaf `el` into `symbol`, in
 *  place: its path (definition space anchored at the leaf's current
 *  registration point, in the leaf's own inner coordinates, so its
 *  transform carries over), its paint and its link. */
async function rePlaceBatch(
  host: BundleHost,
  el: ElementId,
  env: PluginMetadataEnvelope | null,
  from: SymbolDefinition | null,
  to: SymbolDefinition,
): Promise<string | object> {
  if (to.pieces.length !== 1)
    return t(P.multiPiece, { name: to.name, count: to.pieces.length });
  const link = symbolInstanceOf(env);
  if (!link) return t(P.notInstance, { id: String(el.id) });
  const read = await host.document.pathAnchors(el).catch(() => null);
  if (!read || read.anchors.length < 2)
    return t(P.noPath, { id: String(el.id) });
  const bounds = symbolBoundsOf([
    {
      anchors: read.anchors.map((a) => ({
        anchor: a.anchor,
        left: a.left,
        right: a.right,
      })),
      subpathStarts: [...read.subpathStarts],
    },
  ]);
  if (!bounds) return t(P.noMeasurablePath, { id: String(el.id) });
  const [ox, oy] = registrationPointOf(
    bounds,
    from?.registration ?? DEFAULT_SYMBOL_REGISTRATION,
  );
  const piece = to.pieces[0]!;
  const colour = (path: "frameFillColor" | "frameStrokeColor", v: unknown) => ({
    op: "setElementProperty",
    args: { elementId: el, path, value: { type: "colorRef", value: v } },
  });
  const ops: object[] = [
    framePathMutationFor(el, offsetTable(piece.table, ox, oy)),
    colour("frameFillColor", piece.paint.fill),
    colour("frameStrokeColor", piece.paint.stroke),
  ];
  if (typeof piece.paint.weight === "number")
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: el,
        path: "frameStrokeWeight",
        value: { type: "length", value: piece.paint.weight },
      },
    });
  ops.push(
    stampDrawMetadata(
      el,
      withSymbolInstance(env, { ...link, symbol: to.id, piece: 0 }),
    ),
  );
  return { op: "batch", args: { ops } };
}

const symbolChoiceKind = (host: BundleHost): TemplateFieldKindContribution => ({
  kind: SYMBOL_CHOICE_FIELD,
  title: t(P.symbolTitle),
  control: { kind: "choice", options: [] },
  grants: ["item.resize", "appearance.fill", "appearance.stroke"],
  async describe(_ctx, field) {
    return choiceControl(await symbolChoices(host, field));
  },
  async read(_ctx, field) {
    const el = await itemOf(host, field.targetId);
    return symbolInstanceOf(await envelopeOf(host, el))?.symbol ?? null;
  },
  async write(_ctx, field, value) {
    const choices = await symbolChoices(host, field);
    const pick = chosen(choices, value, "symbol");
    if (typeof pick === "string") return refused(pick);
    const el = await itemOf(host, field.targetId);
    const env = await envelopeOf(host, el);
    const current = symbolInstanceOf(env)?.symbol;
    if (current === pick.id) return { ok: true };
    const library = await readSymbolLibrary(host);
    const from = library.symbols.find((s) => s.id === current) ?? null;
    const batch = await rePlaceBatch(host, el, env, from, pick);
    if (typeof batch === "string") return refused(batch);
    const out = await host.document.mutate(batch as never);
    return out.applied
      ? { ok: true }
      : refused(
          refusalSentence(
            out.error === undefined
              ? undefined
              : typeof out.error === "string"
                ? out.error
                : JSON.stringify({ error: out.error }),
          ),
        );
  },
});

/** Every draw template field kind, bound to `host`. */
export function drawTemplateFields(
  host: BundleHost,
): TemplateFieldKindContribution[] {
  return [
    paintKind(host),
    graphicStyleKind(host),
    textOnPathKind(host),
    symbolChoiceKind(host),
  ];
}
