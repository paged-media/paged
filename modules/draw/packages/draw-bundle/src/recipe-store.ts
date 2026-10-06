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

// THE RECIPE STORE — the seven draw libraries (graphic styles, symbols,
// live paint, pattern, repeat, blend, objects on a path): one read door
// for both write lanes, and an UNDOABLE write lane for the object model
// (the label-hash pattern, ADR 323 rule 2), InDesign-survivable (ADR 559).
//
// THE PROBLEM. Each library is ONE fixed-name `.paged` part
// (`paged/media.paged.draw/<name>.json`) overwritten in place. A part
// write is not an engine mutation, so undo never touched it (measured,
// the graphic-styles finding).
//
// TWO WRITE LANES, deliberately:
//   · the COMMAND lane (`writeRecipeBytes`) keeps the fixed-name part and
//     stays OFF the undo stack. Make / update flows record MINTED ids in
//     their recipe, which exist only after the artwork batch commits, so
//     a label write would be a SECOND mutation — and break the one-undo-
//     step make/update every flow here was built to (CLAUDE.md, C-15).
//   · the OBJECT-MODEL lane (`planRecipeWrites`, `host.objects`) is the
//     label-hash pattern: the library bytes into a CONTENT-ADDRESSED part
//     `recipes/<name>/<hash>.json` (never overwritten), and the DOCUMENT
//     label `x-paged:media.paged.draw` (designmap `<Document>` label,
//     protocol 69 `setDocumentMetadata`) naming that hash. It is a
//     `state` write hosted on `doc` under the sub-key
//     `x-paged:media.paged.draw.recipes`: the REGISTRY writes the parts
//     and merges `data.recipes` into the label inside its ONE commit ⇒
//     one undo step. Undo reverts the label, and the read follows it
//     back. Every library a batch writes is planned together (the
//     plugin-level `objectModel.batch`), so they share one label write.
//
// ONE READ reconciles the two. Every write also leaves the fixed-name
// part as the latest state, stamped `_base` = the label hash it was
// written against (absent while no label entry exists — every pre-label
// document, and every document only commands ever wrote, which therefore
// reads exactly as before: one part read, no label read):
//   · `_base` absent, or equal to the label's current hash ⇒ the part is
//     current;
//   · otherwise the label MOVED since (undo / redo of an object-model
//     write) ⇒ read the content-addressed part the label names, or —
//     the label having no entry any more — `recipes/<name>/origin.json`,
//     the state before the first labelled write.
// The document label is ONE key for this plugin, so it carries every
// library's entry:
//
//   { v: 1, data: { recipes: { "<name>": { h: "<16 hex>", inline?: "<json>" } } } }
//
// PARTS ARE A CACHE, NOT THE TRUTH (ADR 559). InDesign drops every unknown
// part on save and keeps the designmap label byte-exact, so a library
// small enough rides INLINE in the label too (the exact JSON text; the
// whole label stays under INLINE_BUDGET of the engine's 64 KiB cap). With
// every part gone, the inline copy is what reads. A library over budget,
// or one only commands ever wrote, does not survive an InDesign save —
// recorded as a gap.

import type { BundleHost, PluginMetadataEnvelope } from "@paged-media/plugin-api";

import manifest from "../manifest.json";

/** The host doors the store needs. `document` is optional so a spec's
 *  parts-only fake keeps the legacy lane. */
export type RecipeHost = Pick<BundleHost, "parts" | "supports" | "log"> & {
  bindings?: BundleHost["bindings"];
  document?: Partial<
    Pick<BundleHost["document"], "getDocumentMetadata" | "setDocumentMetadata" | "onDidChange">
  >;
};

/** The label key — this plugin's own, the only one core lets it write.
 *  The object-model lane writes the SUB-KEY `x-paged:<id>.recipes`
 *  (`RECIPE_SUBKEY`), which the registry merges into this one label's
 *  `data` (plugin-sdk DESIGN.md §21.8) — core itself never sees a sub-key. */
export const RECIPE_LABEL_KEY = `x-paged:${manifest.id}`;

/** The feature the label lane rides. */
export const RECIPE_LABEL_FEATURE = "document.documentMetadata@1";

/** The label is capped at 64 KiB by the engine; inline copies stop well
 *  short of it so the hashes always fit. */
export const INLINE_BUDGET = 48 * 1024;

/** One library's entry in the document label. */
export interface RecipeLabelEntry {
  /** Content hash of the library bytes (`recipes/<name>/<h>.json`). */
  h: string;
  /** The exact JSON text, when it fits the label budget (ADR 559). */
  inline?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** `graphic-styles.json` → `graphic-styles`. */
export const recipeNameOf = (legacyPart: string): string =>
  legacyPart.replace(/\.json$/, "");

/** The content-addressed part a hash names. */
export const recipePartPath = (name: string, h: string): string =>
  `recipes/${name}/${h}.json`;

const fnv1a = (text: string, seed: number): number => {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/** 16 hex chars — content addressing, not security. */
export function recipeHash(text: string): string {
  return (
    fnv1a(text, 0x811c9dc5).toString(16).padStart(8, "0") +
    fnv1a(text, 0x9dc5811c).toString(16).padStart(8, "0")
  );
}

/** Non-ASCII → `\uXXXX` (still valid JSON), the form InDesign keeps a
 *  label value in byte-exact (round-trip survey, 2026-10-06). */
const asciiJson = (text: string): string =>
  text.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Does this host carry the undoable label lane? */
export function labelled(host: RecipeHost): boolean {
  return (
    typeof host.document?.getDocumentMetadata === "function" &&
    typeof host.document?.setDocumentMetadata === "function" &&
    host.supports(RECIPE_LABEL_FEATURE)
  );
}

/** The recipes map out of a document envelope (tolerant). */
export function recipeEntriesOf(
  env: PluginMetadataEnvelope | null,
): Record<string, RecipeLabelEntry> {
  const raw = (env?.data as { recipes?: unknown } | undefined)?.recipes;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, RecipeLabelEntry> = {};
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    const entry = e as Partial<RecipeLabelEntry> | null;
    if (!entry || typeof entry.h !== "string") continue;
    out[name] = {
      h: entry.h,
      ...(typeof entry.inline === "string" ? { inline: entry.inline } : {}),
    };
  }
  return out;
}

async function readLabel(host: RecipeHost): Promise<PluginMetadataEnvelope | null> {
  try {
    return (await host.document!.getDocumentMetadata!()) ?? null;
  } catch {
    return null;
  }
}

interface LegacyRead {
  /** The fixed-name part's library bytes with `_base` removed. */
  bytes: Uint8Array | null;
  /** The label hash it was written against (null = none). */
  base: string | null;
}

/** The `_base` each fixed-name part carried when this host last read or
 *  wrote it — so the COMMAND lane's write (which always follows its own
 *  read of the library) costs no second part read to learn it. Keyed by
 *  host like the link index; a stale entry can only drop a stamp, which
 *  makes the part read as current (the command lane's own semantics). */
const lastBase = new WeakMap<object, Map<string, string | null>>();
const rememberBase = (host: object, legacyPart: string, base: string | null): void => {
  let m = lastBase.get(host);
  if (!m) lastBase.set(host, (m = new Map()));
  m.set(legacyPart, base);
};

/** Read the fixed-name part and split off its `_base` stamp. */
async function readLegacy(host: RecipeHost, legacyPart: string): Promise<LegacyRead> {
  const raw = await host.parts.read(legacyPart);
  const out = splitLegacy(raw);
  rememberBase(host, legacyPart, out.base);
  return out;
}

function splitLegacy(raw: Uint8Array | null): LegacyRead {
  if (!raw || raw.byteLength === 0) return { bytes: null, base: null };
  const text = decoder.decode(raw);
  if (!text.includes('"_base"')) return { bytes: raw, base: null };
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const base = typeof obj._base === "string" ? obj._base : null;
    delete obj._base;
    return { bytes: encoder.encode(`${JSON.stringify(obj, null, 2)}\n`), base };
  } catch {
    return { bytes: raw, base: null };
  }
}

/** The fixed-name part's bytes, stamped with the label hash (pure). */
export function stampBase(bytes: Uint8Array, base: string | null): Uint8Array {
  if (base === null) return bytes;
  try {
    const obj = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    return encoder.encode(`${JSON.stringify({ _base: base, ...obj }, null, 2)}\n`);
  } catch {
    return bytes;
  }
}

/** The state before the first labelled write. */
export const recipeOriginPath = (name: string): string => `recipes/${name}/origin.json`;

const nonEmpty = (b: Uint8Array | null): Uint8Array | null =>
  b && b.byteLength > 0 ? b : null;

/** Read a library's bytes — see the header for the reconciliation. */
export async function readRecipeBytes(
  host: RecipeHost,
  legacyPart: string,
): Promise<Uint8Array | null> {
  const legacy = await readLegacy(host, legacyPart);
  // Only commands ever wrote it (or it predates labels): no label read.
  if (legacy.bytes && legacy.base === null) return legacy.bytes;
  if (!labelled(host)) return legacy.bytes;
  const name = recipeNameOf(legacyPart);
  const entry = recipeEntriesOf(await readLabel(host))[name] ?? null;
  const current = entry?.h ?? null;
  if (legacy.bytes && legacy.base === current) return legacy.bytes;
  if (!legacy.bytes && !entry) return null;
  if (entry) {
    const bytes = nonEmpty(await host.parts.read(recipePartPath(name, entry.h)).catch(() => null));
    if (bytes) return bytes;
    if (entry.inline !== undefined) return encoder.encode(entry.inline);
    host.log.warn(
      `${name}: the document label names recipe ${entry.h}, but its part is gone ` +
        "and the label carried no inline copy (over the label budget) — reads as empty",
    );
    return null;
  }
  // The label lost its entry (the first labelled write was undone).
  return nonEmpty(await host.parts.read(recipeOriginPath(name)).catch(() => null));
}

/** The label envelope after setting `name` to `bytes` (pure). Every other
 *  data key and every other library's entry is preserved; inline copies
 *  are kept while the whole label stays under INLINE_BUDGET, the library
 *  being written first. */
export function withRecipeEntry(
  prev: PluginMetadataEnvelope | null,
  name: string,
  bytes: Uint8Array,
): { envelope: PluginMetadataEnvelope; h: string } {
  const text = decoder.decode(bytes);
  const h = recipeHash(text);
  const entries = recipeEntriesOf(prev);
  // Re-derive inline copies from scratch: the written one first, then the
  // others in name order, each kept only while the label fits.
  const full: Record<string, string | undefined> = {};
  for (const [n, e] of Object.entries(entries)) full[n] = e.inline;
  full[name] = text;
  const next: Record<string, RecipeLabelEntry> = {};
  for (const [n, e] of Object.entries(entries)) next[n] = { h: e.h };
  next[name] = { h };
  const order = [name, ...Object.keys(next).filter((n) => n !== name).sort()];
  const sizeOf = (r: Record<string, RecipeLabelEntry>) =>
    asciiJson(JSON.stringify({ v: prev?.v ?? 1, data: { ...(prev?.data ?? {}), recipes: r } })).length;
  for (const n of order) {
    const inline = full[n];
    if (inline === undefined) continue;
    const candidate = { ...next, [n]: { h: next[n]!.h, inline } };
    if (sizeOf(candidate) <= INLINE_BUDGET) Object.assign(next, { [n]: candidate[n] });
  }
  return {
    envelope: {
      v: prev?.v ?? 1,
      data: { ...(prev?.data ?? {}), recipes: next },
      ...(prev?.engine ? { engine: prev.engine } : {}),
    },
    h,
  };
}

/**
 * Write a library (the COMMAND lane): the fixed-name part, OFF the undo
 * stack (see the header for why). When an object-model write has stamped
 * the part, the new state is stamped with the label's current hash so the
 * read keeps treating it as current. Throws on a failed write, as
 * `parts.write` did, so the callers' handling is unchanged.
 */
export async function writeRecipeBytes(
  host: RecipeHost,
  legacyPart: string,
  bytes: Uint8Array,
): Promise<void> {
  let base: string | null = null;
  if (labelled(host)) {
    const known = lastBase.get(host)?.get(legacyPart);
    const stamped = known !== undefined ? known : (await readLegacy(host, legacyPart)).base;
    if (stamped !== null) {
      const entry = recipeEntriesOf(await readLabel(host))[recipeNameOf(legacyPart)];
      base = entry?.h ?? null;
    }
  }
  await host.parts.write(legacyPart, stampBase(bytes, base));
  rememberBase(host, legacyPart, base);
}

// ------------------------------------------- the object-model lane

/** The SUB-KEY the library entries ride under (plugin-sdk DESIGN.md
 *  §21.8): the registry reads the document label, sets `data.recipes`,
 *  and writes ONE merged label — every other `data` key survives. */
export const RECIPE_SUBKEY = `${RECIPE_LABEL_KEY}.recipes`;

/** One library a batch writes. */
export interface RecipeWrite {
  legacyPart: string;
  bytes: Uint8Array;
}

/** A planned library write: a `state` write hosted on the document. The
 *  REGISTRY writes the parts (content-addressed, the origin snapshot,
 *  the stamped fixed-name part) and folds the label into its one commit;
 *  the store writes nothing itself. */
export interface RecipeStatePlan {
  host: "doc";
  labelKey: string;
  /** `data.recipes`, as JSON text (ASCII — non-ASCII escaped). */
  labelValue: string;
  parts: { path: string; bytes: Uint8Array }[];
  /** library name → the content hash the label will name. */
  hashes: Record<string, string>;
}

/**
 * Plan EVERY library a batch writes as ONE document-label write (the
 * label-hash pattern). The object model's plugin-level `batch` hands all
 * of a batch's library writes here together, so two libraries in one
 * batch land in one label (they share it). A later write of the same
 * library in the list wins. A string = refused.
 */
export async function planRecipeWrites(
  host: RecipeHost,
  writes: readonly RecipeWrite[],
): Promise<RecipeStatePlan | string> {
  if (writes.length === 0) return "no library to write";
  if (!labelled(host)) {
    const names = writes.map((w) => recipeNameOf(w.legacyPart)).join(", ");
    return (
      `${names}: this host has no document label door (${RECIPE_LABEL_FEATURE}) — ` +
      "a library write cannot be made undoable here"
    );
  }
  const last = new Map<string, RecipeWrite>();
  for (const w of writes) last.set(w.legacyPart, w);
  const label = await readLabel(host);
  const prior = recipeEntriesOf(label);
  let envelope: PluginMetadataEnvelope | null = label;
  const parts: { path: string; bytes: Uint8Array }[] = [];
  const hashes: Record<string, string> = {};
  for (const { legacyPart, bytes } of last.values()) {
    const name = recipeNameOf(legacyPart);
    if (!prior[name]) {
      // The state the label falls back to if this write is undone.
      const before = await readRecipeBytes(host, legacyPart);
      parts.push({ path: recipeOriginPath(name), bytes: before ?? new Uint8Array() });
    }
    const next = withRecipeEntry(envelope, name, bytes);
    envelope = next.envelope;
    hashes[name] = next.h;
    parts.push({ path: recipePartPath(name, next.h), bytes });
    parts.push({ path: legacyPart, bytes: stampBase(bytes, next.h) });
    // The stamp lands only if the registry commits; forget the cached
    // one so the command lane re-reads the part (never trusts a guess).
    lastBase.get(host)?.delete(legacyPart);
  }
  const recipes = (envelope!.data as { recipes: unknown }).recipes;
  return {
    host: "doc",
    labelKey: RECIPE_SUBKEY,
    labelValue: asciiJson(JSON.stringify(recipes)),
    parts,
    hashes,
  };
}

/** One library alone (the single-write form of `planRecipeWrites`). */
export const planRecipeWrite = (
  host: RecipeHost,
  legacyPart: string,
  bytes: Uint8Array,
): Promise<RecipeStatePlan | string> => planRecipeWrites(host, [{ legacyPart, bytes }]);
