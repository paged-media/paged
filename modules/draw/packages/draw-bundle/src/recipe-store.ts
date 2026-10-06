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
//   · the OBJECT-MODEL lane (`planRecipeWrite`, `host.objects`) is the
//     label-hash pattern: the library bytes into a CONTENT-ADDRESSED part
//     `recipes/<name>/<hash>.json` (never overwritten), and the DOCUMENT
//     label `x-paged:media.paged.draw` (designmap `<Document>` label,
//     protocol 69 `setDocumentMetadata`) naming that hash, folded into
//     the registry's ONE commit ⇒ one undo step. Undo reverts the label,
//     and the read follows it back.
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

import type {
  BundleHost,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import manifest from "../manifest.json";

/** The host doors the store needs. `document` is optional so a spec's
 *  parts-only fake keeps the legacy lane. */
export type RecipeHost = Pick<BundleHost, "parts" | "supports" | "log"> & {
  bindings?: BundleHost["bindings"];
  document?: Partial<
    Pick<BundleHost["document"], "getDocumentMetadata" | "setDocumentMetadata" | "onDidChange">
  >;
};

/** The label key — this plugin's own, the only one the engine lets it
 *  write (`x-paged:<id>.<sub>` is REFUSED by the engine: measured). */
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

/** The raw document-label mutation (for a batch: the object model folds
 *  it into the registry's ONE commit). */
export function recipeLabelMutation(envelope: PluginMetadataEnvelope): Mutation {
  return {
    op: "setDocumentMetadata",
    args: { key: RECIPE_LABEL_KEY, value: asciiJson(JSON.stringify(envelope)), caller: manifest.id },
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

/** A planned write: the label mutation to fold into the batch. The
 *  parts are already written (content-addressed / reconcilable, so a
 *  commit that then fails leaves the read unchanged — see the header). */
export interface RecipePlan {
  mutation: Mutation;
  /** The content hash the label will name. */
  h: string;
}

/** Libraries planned in the CURRENT registry batch, per host. The label
 *  is one key, so two libraries in one batch would each write an
 *  envelope built from the same pre-batch label and the second would
 *  silently drop the first. The registry plans every kind of a batch
 *  back to back before it commits, so a plan still marked here when
 *  another library plans IS the same batch: refused, never merged (a
 *  merge could carry a refused batch's state into a later one).
 *
 *  The mark ends at the batch's commit — the document event it raises
 *  (`onDidChange`; the headless engine is synchronous, so a timer is NOT
 *  a batch boundary — measured). A batch refused after planning raises
 *  none: its mark then outlives it until the next document change or
 *  macrotask, which can only refuse (never corrupt) a following write of
 *  a DIFFERENT library. A registry-level "batch begins / ends" hook would
 *  make this exact (contract issue, reported). */
const planning = new WeakMap<object, string>();
const watched = new WeakSet<object>();

function markPlanning(host: RecipeHost, name: string): void {
  planning.set(host, name);
  if (!watched.has(host) && typeof host.document?.onDidChange === "function") {
    watched.add(host);
    host.document.onDidChange(() => planning.delete(host));
  }
  setTimeout(() => {
    if (planning.get(host) === name) planning.delete(host);
  }, 0);
}

/**
 * Plan a library write for `host.objects` (the label-hash pattern). Writes
 * the parts (the content-addressed state, the origin snapshot on a
 * library's first labelled write, and the stamped fixed-name part) and
 * returns the label mutation the registry commits. A string = refused.
 */
export async function planRecipeWrite(
  host: RecipeHost,
  legacyPart: string,
  bytes: Uint8Array,
): Promise<RecipePlan | string> {
  const name = recipeNameOf(legacyPart);
  const busy = planning.get(host);
  if (busy !== undefined && busy !== name) {
    return (
      `draw libraries "${busy}" and "${name}" in one batch: they share the ` +
      "document label, so write them in separate batches"
    );
  }
  if (!labelled(host)) {
    return (
      `${name}: this host has no document label door (${RECIPE_LABEL_FEATURE}) — ` +
      "a library write cannot be made undoable here"
    );
  }
  markPlanning(host, name);
  const label = await readLabel(host);
  const prior = recipeEntriesOf(label)[name];
  if (!prior) {
    // The state the label falls back to if this write is undone.
    const before = await readRecipeBytes(host, legacyPart);
    await host.parts.write(recipeOriginPath(name), before ?? new Uint8Array());
  }
  const { envelope, h } = withRecipeEntry(label, name, bytes);
  await host.parts.write(recipePartPath(name, h), bytes);
  await host.parts.write(legacyPart, stampBase(bytes, h));
  rememberBase(host, legacyPart, h);
  return { mutation: recipeLabelMutation(envelope), h };
}
