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

// GRAPHIC STYLES (Illustrator catalog, Phase 2) — a named, reusable,
// LINKED complete appearance.
//
// The catalog row reads "save, apply, link, merge, import, export,
// preview, and organize complete appearance stacks". The substance is
// the LINK: a style that only copies values is a clipboard, not a
// style. So the two halves this module owns are (a) a document-resident
// style LIBRARY and (b) a per-element REFERENCE into it that survives
// the apply, propagates on redefine, and can be broken.
//
// ---------------------------------------------------------------- why
// WHY NOT A CORE OBJECT STYLE. Core's `ObjectStyleDef` has exactly seven
// fields (fill colour + tint, stroke colour + tint + weight, corner
// radius, corner option). An appearance in this plugin is a STACK of N
// fills and N strokes, each with its own tint / opacity / blend mode.
// Expressing a graphic style as a core object style would silently drop
// every layer past the first — the exact fiction this repo refuses. The
// editor's `paged.object-styles` panel remains the thin core-object-style
// surface; this is a different, plugin-owned concept that sits above it.
//
// WHY `host.parts` AND NOT `host.storage` OR ELEMENT METADATA. A style
// library is DOCUMENT state: reopening the `.paged` file somewhere else
// must find the styles. `host.storage` is localStorage-backed and
// per-plugin-per-BROWSER (it does not travel), and plugin metadata is
// PER-ELEMENT ONLY — `setPluginMetadata` resolves through
// `find_spread_for_leaf`, whose arms are TextFrame | Rectangle | Oval |
// GraphicLine | Polygon, so there is no document-level metadata slot to
// hang a library on (a Group cannot even carry metadata). `host.parts`
// IS the document-resident door: bytes under `paged/<plugin-id>/` inside
// the container, declared in `contributes.partTypes`, probed with
// `supports("storage.parts@1")`.
//
// -------------------------------------------------------- the two shapes
// THE LIBRARY (one part, `paged/media.paged.draw/graphic-styles.json`):
//
//   { "v": 1, "styles": [ { "id": "gs-1", "name": "Double stroke",
//       "appearance": { "stack": { "fills": [...], "strokes": [...] },
//                       "base": { "fill": …, "fillTint": …, "stroke": …,
//                                 "strokeWeight": …, "opacity": …,
//                                 "blendMode": … } } } ] }
//
// A "complete appearance" is BOTH halves: the plugin's metadata STACK
// *and* the object-level BASE paint the frame's own slots carry (which
// is the whole appearance of a shape that has no extra layers), object
// opacity and blend mode included.
//
// THE LINK (on the element's own `x-paged:media.paged.draw` envelope,
// alongside `appearance`):
//
//   data.graphicStyle = { id: "gs-1", rev: "<16 hex>" }
//
// `rev` is a digest of the appearance THIS ELEMENT RECEIVED. It is not
// a copy of the style — the style's name and definition are resolved
// from the library by `id`, so a RENAME touches the library only and
// never walks the document. `rev` exists for exactly one job: detecting
// an OVERRIDE without needing the library at all.
//
// ------------------------------------------------- override semantics
// DECISION (Illustrator treats a direct edit as an override; this is the
// behaviour picked, and `graphic-styles.spec.ts` pins it):
//
//   1. Editing a linked element's appearance directly does NOT break the
//      link. The element stays linked and becomes OVERRIDDEN — detected,
//      never stored: `digest(live appearance) !== ref.rev`. Nothing has
//      to be written at edit time, so the appearance panel, the fill
//      panel, the eyedropper and a plain undo all produce a truthful
//      override state without knowing this module exists.
//   2. REDEFINE propagates to EVERY linked element, overridden ones
//      INCLUDED — "linked" means "follows the style", and an override is
//      a local deviation, not a detachment. The applier logs how many
//      overrides it overwrote rather than hiding it.
//   3. BREAK LINK is the explicit way to keep a deviation: it drops the
//      reference and leaves the appearance exactly as it is.
//
// -------------------------------------------------- the kind projection
// The engine refuses a property a kind has no slot for, and a batch is
// ATOMIC — one refused op rolls the WHOLE batch back (probed: a
// `frameFillColor` write on a `GraphicLine` answers `notImplemented`,
// and a two-op batch containing it leaves the other element untouched).
// A `GraphicLine` exposes no `frameFillColor` / `frameFillTint` /
// `frameOpacity` / `frameBlendMode` at all. So the apply is KIND-AWARE
// by construction: it reads the target's own property vocabulary from
// `elementProperties` and emits only the ops that vocabulary contains,
// warning about what it dropped. `projectGraphicAppearance` computes,
// purely, exactly what the element will read back afterwards — which is
// what gets digested into `rev`, so a faithfully-applied element is
// never falsely reported as overridden.
//
// ------------------------------------------------------------- limits
// · The LIBRARY IS NOT UNDOABLE. `host.parts.write` is a container write,
//   not an engine `Mutation` — probed: an undo after a part write unwinds
//   the mutation and leaves the part in place. Save / rename / delete
//   therefore change the library outside the undo stack; only the
//   per-element writes they perform are undoable.
// · A BAKED appearance (`data.appearanceBake` — the B-24 group bake) is
//   REFUSED by save, apply and redefine with a diagnostic: a baked
//   carrier paints nothing itself and its layers are real page items, so
//   a base-paint write would put the model and the page out of step.
//   Release first. (`bakeAppearance` refuses the mirror case the same
//   way.)
// · The catalog row also names MERGE, IMPORT, EXPORT, PREVIEW and
//   ORGANIZE (folders/sort). None of those is built here; the panel note
//   says so instead of implying them.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
  PropertyPath,
} from "@paged-media/plugin-api";

import {
  appearanceOf,
  bakeAppearanceMutations,
  withAppearance,
  type AppearanceStack,
} from "./appearance";
import {
  appearanceBakeOf,
  resolveAppearanceCarrier,
  stampDrawMetadata,
} from "./appearance-bake";
import { leafIdsOf } from "./select-same";

export const GRAPHIC_STYLES_COMMAND_CATEGORY = "Graphic Styles";

export const SAVE_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.saveGraphicStyle";
export const APPLY_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.applyGraphicStyle";
export const REDEFINE_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.redefineGraphicStyle";
export const BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID =
  "media.paged.draw.command.breakGraphicStyleLink";
export const RENAME_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.renameGraphicStyle";
export const DELETE_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.deleteGraphicStyle";

/** The contributed command ids, in registration order. */
export const GRAPHIC_STYLES_COMMAND_IDS = [
  SAVE_GRAPHIC_STYLE_COMMAND_ID,
  APPLY_GRAPHIC_STYLE_COMMAND_ID,
  REDEFINE_GRAPHIC_STYLE_COMMAND_ID,
  BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID,
  RENAME_GRAPHIC_STYLE_COMMAND_ID,
  DELETE_GRAPHIC_STYLE_COMMAND_ID,
];

/** The container part this library lives in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). Declared
 *  in the manifest under `contributes.partTypes` as
 *  `{ type: "graphicStyleLibrary", role: "spec", format: "json" }`. */
export const GRAPHIC_STYLES_PART = "graphic-styles.json";

/** The library envelope version (bumped only on a breaking shape change;
 *  an unknown version reads as an EMPTY library rather than a crash). */
export const GRAPHIC_STYLES_LIBRARY_VERSION = 1;

/** The capability this whole feature rides. */
export const GRAPHIC_STYLES_FEATURE = "storage.parts@1";

// ---------------------------------------------------------------- model

/** The object-level paint a frame's OWN slots carry — the appearance of
 *  a shape with no extra layers, and the base the stack paints over. */
export interface GraphicStyleBase {
  fill: string | null;
  fillTint: number | null;
  stroke: string | null;
  strokeWeight: number | null;
  opacity: number | null;
  blendMode: string | null;
}

/** A COMPLETE appearance: the stacked fills/strokes plus the base paint. */
export interface GraphicStyleAppearance {
  stack: AppearanceStack;
  base: GraphicStyleBase;
}

/** One named style in the library. */
export interface GraphicStyle {
  /** Stable, library-local id (`gs-1`, `gs-2`, …). The element reference
   *  stores THIS and nothing else, so a rename is library-only. */
  id: string;
  name: string;
  appearance: GraphicStyleAppearance;
}

/** The whole library — one container part. */
export interface GraphicStyleLibrary {
  v: number;
  styles: GraphicStyle[];
}

/** The link an element carries once a style is applied to it. */
export interface GraphicStyleRef {
  id: string;
  /** Digest of the appearance this element received (the override
   *  detector — see the module header's decision 1). */
  rev: string;
}

export const EMPTY_GRAPHIC_STYLE_BASE: GraphicStyleBase = {
  fill: null,
  fillTint: null,
  stroke: null,
  strokeWeight: null,
  opacity: null,
  blendMode: null,
};

/** The `PropertyPath`s a base paint occupies, in write order. */
export const GRAPHIC_STYLE_BASE_PATHS: readonly PropertyPath[] = [
  "frameFillColor",
  "frameFillTint",
  "frameStrokeColor",
  "frameStrokeWeight",
  "frameOpacity",
  "frameBlendMode",
];

const emptyLibrary = (): GraphicStyleLibrary => ({
  v: GRAPHIC_STYLES_LIBRARY_VERSION,
  styles: [],
});

// ------------------------------------------------------- pure: parsing

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Read a base paint out of any shape, tolerantly (the `appearanceOf`
 *  convention: a partial/foreign blob degrades to nulls, never throws). */
export function graphicStyleBaseOf(raw: unknown): GraphicStyleBase {
  const b = (raw ?? {}) as Partial<Record<keyof GraphicStyleBase, unknown>>;
  return {
    fill: strOrNull(b.fill),
    fillTint: numOrNull(b.fillTint),
    stroke: strOrNull(b.stroke),
    strokeWeight: numOrNull(b.strokeWeight),
    opacity: numOrNull(b.opacity),
    blendMode: strOrNull(b.blendMode),
  };
}

const stackOf = (raw: unknown): AppearanceStack => {
  const a = (raw ?? {}) as Partial<AppearanceStack>;
  return {
    fills: Array.isArray(a.fills) ? a.fills.slice() : [],
    strokes: Array.isArray(a.strokes) ? a.strokes.slice() : [],
  };
};

/** Read a complete appearance out of any shape, tolerantly. */
export function graphicStyleAppearanceOf(raw: unknown): GraphicStyleAppearance {
  const a = (raw ?? {}) as { stack?: unknown; base?: unknown };
  return { stack: stackOf(a.stack), base: graphicStyleBaseOf(a.base) };
}

/** Parse the library part's bytes. Anything unreadable — absent bytes,
 *  invalid JSON, a future `v` — reads as an EMPTY library: a style
 *  library that fails to parse must never take the document with it. */
export function parseGraphicStyleLibrary(
  bytes: Uint8Array | null,
): GraphicStyleLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<GraphicStyleLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== GRAPHIC_STYLES_LIBRARY_VERSION) return emptyLibrary();
  const styles: GraphicStyle[] = [];
  for (const entry of Array.isArray(lib.styles) ? lib.styles : []) {
    const s = entry as Partial<GraphicStyle>;
    if (typeof s?.id !== "string" || s.id.length === 0) continue;
    styles.push({
      id: s.id,
      name: typeof s.name === "string" && s.name.length > 0 ? s.name : s.id,
      appearance: graphicStyleAppearanceOf(s.appearance),
    });
  }
  return { v: GRAPHIC_STYLES_LIBRARY_VERSION, styles };
}

/** Serialize the library to the part's bytes — indented, because the
 *  `spec` role's whole point is that it stays small and DIFFABLE. */
export function serializeGraphicStyleLibrary(
  library: GraphicStyleLibrary,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: GRAPHIC_STYLES_LIBRARY_VERSION, styles: library.styles },
      null,
      2,
    )}\n`,
  );
}

// ------------------------------------------------- pure: library edits

/** The next free `gs-N` id. Deterministic (no randomness — the part is
 *  diffable and the tests are exact). */
export function mintGraphicStyleId(library: GraphicStyleLibrary): string {
  let max = 0;
  for (const s of library.styles) {
    const m = /^gs-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `gs-${max + 1}`;
}

export function findGraphicStyle(
  library: GraphicStyleLibrary,
  id: string,
): GraphicStyle | null {
  return library.styles.find((s) => s.id === id) ?? null;
}

/** Insert or replace a style (by id), preserving order. Pure. */
export function upsertGraphicStyle(
  library: GraphicStyleLibrary,
  style: GraphicStyle,
): GraphicStyleLibrary {
  const styles = library.styles.slice();
  const at = styles.findIndex((s) => s.id === style.id);
  if (at >= 0) styles[at] = style;
  else styles.push(style);
  return { v: GRAPHIC_STYLES_LIBRARY_VERSION, styles };
}

/** Rename a style. An unknown id — or an empty name — is an honest
 *  no-op (a stale panel row never corrupts the library). Pure. */
export function renameGraphicStyleIn(
  library: GraphicStyleLibrary,
  id: string,
  name: string,
): GraphicStyleLibrary {
  if (name.length === 0) return library;
  return {
    v: GRAPHIC_STYLES_LIBRARY_VERSION,
    styles: library.styles.map((s) => (s.id === id ? { ...s, name } : s)),
  };
}

/** Drop a style. An unknown id is a no-op. Pure. */
export function removeGraphicStyleFrom(
  library: GraphicStyleLibrary,
  id: string,
): GraphicStyleLibrary {
  return {
    v: GRAPHIC_STYLES_LIBRARY_VERSION,
    styles: library.styles.filter((s) => s.id !== id),
  };
}

// --------------------------------------------- pure: projection + digest

/** Project a complete appearance onto the property vocabulary an element
 *  actually has: EXACTLY what that element will read back once
 *  {@link applyGraphicStyleBatchFor} has run.
 *
 *  Two things happen, in the order the batch performs them:
 *    1. a base field whose `PropertyPath` the element does not expose is
 *       nulled — the op is not emitted, so nothing lands there;
 *    2. the STACK then bakes over the base, because `commitAppearance`'s
 *       front-most-layer bake is part of every apply: a top fill claims
 *       `frameFillColor` (and `frameFillTint` when it carries a numeric
 *       tint), a top stroke claims `frameStrokeColor` + `frameStrokeWeight`.
 *
 *  The metadata stack itself is NOT projected — `setPluginMetadata`
 *  lands on every path-bearing kind (probed on GraphicLine and Polygon),
 *  so the full stack always travels even when a kind cannot paint all of
 *  it. IDEMPOTENT: `project(project(a)) === project(a)`. */
export function projectGraphicAppearance(
  appearance: GraphicStyleAppearance,
  supported: Iterable<string>,
): GraphicStyleAppearance {
  const has = supported instanceof Set ? supported : new Set(supported);
  const base: GraphicStyleBase = {
    fill: has.has("frameFillColor") ? appearance.base.fill : null,
    fillTint: has.has("frameFillTint") ? appearance.base.fillTint : null,
    stroke: has.has("frameStrokeColor") ? appearance.base.stroke : null,
    strokeWeight: has.has("frameStrokeWeight")
      ? appearance.base.strokeWeight
      : null,
    opacity: has.has("frameOpacity") ? appearance.base.opacity : null,
    blendMode: has.has("frameBlendMode") ? appearance.base.blendMode : null,
  };
  const topFill = appearance.stack.fills.at(-1);
  if (topFill && has.has("frameFillColor")) {
    base.fill = topFill.color;
    if (typeof topFill.tint === "number" && has.has("frameFillTint")) {
      base.fillTint = topFill.tint;
    }
  }
  const topStroke = appearance.stack.strokes.at(-1);
  if (topStroke && has.has("frameStrokeColor")) {
    base.stroke = topStroke.color;
    if (has.has("frameStrokeWeight")) base.strokeWeight = topStroke.weight;
  }
  return {
    stack: { fills: appearance.stack.fills.slice(), strokes: appearance.stack.strokes.slice() },
    base,
  };
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4 + 0;

/** The canonical, order-stable serialization a digest is taken over.
 *  Positional arrays (never object key order), numbers rounded to 4dp so
 *  a round-tripped 2 vs 2.0000001 is the same appearance. Exported so the
 *  conformance spec can pin the equivalence classes directly. */
export function canonicalGraphicAppearance(
  appearance: GraphicStyleAppearance,
): string {
  const fills = appearance.stack.fills.map((f) => [
    strOrNull(f.color),
    f.tint == null ? null : round4(f.tint),
    f.opacity == null ? null : round4(f.opacity),
    strOrNull(f.blendMode),
  ]);
  const strokes = appearance.stack.strokes.map((s) => [
    strOrNull(s.color),
    s.weight == null ? null : round4(s.weight),
    s.opacity == null ? null : round4(s.opacity),
    strOrNull(s.blendMode),
  ]);
  const b = appearance.base;
  const base = [
    strOrNull(b.fill),
    b.fillTint == null ? null : round4(b.fillTint),
    strOrNull(b.stroke),
    b.strokeWeight == null ? null : round4(b.strokeWeight),
    b.opacity == null ? null : round4(b.opacity),
    strOrNull(b.blendMode),
  ];
  return JSON.stringify([fills, strokes, base]);
}

const fnv1a = (text: string, seed: number): number => {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/** A 16-hex-char content digest of a complete appearance — the value
 *  stamped as `ref.rev`. Pure + stable across sessions (no randomness,
 *  no key-order dependence). */
export function graphicAppearanceDigest(
  appearance: GraphicStyleAppearance,
): string {
  const text = canonicalGraphicAppearance(appearance);
  return (
    fnv1a(text, 0x811c9dc5).toString(16).padStart(8, "0") +
    fnv1a(text, 0x9dc5811c).toString(16).padStart(8, "0")
  );
}

// ----------------------------------------------- pure: the element ref

/** Read the style reference out of an envelope, or null. Tolerant of
 *  partial/foreign shapes. */
export function graphicStyleRefOf(
  env: PluginMetadataEnvelope | null,
): GraphicStyleRef | null {
  const raw = (env?.data as { graphicStyle?: unknown } | undefined)
    ?.graphicStyle;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<GraphicStyleRef>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  return { id: r.id, rev: typeof r.rev === "string" ? r.rev : "" };
}

/** Merge (or, with `null`, DROP) the style reference in an envelope,
 *  preserving every other draw metadata key — `appearance` above all:
 *  breaking a link must leave the appearance exactly where it is. */
export function withGraphicStyleRef(
  prev: PluginMetadataEnvelope | null,
  ref: GraphicStyleRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data.graphicStyle;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.graphicStyle = ref;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

/** Is this element's live appearance still the one the style gave it?
 *  `true` ⇒ OVERRIDDEN (edited directly since the apply). Pure. */
export function graphicStyleOverridden(
  ref: GraphicStyleRef,
  live: GraphicStyleAppearance,
): boolean {
  return graphicAppearanceDigest(live) !== ref.rev;
}

// -------------------------------------------------------- wire builder

const colorRefOp = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

const lengthOp = (
  elementId: ElementId,
  path: "frameFillTint" | "frameStrokeWeight" | "frameOpacity",
  value: number | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "length", value } },
});

const textOp = (
  elementId: ElementId,
  path: "frameBlendMode",
  value: string,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "text", value } },
});

/** The base-paint ops for one element, filtered by the vocabulary that
 *  element exposes. A style field the target cannot carry is DROPPED (an
 *  unsupported op would make the engine refuse the whole atomic batch);
 *  a field the style does not carry is CLEARED, not left behind — a
 *  `length` accepts `null` and `frameBlendMode` accepts `""` (both
 *  probed), so applying a style is a full replacement rather than a
 *  merge with whatever paint happened to be there. Pure; exported so the
 *  conformance spec asserts the EXACT wire shape. */
export function graphicStyleBaseMutations(
  elementId: ElementId,
  base: GraphicStyleBase,
  supported: Iterable<string>,
): Mutation[] {
  const has = supported instanceof Set ? supported : new Set(supported);
  const ops: Mutation[] = [];
  if (has.has("frameFillColor")) {
    ops.push(colorRefOp(elementId, "frameFillColor", base.fill));
  }
  if (has.has("frameFillTint")) {
    ops.push(lengthOp(elementId, "frameFillTint", base.fillTint));
  }
  if (has.has("frameStrokeColor")) {
    ops.push(colorRefOp(elementId, "frameStrokeColor", base.stroke));
  }
  if (has.has("frameStrokeWeight")) {
    ops.push(lengthOp(elementId, "frameStrokeWeight", base.strokeWeight));
  }
  if (has.has("frameOpacity")) {
    ops.push(lengthOp(elementId, "frameOpacity", base.opacity));
  }
  if (has.has("frameBlendMode")) {
    ops.push(textOp(elementId, "frameBlendMode", base.blendMode ?? ""));
  }
  return ops;
}

/** THE apply — ONE batch, therefore ONE undo step per element:
 *
 *    base paint (projected onto the target's vocabulary)
 *  → the front-most-layer bake of the style's stack
 *  → one RAW `setPluginMetadata` carrying the new stack AND the link.
 *
 *  The metadata rides INSIDE the batch (the `appearance-bake.ts` stamp
 *  builder) rather than through the facade's `setMetadata`, which is its
 *  own mutation and would cost a second undo step. Pure; exported so the
 *  conformance spec asserts the EXACT wire shape. */
export function applyGraphicStyleBatchFor(args: {
  elementId: ElementId;
  style: GraphicStyle;
  /** The target's own property vocabulary (`elementProperties` paths). */
  supported: Iterable<string>;
  /** The element's current envelope (every other draw key is preserved). */
  prev: PluginMetadataEnvelope | null;
}): Mutation {
  const projected = projectGraphicAppearance(args.style.appearance, args.supported);
  const stack = args.style.appearance.stack;
  const ops: Mutation[] = [
    ...graphicStyleBaseMutations(args.elementId, args.style.appearance.base, args.supported),
    ...bakeAppearanceMutations(args.elementId, stack).filter((m) =>
      m.op === "setElementProperty"
        ? (args.supported instanceof Set
            ? args.supported
            : new Set(args.supported)
          ).has(m.args.path)
        : true,
    ),
    stampDrawMetadata(
      args.elementId,
      withGraphicStyleRef(withAppearance(args.prev, stack), {
        id: args.style.id,
        rev: graphicAppearanceDigest(projected),
      }),
    ),
  ];
  return { op: "batch", args: { ops } };
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the library out of the container part. A host with no container
 *  writer (`supports("storage.parts@1")` false — an older editor) is not
 *  an error: it reads as an EMPTY library and WARNS once per call, so the
 *  degrade is visible in the log instead of looking like "no styles yet". */
export async function readGraphicStyleLibrary(
  host: PartsHost,
): Promise<GraphicStyleLibrary> {
  if (!host.supports(GRAPHIC_STYLES_FEATURE)) {
    host.log.warn(
      "graphic styles: this host wires no `.paged` container writer " +
        `(supports("${GRAPHIC_STYLES_FEATURE}") is false) — the style ` +
        "library cannot be read or saved here",
    );
    return emptyLibrary();
  }
  try {
    return parseGraphicStyleLibrary(await host.parts.read(GRAPHIC_STYLES_PART));
  } catch (e) {
    host.log.warn(`graphic styles: library read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the library back. `false` = it did not persist (no container
 *  door, or the write was refused) — logged, never thrown. */
export async function writeGraphicStyleLibrary(
  host: PartsHost,
  library: GraphicStyleLibrary,
): Promise<boolean> {
  if (!host.supports(GRAPHIC_STYLES_FEATURE)) {
    host.log.warn(
      "graphic styles: no `.paged` container writer — the style library " +
        "was NOT saved (nothing travels with this document)",
    );
    return false;
  }
  try {
    await host.parts.write(
      GRAPHIC_STYLES_PART,
      serializeGraphicStyleLibrary(library),
    );
    return true;
  } catch (e) {
    host.log.warn(`graphic styles: library write failed (${String(e)})`);
    return false;
  }
}

// ------------------------------------------------- host: element reads

/** What an element's live appearance is, plus the property vocabulary
 *  that element actually exposes (the projection input). */
export interface GraphicAppearanceRead {
  appearance: GraphicStyleAppearance;
  supported: string[];
  envelope: PluginMetadataEnvelope | null;
}

/** Read one element's COMPLETE live appearance: the metadata stack plus
 *  the base paint its own frame slots carry. A `frameBlendMode` of `""`
 *  (the engine's "unset" for a text property) normalizes to null so it
 *  digests the same as an element that never had one. */
export async function readGraphicAppearance(
  host: BundleHost,
  id: ElementId,
): Promise<GraphicAppearanceRead> {
  const envelope = await host.document.getMetadata(id).catch(() => null);
  const base: GraphicStyleBase = { ...EMPTY_GRAPHIC_STYLE_BASE };
  const supported: string[] = [];
  try {
    const props = await host.document.elementProperties(id);
    for (const e of props?.entries ?? []) {
      supported.push(e.path);
      const v = e.value;
      if (!v) continue;
      if (e.path === "frameFillColor" && v.type === "colorRef") base.fill = v.value;
      else if (e.path === "frameFillTint" && v.type === "length") {
        base.fillTint = v.value;
      } else if (e.path === "frameStrokeColor" && v.type === "colorRef") {
        base.stroke = v.value;
      } else if (e.path === "frameStrokeWeight" && v.type === "length") {
        base.strokeWeight = v.value;
      } else if (e.path === "frameOpacity" && v.type === "length") {
        base.opacity = v.value;
      } else if (e.path === "frameBlendMode" && v.type === "text") {
        base.blendMode = strOrNull(v.value);
      }
    }
  } catch {
    /* an unreadable element yields the empty base + no vocabulary */
  }
  return {
    appearance: { stack: appearanceOf(envelope), base },
    supported,
    envelope,
  };
}

/** The elements linked to `styleId` (or to ANY style when omitted), each
 *  with its reference and whether it is currently overridden. One scene
 *  walk + one metadata read per leaf — the `select-same` precedent. */
export async function graphicStyleLinks(
  host: BundleHost,
  styleId?: string,
): Promise<
  Array<{ id: ElementId; ref: GraphicStyleRef; overridden: boolean }>
> {
  const out: Array<{ id: ElementId; ref: GraphicStyleRef; overridden: boolean }> =
    [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const read = await readGraphicAppearance(host, id);
    const ref = graphicStyleRefOf(read.envelope);
    if (!ref) continue;
    if (styleId !== undefined && ref.id !== styleId) continue;
    out.push({ id, ref, overridden: graphicStyleOverridden(ref, read.appearance) });
  }
  return out;
}

// ------------------------------------------------------------ appliers

/** Why a graphic-style operation refused on this element (null = go). */
export type GraphicStyleRefusal = "baked";

/** A BAKED appearance is refused everywhere in this module — see the
 *  module header's limits. Pure. */
export function graphicStyleRefusalOf(
  env: PluginMetadataEnvelope | null,
): GraphicStyleRefusal | null {
  return appearanceBakeOf(env) ? "baked" : null;
}

const BAKED_REFUSAL =
  "the element's appearance is BAKED (a B-24 group of derived paths) — " +
  "its own paint is deliberately empty and its layers are real page " +
  "items, so a graphic style cannot be read from or written to it. " +
  "Release the baked stack first";

/** The one write path every command and every panel button goes through:
 *  ONE batch onto ONE element. `false` = refused (always logged). */
export async function linkGraphicStyle(
  host: BundleHost,
  id: ElementId,
  style: GraphicStyle,
  label: string,
): Promise<boolean> {
  const read = await readGraphicAppearance(host, id);
  if (graphicStyleRefusalOf(read.envelope)) {
    host.log.warn(`${label}: ${BAKED_REFUSAL} — no-op`);
    return false;
  }
  if (read.supported.length === 0) {
    host.log.warn(
      `${label}: the target exposes no property vocabulary (a group cannot ` +
        "carry an appearance or plugin metadata) — no-op",
    );
    return false;
  }
  const dropped = GRAPHIC_STYLE_BASE_PATHS.filter(
    (p) => !read.supported.includes(p),
  );
  if (dropped.length > 0) {
    host.log.warn(
      `${label}: "${style.name}" carries ${dropped.join(", ")}, which this ` +
        "element kind has no slot for — those properties are dropped (the " +
        "rest of the style applies, and the link records what was actually " +
        "written)",
    );
  }
  const outcome = await host.document.mutate(
    applyGraphicStyleBatchFor({
      elementId: id,
      style,
      supported: read.supported,
      prev: read.envelope,
    }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return false;
  }
  return true;
}

const selectionCarriers = async (
  host: BundleHost,
  label: string,
): Promise<ElementId[]> => {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: no selection — no-op`);
    return [];
  }
  const seen = new Set<string>();
  const out: ElementId[] = [];
  for (const selected of selection) {
    const carrier = await resolveAppearanceCarrier(host, selected);
    const key = `${carrier.kind}:${String(carrier.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(carrier);
  }
  return out;
};

/** SAVE — mint a style from the FIRST selected element's complete
 *  appearance, write the library, then APPLY it to the whole selection.
 *
 *  Save routes through the apply on purpose: the source ends up linked
 *  AND in sync (its `rev` is the digest of what the batch actually
 *  wrote), so "save then immediately look at it" never reports a phantom
 *  override. Returns the new style, or null on a refusal. */
export async function applySaveGraphicStyle(
  host: BundleHost,
  payload?: { name?: unknown },
): Promise<GraphicStyle | null> {
  const label = SAVE_GRAPHIC_STYLE_COMMAND_ID;
  const carriers = await selectionCarriers(host, label);
  if (carriers.length === 0) return null;
  const source = carriers[0]!;
  const read = await readGraphicAppearance(host, source);
  if (graphicStyleRefusalOf(read.envelope)) {
    host.log.warn(`${label}: ${BAKED_REFUSAL} — no-op`);
    return null;
  }
  const library = await readGraphicStyleLibrary(host);
  const name =
    typeof payload?.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : `Graphic style ${library.styles.length + 1}`;
  const style: GraphicStyle = {
    id: mintGraphicStyleId(library),
    name,
    appearance: projectGraphicAppearance(read.appearance, read.supported),
  };
  if (!(await writeGraphicStyleLibrary(host, upsertGraphicStyle(library, style)))) {
    return null;
  }
  for (const carrier of carriers) {
    await linkGraphicStyle(host, carrier, style, label);
  }
  return style;
}

/** APPLY — link every selected element to `styleId`. One undo step each. */
export async function applyGraphicStyleToSelection(
  host: BundleHost,
  styleId: unknown,
): Promise<void> {
  const label = APPLY_GRAPHIC_STYLE_COMMAND_ID;
  if (typeof styleId !== "string" || styleId.length === 0) {
    host.log.warn(`${label}: no styleId in the payload — no-op`);
    return;
  }
  const style = findGraphicStyle(await readGraphicStyleLibrary(host), styleId);
  if (!style) {
    host.log.warn(`${label}: no style "${styleId}" in the library — no-op`);
    return;
  }
  for (const carrier of await selectionCarriers(host, label)) {
    await linkGraphicStyle(host, carrier, style, label);
  }
}

/** REDEFINE — take the FIRST selected element's live appearance as the
 *  style's new definition, write the library, then RE-APPLY to every
 *  linked element, overridden ones included (the module header's
 *  decision 2). The count of overrides overwritten is logged, never
 *  hidden. */
export async function applyRedefineGraphicStyle(
  host: BundleHost,
  styleId: unknown,
): Promise<GraphicStyle | null> {
  const label = REDEFINE_GRAPHIC_STYLE_COMMAND_ID;
  if (typeof styleId !== "string" || styleId.length === 0) {
    host.log.warn(`${label}: no styleId in the payload — no-op`);
    return null;
  }
  const library = await readGraphicStyleLibrary(host);
  const existing = findGraphicStyle(library, styleId);
  if (!existing) {
    host.log.warn(`${label}: no style "${styleId}" in the library — no-op`);
    return null;
  }
  const carriers = await selectionCarriers(host, label);
  if (carriers.length === 0) return null;
  const read = await readGraphicAppearance(host, carriers[0]!);
  if (graphicStyleRefusalOf(read.envelope)) {
    host.log.warn(`${label}: ${BAKED_REFUSAL} — no-op`);
    return null;
  }
  const style: GraphicStyle = {
    ...existing,
    appearance: projectGraphicAppearance(read.appearance, read.supported),
  };
  if (!(await writeGraphicStyleLibrary(host, upsertGraphicStyle(library, style)))) {
    return null;
  }
  const links = await graphicStyleLinks(host, styleId);
  const overridden = links.filter((l) => l.overridden).length;
  if (overridden > 0) {
    host.log.info(
      `${label}: "${style.name}" propagates to ${links.length} linked ` +
        `element(s); ${overridden} of them had local overrides, which this ` +
        "redefine overwrites (break the link to keep a deviation)",
    );
  }
  for (const link of links) {
    await linkGraphicStyle(host, link.id, style, label);
  }
  return style;
}

/** BREAK LINK — drop the reference, keep the appearance. One
 *  `setMetadata` per element ⇒ one undo step each. */
export async function applyBreakGraphicStyleLink(
  host: BundleHost,
): Promise<void> {
  const label = BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID;
  for (const carrier of await selectionCarriers(host, label)) {
    const env = await host.document.getMetadata(carrier).catch(() => null);
    if (!graphicStyleRefOf(env)) {
      host.log.debug(`${label}: element carries no graphic-style link — no-op`);
      continue;
    }
    const outcome = await host.document.setMetadata(
      carrier,
      withGraphicStyleRef(env, null),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
}

/** RENAME — library-only, because an element reference stores the id and
 *  nothing else. No document mutation, so NOTHING to undo. */
export async function applyRenameGraphicStyle(
  host: BundleHost,
  styleId: unknown,
  name: unknown,
): Promise<boolean> {
  const label = RENAME_GRAPHIC_STYLE_COMMAND_ID;
  if (typeof styleId !== "string" || styleId.length === 0) {
    host.log.warn(`${label}: no styleId in the payload — no-op`);
    return false;
  }
  const next = typeof name === "string" ? name.trim() : "";
  if (next.length === 0) {
    host.log.warn(`${label}: no (non-empty) name in the payload — no-op`);
    return false;
  }
  const library = await readGraphicStyleLibrary(host);
  if (!findGraphicStyle(library, styleId)) {
    host.log.warn(`${label}: no style "${styleId}" in the library — no-op`);
    return false;
  }
  return writeGraphicStyleLibrary(
    host,
    renameGraphicStyleIn(library, styleId, next),
  );
}

/** DELETE — break every link to the style FIRST (one undo step each, so
 *  no element is left pointing at a style that is gone), then drop it
 *  from the library. */
export async function applyDeleteGraphicStyle(
  host: BundleHost,
  styleId: unknown,
): Promise<boolean> {
  const label = DELETE_GRAPHIC_STYLE_COMMAND_ID;
  if (typeof styleId !== "string" || styleId.length === 0) {
    host.log.warn(`${label}: no styleId in the payload — no-op`);
    return false;
  }
  const library = await readGraphicStyleLibrary(host);
  if (!findGraphicStyle(library, styleId)) {
    host.log.warn(`${label}: no style "${styleId}" in the library — no-op`);
    return false;
  }
  for (const link of await graphicStyleLinks(host, styleId)) {
    const env = await host.document.getMetadata(link.id).catch(() => null);
    const outcome = await host.document.setMetadata(
      link.id,
      withGraphicStyleRef(env, null),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
  return writeGraphicStyleLibrary(
    host,
    removeGraphicStyleFrom(library, styleId),
  );
}

// ------------------------------------------------------------- commands

const payloadOf = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

/** Register the six graphic-style commands. Payloads:
 *  save `{ name?: string }`, apply/redefine/delete `{ styleId: string }`,
 *  rename `{ styleId: string, name: string }`, break link — none. */
export function contributeGraphicStyleCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: SAVE_GRAPHIC_STYLE_COMMAND_ID,
      title: "Graphic Styles: Save style from selection",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySaveGraphicStyle(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: APPLY_GRAPHIC_STYLE_COMMAND_ID,
      title: "Graphic Styles: Apply style to selection",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyGraphicStyleToSelection(host, payloadOf(payload).styleId),
    }),
    host.contribute.command({
      id: REDEFINE_GRAPHIC_STYLE_COMMAND_ID,
      title: "Graphic Styles: Redefine style from selection",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyRedefineGraphicStyle(host, payloadOf(payload).styleId).then(
          () => undefined,
        ),
    }),
    host.contribute.command({
      id: BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID,
      title: "Graphic Styles: Break link (keep the appearance)",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: () => applyBreakGraphicStyleLink(host),
    }),
    host.contribute.command({
      id: RENAME_GRAPHIC_STYLE_COMMAND_ID,
      title: "Graphic Styles: Rename style",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyRenameGraphicStyle(host, p.styleId, p.name).then(
          () => undefined,
        );
      },
    }),
    host.contribute.command({
      id: DELETE_GRAPHIC_STYLE_COMMAND_ID,
      title: "Graphic Styles: Delete style",
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDeleteGraphicStyle(host, payloadOf(payload).styleId).then(
          () => undefined,
        ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
