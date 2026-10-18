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

// The paged.slide OBJECT MODEL (plugin-sdk ADR 323): a deck's slides,
// layouts, placeholders and the deck itself as addressable objects with
// typed schemas, so a data binding, a Boa script, the Node CLI and a panel
// field set "slide 3's notes" or "the title placeholder's text" the same way.
//
//   plugin:media.paged.slide/deck/deck
//   plugin:media.paged.slide/slide/<pageId>          a slide IS a core page
//   plugin:media.paged.slide/layout/<masterId>       a layout IS a master spread
//   plugin:media.paged.slide/placeholder/<frameId>   a placeholder IS a frame
//
// Persistence (ADR 703, object-model design §7, plugin-sdk DESIGN.md §21.8):
// the source of truth is LABELS, never a container part. Core keeps ONE
// label per plugin per host, `x-paged:media.paged.slide`, as the envelope
// `{"v": 1, "data": {…}}` (≤ 64 KiB).
//   · Slide-only data (hidden, notes, transition, layout, the source slide
//     part) lives in the slide's own PAGE label, flat in `data` — the shape
//     the importer writes into the package and the Slides and Notes panels
//     read (slides-model.ts) — so it travels with the page and no deck is
//     bound by one shared 64 KiB label (engine protocol 70
//     `setPageMetadata`). A model write keeps the keys it does not own
//     (`part`, the transition's `xml`). A page label in the branch-only
//     `data.slide` layout still reads.
//   · The deck (name, size, fonts) lives in the DOCUMENT label (`data.deck`).
//   · The earlier layout — every slide in the document label (`data.slides`,
//     keyed by page id with the ordinal beside it) — still READS; the first
//     model write moves those slides onto their pages and drops
//     `data.slides`, in the same undo step.
//   · Placeholder identity lives in each frame's own label (written by the
//     importer), which InDesign keeps on a round trip.
//   · The import report part is a CACHE: read when a label is missing (an
//     import whose label write was undone), never written by a model edit.
// Every write is CORE-BACKED (`ObjectWrite.kind = "mutations"`), planned by
// ONE plugin-level `batch` for all kinds: label changes and page ops
// (`applyMasterToPage`, `deletePage`, text edits) go to the engine as one
// batch, so a write is one undo step and undo needs no plugin-side history.

import type {
  Address,
  BundleHost,
  ElementId,
  MutationInput,
  ObjectKindContribution,
  ObjectModelHandle,
  ObjectOp,
  ObjectQuery,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { formatAddress, parseAddress } from "@paged-media/plugin-sdk";

import type { ImportReport, SlideReport, Transition } from "./engine.js";

import deckRows from "../schema/deck.json" with { type: "json" };
import layoutRows from "../schema/layout.json" with { type: "json" };
import placeholderRows from "../schema/placeholder.json" with { type: "json" };
import slideRows from "../schema/slide.json" with { type: "json" };
import importPptxArgs from "../schema/import-pptx.args.json" with { type: "json" };
import importPptxResult from "../schema/import-pptx.result.json" with { type: "json" };
import newSlideArgs from "../schema/new-slide.args.json" with { type: "json" };
import newSlideResult from "../schema/new-slide.result.json" with { type: "json" };

export const PLUGIN_ID = "media.paged.slide";
/** The label key every slide label is written under (the host derives the
 *  same key for `document.setMetadata`). */
export const LABEL_KEY = `x-paged:${PLUGIN_ID}`;
/** Version of the label payloads below (plugin-owned migrations). */
export const LABEL_VERSION = 1;
/** The engine's cap on one label is 64 KiB; stay under it with room for
 *  the envelope and the escaping. */
const LABEL_BUDGET = 60_000;

export const NEW_SLIDE_COMMAND = "media.paged.slide.newSlide";
export const IMPORT_PPTX_COMMAND = "media.paged.slide.importPptx";

export const SLIDE_SCHEMA = slideRows as unknown as readonly PropertySchema[];
export const LAYOUT_SCHEMA = layoutRows as unknown as readonly PropertySchema[];
export const PLACEHOLDER_SCHEMA = placeholderRows as unknown as readonly PropertySchema[];
export const DECK_SCHEMA = deckRows as unknown as readonly PropertySchema[];

// ------------------------------------------------------------ labels

/** A slide's own data, as its page label stores it (`data.slide`). */
export interface SlideData {
  hidden: boolean;
  notes: string | null;
  transition: TransitionRecord | null;
  /** Master id applied through this model (the engine reports none yet). */
  layout?: string | null;
}

/** A slide record in the EARLIER document-label layout (`data.slides`). */
export interface SlideRecord extends SlideData {
  /** 1-based position when last written: finds a renumbered page. */
  ord: number;
}

export interface TransitionRecord {
  kind: string | null;
  dir: string | null;
  speed: string | null;
  durationMs: number | null;
  advanceOnClick: boolean;
  advanceAfterMs: number | null;
}

/** The document label's payload. `slides` is the earlier layout: read for
 *  compatibility, never written. */
export interface DeckLabel {
  deck: { name: string | null; width: number; height: number; fonts: string[] };
  slides?: Record<string, SlideRecord>;
}

/** A transition as a page label stores it (the importer's shape plus the
 *  advance fields the model edits). */
export interface PageTransition {
  kind?: string | null;
  dir?: string | null;
  speed?: string | null;
  durationMs?: number | null;
  advanceOnClick?: boolean;
  advanceAfterMs?: number | null;
  /** The deck's own element, kept for export while the fields match it. */
  xml?: string;
}

/** A page label's payload, flat (slides-model.ts `SlideState`). Other keys
 *  (the source `part`, a later version's) are kept on a write. */
export interface PageLabel {
  layout?: string;
  part?: string;
  notes?: string;
  hidden?: boolean;
  transition?: PageTransition;
  /** The branch-only earlier layout: read, never written. */
  slide?: SlideData;
  [sub: string]: unknown;
}

/** A placeholder frame's label payload. */
export interface PlaceholderLabel {
  placeholder: { type: string; idx: number | null };
}

/** JSON whose non-ASCII characters are `\uXXXX` escapes: labels travel
 *  through InDesign as XML attribute text (ADR 559). Still valid JSON. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function envelope(data: unknown): string {
  return asciiJson({ v: LABEL_VERSION, data });
}

export function transitionRecord(t: Transition | null | undefined): TransitionRecord | null {
  if (!t) return null;
  return {
    kind: t.kind,
    dir: t.dir,
    speed: t.speed,
    durationMs: t.duration_ms,
    advanceOnClick: t.advance_on_click ?? true,
    advanceAfterMs: t.advance_after_ms,
  };
}

function dataFromReport(s: SlideReport): SlideData {
  return { hidden: s.hidden, notes: s.notes, transition: transitionRecord(s.transition) };
}

function pageLabelMutation(pageId: string, data: PageLabel): MutationInput {
  return { op: "setPageMetadata", args: { page: pageId, key: LABEL_KEY, value: envelope(data), caller: PLUGIN_ID } };
}

const FLAT_KEYS = ["layout", "part", "notes", "hidden", "transition"] as const;

/** Whether a page label carries slide data in the flat layout. */
function isFlat(label: PageLabel): boolean {
  return FLAT_KEYS.some((k) => label[k] !== undefined);
}

/** A flat page label as the model's slide data; the advance fields the
 *  importer does not write come from the report's slide, when known. */
function dataFromFlat(label: PageLabel, fromReport: SlideReport | undefined): SlideData {
  const t = label.transition;
  const rt = fromReport?.transition;
  return {
    hidden: label.hidden === true,
    notes: typeof label.notes === "string" && label.notes !== "" ? label.notes : null,
    transition: t
      ? {
          kind: t.kind ?? null,
          dir: t.dir ?? null,
          speed: t.speed ?? null,
          durationMs: t.durationMs ?? null,
          advanceOnClick: t.advanceOnClick ?? rt?.advance_on_click ?? true,
          advanceAfterMs: t.advanceAfterMs !== undefined ? t.advanceAfterMs : (rt?.advance_after_ms ?? null),
        }
      : null,
    ...(typeof label.layout === "string" && label.layout !== "" ? { layout: label.layout } : {}),
  };
}

/** `label` rewritten for `rec`: flat, the keys the model does not own kept,
 *  empty fields left out (as the importer and the Notes panel write them). */
export function flatLabel(label: PageLabel | null, rec: SlideData): PageLabel {
  const { slide: _earlier, notes: _n, hidden: _h, transition: prev, layout: _l, ...out } = label ?? {};
  const keepLayout = rec.layout !== undefined ? rec.layout : (label?.layout ?? label?.slide?.layout ?? null);
  const next: PageLabel = { ...out };
  if (keepLayout) next.layout = keepLayout;
  if (rec.notes !== null && rec.notes.trim() !== "") next.notes = rec.notes;
  if (rec.hidden) next.hidden = true;
  const t = rec.transition;
  if (t && (t.kind !== null || t.dir !== null || t.speed !== null || t.durationMs !== null || !t.advanceOnClick || t.advanceAfterMs !== null)) {
    const tr: PageTransition = {
      kind: t.kind,
      dir: t.dir,
      speed: t.speed,
      durationMs: t.durationMs,
      advanceOnClick: t.advanceOnClick,
      advanceAfterMs: t.advanceAfterMs,
    };
    // The deck's element describes the transition only while its fields
    // are the ones it was read with.
    const same =
      prev !== undefined &&
      (prev.kind ?? null) === t.kind &&
      (prev.dir ?? null) === t.dir &&
      (prev.speed ?? null) === t.speed &&
      (prev.durationMs ?? null) === t.durationMs;
    if (same && prev?.xml !== undefined) tr.xml = prev.xml;
    next.transition = tr;
  }
  return next;
}

/** The mutations that write an import's labels. The importer already wrote
 *  each slide's page label and every placeholder's label into the package;
 *  what is left is the deck label on the document. */
export function importLabelMutations(report: ImportReport, name: string | null): { mutations: MutationInput[] } {
  const deck: DeckLabel = { deck: { name, width: report.width, height: report.height, fonts: report.fonts } };
  return {
    mutations: [{ op: "setDocumentMetadata", args: { key: LABEL_KEY, value: envelope(deck), caller: PLUGIN_ID } }],
  };
}

// ------------------------------------------------------------ state

/** Where the import report cache is read from (activate.ts writes it, as `REPORT_PART`). */
const REPORT_PART = "import/report.json";

interface PlaceholderInfo {
  type: string;
  idx: number | null;
}

interface DeckPage {
  id: string;
  index: number;
  /** The page label's payload (null: no slide label on this page). */
  label: PageLabel | null;
}

/** One read of everything the model needs: labels first, cache second. */
interface Deck {
  label: DeckLabel | null;
  report: ImportReport | null;
  /** Current pages in document order. */
  pages: DeckPage[];
}

const SLIDE_KIND = "slide";
const LAYOUT_KIND = "layout";
const PLACEHOLDER_KIND = "placeholder";
const DECK_KIND = "deck";
const DECK_ID = "deck";

export function slideAddress(pageId: string): Address {
  return formatAddress({ kind: "plugin", plugin: PLUGIN_ID, objectKind: SLIDE_KIND, id: pageId });
}
export function layoutAddress(masterId: string): Address {
  return formatAddress({ kind: "plugin", plugin: PLUGIN_ID, objectKind: LAYOUT_KIND, id: masterId });
}
export function placeholderAddress(frameId: string): Address {
  return formatAddress({ kind: "plugin", plugin: PLUGIN_ID, objectKind: PLACEHOLDER_KIND, id: frameId });
}
export const DECK_ADDRESS: Address = formatAddress({ kind: "plugin", plugin: PLUGIN_ID, objectKind: DECK_KIND, id: DECK_ID });

function ownId(address: Address, kind: string): string | null {
  const a = parseAddress(address);
  return a && a.kind === "plugin" && a.plugin === PLUGIN_ID && a.objectKind === kind ? a.id : null;
}

const value = (v: unknown): ObjectValue => ({ kind: "value", value: v });
const absent: ObjectValue = { kind: "absent" };
const refused = (code: "unknownAddress" | "unknownPath" | "failed", reason: string): ObjectValue => ({
  kind: "refused",
  code,
  reason,
});
const rejected = (reason: string): ObjectWrite => ({ kind: "rejected", reason });

/** An envelope (parsed, or its JSON text) → its `data`, or null. */
function parseLabel<T>(raw: unknown): T | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const env = raw as { v?: unknown; data?: unknown };
  return env.v === LABEL_VERSION && typeof env.data === "object" && env.data !== null ? (env.data as T) : null;
}

const dataOf = ({ ord: _ord, ...data }: SlideRecord): SlideData => data;

/** The data a page's slide reads: its own page label, else (the earlier
 *  layout) its entry in the document label or the entry a renumbered page
 *  left at the same position, else the import cache. */
function recordFor(deck: Deck, pageId: string): SlideData | null {
  const page = deck.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const fromReport = deck.report?.slides.find((s) => s.pageId === pageId);
  if (page.label && isFlat(page.label)) return dataFromFlat(page.label, fromReport);
  if (page.label?.slide) return page.label.slide;
  const legacy = deck.label?.slides;
  if (legacy) {
    const own = legacy[pageId];
    if (own) return dataOf(own);
    const live = new Set(deck.pages.map((p) => p.id));
    for (const [id, rec] of Object.entries(legacy)) {
      if (!live.has(id) && rec.ord === page.index) return dataOf(rec);
    }
  }
  if (fromReport) return dataFromReport(fromReport);
  return { hidden: false, notes: null, transition: null };
}

const NO_TRANSITION: TransitionRecord = {
  kind: null,
  dir: null,
  speed: null,
  durationMs: null,
  advanceOnClick: true,
  advanceAfterMs: null,
};

/** Read a slide path off its record (`layout` and `index` are resolved by
 *  the caller, they need the engine). */
function slidePath(rec: SlideData, path: string): ObjectValue | null {
  const t = rec.transition ?? NO_TRANSITION;
  switch (path) {
    case "hidden":
      return value(rec.hidden);
    case "notes":
      return value(rec.notes);
    case "transitionKind":
      return value(t.kind ?? "none");
    case "transitionDirection":
      return value(t.dir);
    case "transitionSpeed":
      return value(t.speed);
    case "transitionDuration":
      return value(t.durationMs);
    case "advanceOnClick":
      return value(t.advanceOnClick);
    case "advanceAfter":
      return value(t.advanceAfterMs);
    default:
      return null;
  }
}

/** Write a slide path into a (copied) record; false when it is not a
 *  record path. */
function setSlidePath(rec: SlideData, path: string, v: unknown): boolean {
  const t = (rec.transition ??= { ...NO_TRANSITION });
  switch (path) {
    case "hidden":
      rec.hidden = v as boolean;
      return true;
    case "notes":
      rec.notes = (v as string | null) ?? null;
      return true;
    case "transitionKind":
      t.kind = v === "none" ? null : (v as string);
      return true;
    case "transitionDirection":
      t.dir = v as string | null;
      return true;
    case "transitionSpeed":
      t.speed = v as string | null;
      return true;
    case "transitionDuration":
      t.durationMs = v as number | null;
      return true;
    case "advanceOnClick":
      t.advanceOnClick = v as boolean;
      return true;
    case "advanceAfter":
      t.advanceAfterMs = v as number | null;
      return true;
    default:
      return false;
  }
}

// ------------------------------------------------------------ contribution

export interface SlideObjectModelOptions {
  /** Open a deck (the importer's path); the typed import command calls it. */
  openDeck(name: string, bytes: Uint8Array): Promise<ImportReport | null>;
}

/** Register the slide object model on `host`. Headless: no DOM, no edit
 *  context; every read goes to the engine (labels) or the report cache. */
export function contributeSlideObjectModel(host: BundleHost, options: SlideObjectModelOptions): ObjectModelHandle | null {
  if (!host.supports("contribute.objectModel@1")) return null;
  const objects = host.objects;

  async function readReport(): Promise<ImportReport | null> {
    if (!host.supports("storage.parts@1")) return null;
    try {
      const bytes = await host.parts.read(REPORT_PART);
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as ImportReport) : null;
    } catch {
      return null;
    }
  }

  async function pages(): Promise<DeckPage[]> {
    const out: DeckPage[] = [];
    for (const address of await objects.query("page")) {
      const a = parseAddress(address);
      if (a?.kind !== "page") continue;
      const ix = await objects.get(address, "index");
      const labels = await objects.get(address, "labels");
      const raw = labels.kind === "value" ? (labels.value as Record<string, string> | null)?.[LABEL_KEY] : undefined;
      out.push({ id: a.id, index: ix.kind === "value" ? Number(ix.value) : out.length + 1, label: parseLabel<PageLabel>(raw) });
    }
    return out.sort((x, y) => x.index - y.index);
  }

  /** The deck, or null when the document is not one (no label, no cache). */
  async function loadDeck(): Promise<Deck | null> {
    let label: DeckLabel | null = null;
    try {
      label = parseLabel<DeckLabel>(await host.document.getDocumentMetadata());
    } catch {
      label = null;
    }
    const report = await readReport();
    const all = await pages();
    if (!label && !report && !all.some((p) => p.label && (isFlat(p.label) || p.label.slide))) return null;
    return { label, report, pages: all };
  }

  /** A text value as a master id: a layout address, a master address or a
   *  bare id. */
  async function resolveMaster(ref: string): Promise<string | null> {
    const fromLayout = ownId(ref, LAYOUT_KIND);
    const a = parseAddress(ref);
    const id = fromLayout ?? (a?.kind === "master" ? a.id : ref);
    const masters = (await objects.query("master")).map((m) => parseAddress(m)).filter((m) => m?.kind === "master");
    return masters.some((m) => m && "id" in m && m.id === id) ? id : null;
  }

  /** A text value as a page id: a slide address, a page address or a bare id. */
  function slidePageId(ref: string): string {
    const own = ownId(ref, SLIDE_KIND);
    if (own) return own;
    const a = parseAddress(ref);
    return a?.kind === "page" ? a.id : ref;
  }

  async function layoutOf(deck: Deck, pageId: string): Promise<string | null> {
    const core = await objects.get(formatAddress({ kind: "page", id: pageId }), "appliedMaster");
    if (core.kind === "value" && typeof core.value === "string" && core.value.length > 0) {
      const a = parseAddress(core.value);
      return a?.kind === "master" ? a.id : core.value;
    }
    return recordFor(deck, pageId)?.layout ?? null;
  }

  // ------------------------------------------------------------ slide

  const slideKind: ObjectKindContribution = {
    kind: SLIDE_KIND,
    title: "Slide",
    schema: SLIDE_SCHEMA,
    // A slide IS its page: its label lives there, and `page:#2 > slide`
    // selects through it.
    hostOf: (address) => {
      const id = ownId(address, SLIDE_KIND);
      return id ? formatAddress({ kind: "page", id }) : null;
    },
    async list(query: ObjectQuery) {
      const deck = await loadDeck();
      if (!deck) return [];
      let out = deck.pages.map((p) => slideAddress(p.id));
      // A page item scope (`<frame> > slide`, a panel's selection): the
      // slide the item sits on.
      const within = query.within ? parseAddress(query.within) : null;
      if (within?.kind === "item") {
        const pageId = (await geometry(query.within!))?.pageId ?? null;
        out = pageId ? out.filter((a) => a === slideAddress(pageId)) : [];
      }
      return query.limit ? out.slice(0, query.limit) : out;
    },
    async get(address, path) {
      const id = ownId(address, SLIDE_KIND);
      const deck = await loadDeck();
      if (!id || !deck) return refused("unknownAddress", `${address}: not a slide of this document`);
      const rec = recordFor(deck, id);
      if (!rec) return refused("unknownAddress", `${address}: no such page`);
      if (path === "index") return value(deck.pages.find((p) => p.id === id)!.index);
      if (path === "page") return value(formatAddress({ kind: "page", id }));
      if (path === "layout") {
        const m = await layoutOf(deck, id);
        return m ? value(layoutAddress(m)) : absent;
      }
      return slidePath(rec, path) ?? refused("unknownPath", `slide has no path "${path}"`);
    },
  };

  // ------------------------------------------------------------ layout

  async function masters(): Promise<{ id: string; address: Address }[]> {
    return (await objects.query("master")).flatMap((address) => {
      const a = parseAddress(address);
      return a?.kind === "master" ? [{ id: a.id, address }] : [];
    });
  }

  const layoutKind: ObjectKindContribution = {
    kind: LAYOUT_KIND,
    title: "Slide layout",
    schema: LAYOUT_SCHEMA,
    hostOf: (address) => {
      const id = ownId(address, LAYOUT_KIND);
      return id ? formatAddress({ kind: "master", id }) : null;
    },
    async list(query) {
      if (!(await loadDeck())) return [];
      const out = (await masters()).map((m) => layoutAddress(m.id));
      return query.limit ? out.slice(0, query.limit) : out;
    },
    async get(address, path) {
      const id = ownId(address, LAYOUT_KIND);
      const m = id ? (await masters()).find((x) => x.id === id) : undefined;
      if (!m || !(await loadDeck())) return refused("unknownAddress", `${address}: not a layout of this deck`);
      switch (path) {
        case "name":
          return objects.get(m.address, "label");
        case "master":
          return value(m.address);
        case "slideCount":
          return objects.get(m.address, "pageCount");
        default:
          return refused("unknownPath", `layout has no path "${path}"`);
      }
    },
  };

  // ------------------------------------------------------------ placeholder

  async function itemAddress(frameId: string): Promise<Address | null> {
    const [hit] = await objects.query(formatAddress({ kind: "frame", id: frameId }));
    return hit ?? null;
  }

  function elementIdOf(address: Address): ElementId | null {
    const a = parseAddress(address);
    return a?.kind === "item" ? ({ kind: a.itemKind, id: a.id } as ElementId) : null;
  }

  async function placeholderInfo(deck: Deck, frameId: string, address: Address): Promise<PlaceholderInfo | null> {
    const id = elementIdOf(address);
    if (id) {
      try {
        const own = parseLabel<PlaceholderLabel>(await host.document.getMetadata(id));
        if (own) return { type: own.placeholder.type, idx: own.placeholder.idx };
      } catch {
        // fall through to the cache
      }
    }
    for (const s of deck.report?.slides ?? []) {
      const it = s.items.find((i) => i.id === frameId);
      if (it?.placeholder) return { type: it.placeholder[0], idx: it.placeholder[1] };
    }
    return null;
  }

  async function geometry(address: Address): Promise<{ pageId: string | null; storyId: string | null } | null> {
    const id = elementIdOf(address);
    if (!id) return null;
    const [g] = await host.document.elementGeometry([id]);
    if (!g) return null;
    const ext = g as { pageId?: string | null; storyId?: string };
    return { pageId: ext.pageId ?? null, storyId: ext.storyId ?? null };
  }

  const placeholderKind: ObjectKindContribution = {
    kind: PLACEHOLDER_KIND,
    title: "Placeholder",
    schema: PLACEHOLDER_SCHEMA,
    content: { kind: "text" },
    hostOf: (address) => {
      const id = ownId(address, PLACEHOLDER_KIND);
      return id ? formatAddress({ kind: "frame", id }) : null;
    },
    async list(query) {
      const deck = await loadDeck();
      if (!deck) return [];
      const ids = new Set<string>();
      for (const address of await objects.query(`frame[label.${LABEL_KEY}*="placeholder"]`)) {
        const a = parseAddress(address);
        if (a?.kind === "item") ids.add(a.id);
      }
      const cached = (deck.report?.slides ?? []).flatMap((s) => s.items.filter((i) => i.placeholder).map((i) => i.id));
      for (const id of cached) if (!ids.has(id) && (await itemAddress(id))) ids.add(id);
      let out = [...ids];
      // A page item scope (`<frame> > placeholder`): that frame, if it is one.
      const item = query.within ? parseAddress(query.within) : null;
      if (item?.kind === "item") out = out.filter((id) => id === item.id);
      const scope = query.within ? ownId(query.within, SLIDE_KIND) ?? (parseAddress(query.within)?.kind === "page" ? slidePageId(query.within) : null) : null;
      if (scope) {
        const kept: string[] = [];
        for (const id of out) {
          const address = await itemAddress(id);
          if (address && (await geometry(address))?.pageId === scope) kept.push(id);
        }
        out = kept;
      }
      const addresses = out.map(placeholderAddress);
      return query.limit ? addresses.slice(0, query.limit) : addresses;
    },
    async get(address, path) {
      const id = ownId(address, PLACEHOLDER_KIND);
      const deck = await loadDeck();
      const item = id ? await itemAddress(id) : null;
      const info = deck && id && item ? await placeholderInfo(deck, id, item) : null;
      if (!id || !item || !info) return refused("unknownAddress", `${address}: not a placeholder of this deck`);
      switch (path) {
        case "type":
          return value(info.type);
        case "index":
          return value(info.idx);
        case "target":
          return value(item);
        case "slide": {
          const g = await geometry(item);
          return g?.pageId ? value(slideAddress(g.pageId)) : absent;
        }
        case "content": {
          const g = await geometry(item);
          return g?.storyId ? objects.get(formatAddress({ kind: "story", id: g.storyId }), "content") : absent;
        }
        default:
          return refused("unknownPath", `placeholder has no path "${path}"`);
      }
    },
  };

  // ------------------------------------------------------------ deck

  const deckKind: ObjectKindContribution = {
    kind: DECK_KIND,
    title: "Deck",
    schema: DECK_SCHEMA,
    hostOf: () => "doc",
    async list() {
      return (await loadDeck()) ? [DECK_ADDRESS] : [];
    },
    async get(address, path) {
      const deck = ownId(address, DECK_KIND) === DECK_ID ? await loadDeck() : null;
      if (!deck) return refused("unknownAddress", `${address}: this document is not a slide deck`);
      const info = deck.label?.deck;
      const r = deck.report;
      switch (path) {
        case "name":
          return info?.name ? value(info.name) : absent;
        case "slideWidth":
          return value(info?.width ?? r?.width ?? null);
        case "slideHeight":
          return value(info?.height ?? r?.height ?? null);
        case "slideCount":
          return value(deck.pages.length);
        case "fonts":
          return value(info?.fonts ?? r?.fonts ?? []);
        default:
          return refused("unknownPath", `deck has no path "${path}"`);
      }
    },
  };

  // ------------------------------------------------------------ writes

  /** Placeholder `content` → replace the frame's story text. */
  async function planPlaceholder(
    op: ObjectOp,
    stories: readonly { selfId: string; characterCount: number }[],
    out: MutationInput[],
  ): Promise<string | null> {
    if (op.op !== "set") return "placeholders come from layouts; they are not created or deleted here";
    if (op.path !== "content") return `placeholder path "${op.path}" is not writable`;
    const id = ownId(op.address, PLACEHOLDER_KIND);
    const item = id ? await itemAddress(id) : null;
    const g = item ? await geometry(item) : null;
    if (!g?.storyId) return `${op.address} holds no text`;
    const len = stories.find((s) => s.selfId === g.storyId)?.characterCount ?? 0;
    if (len > 0) out.push({ op: "deleteRange", args: { storyId: g.storyId, start: 0, end: len } });
    const text = (op.value as string | null) ?? "";
    if (text.length > 0) out.push({ op: "insertText", args: { storyId: g.storyId, offset: 0, text } });
    return null;
  }

  /**
   * The PLUGIN-level planner (DESIGN.md §21.8): every op of a batch on any
   * slide kind, in order, answered as ONE core-backed write. Slide paths
   * rewrite their page's label (`setPageMetadata`); a deck still in the
   * earlier layout moves every slide onto its page and drops `data.slides`
   * from the document label in the same write.
   */
  async function planBatch(ops: readonly ObjectOp[]): Promise<ObjectWrite> {
    const deck = await loadDeck();
    if (!deck) return rejected("this document is not a slide deck");
    const mutations: MutationInput[] = [];
    /** Page id → its rewritten slide data (only pages this batch touches,
     *  plus every page when migrating). */
    const touched = new Map<string, SlideData>();
    const deleted = new Set<string>();
    const legacy = deck.label?.slides !== undefined;
    if (legacy) for (const p of deck.pages) touched.set(p.id, structuredClone(recordFor(deck, p.id)!));
    const seen = new Set<string>();
    let stories: readonly { selfId: string; characterCount: number }[] | null = null;
    for (const op of ops) {
      if (op.op === "invoke") continue;
      const kind = op.op === "create" ? op.kind.split("/").at(-1) : (parseAddress(op.address) as { objectKind?: string } | null)?.objectKind;
      if (kind === PLACEHOLDER_KIND) {
        if (op.op === "set" && seen.has(op.address)) return rejected(`${op.address} is set twice in one batch`);
        if (op.op === "set") seen.add(op.address);
        stories ??= await host.document.collection<{ selfId: string; characterCount: number }>("stories");
        const why = await planPlaceholder(op, stories, mutations);
        if (why) return rejected(why);
        continue;
      }
      if (kind !== SLIDE_KIND) return rejected(`${kind ?? "this object"} has no writable paths`);
      if (op.op === "create") return rejected(`slides are created with ${NEW_SLIDE_COMMAND}`);
      const id = ownId(op.address, SLIDE_KIND);
      if (!id || deleted.has(id) || !deck.pages.some((p) => p.id === id)) return rejected(`${op.address}: no such slide`);
      if (op.op === "delete") {
        mutations.push({ op: "deletePage", args: { pageId: id } });
        deleted.add(id);
        touched.delete(id);
        continue;
      }
      let rec = touched.get(id);
      if (!rec) touched.set(id, (rec = structuredClone(recordFor(deck, id)!)));
      if (op.path === "layout") {
        const master = op.value === null ? null : await resolveMaster(String(op.value));
        if (op.value !== null && master === null) return rejected(`${String(op.value)}: no such layout`);
        mutations.push({ op: "applyMasterToPage", args: { page: id, master } });
        rec.layout = master;
        continue;
      }
      if (!setSlidePath(rec, op.path, op.value)) return rejected(`slide path "${op.path}" is not writable`);
    }
    for (const [id, slide] of touched) {
      const page = deck.pages.find((p) => p.id === id)!;
      const m = pageLabelMutation(id, flatLabel(page.label, slide));
      if (((m.args as { value: string }).value.length ?? 0) > LABEL_BUDGET) {
        return rejected(`slide ${id}: its page label would exceed the engine's 64 KiB label cap`);
      }
      mutations.push(m);
    }
    if (legacy) {
      const { slides: _moved, ...rest } = deck.label!;
      mutations.push({ op: "setDocumentMetadata", args: { key: LABEL_KEY, value: envelope(rest), caller: PLUGIN_ID } });
    }
    return { kind: "mutations", mutations };
  }

  // ------------------------------------------------------------ commands

  const newSlide: TypedCommandContribution<{ after?: string; layout?: string }, { slide: Address }> = {
    id: NEW_SLIDE_COMMAND,
    title: "New slide",
    args: newSlideArgs as ValueType,
    result: newSlideResult as ValueType,
    async handler(_ctx, args) {
      const deck = await loadDeck();
      if (!deck) throw new Error("failed: this document is not a slide deck");
      const before = new Set(deck.pages.map((p) => p.id));
      // Both fields are optional (struct `optional`, DESIGN.md §21.8); "" is
      // still read as "not given" for callers written before that.
      const afterId = !args.after ? (deck.pages.at(-1)?.id ?? null) : slidePageId(args.after);
      if (afterId !== null && !before.has(afterId)) throw new Error(`unknownAddress: no slide ${args.after}`);
      let master: string | null = null;
      if (args.layout) {
        master = await resolveMaster(args.layout);
        if (master === null) throw new Error(`unknownAddress: no layout ${args.layout}`);
      } else if (afterId !== null) {
        master = await layoutOf(deck, afterId);
      }
      const outcome = await host.document.mutate({ op: "insertPage", args: { afterPageId: afterId, masterId: master } });
      if (!outcome.applied) throw new Error(`failed: insertPage was refused (${JSON.stringify(outcome.error)})`);
      const created = (await pages()).find((p) => !before.has(p.id));
      if (!created) throw new Error("failed: the engine reported no new page");
      return { slide: slideAddress(created.id) };
    },
  };

  const importPptx: TypedCommandContribution<
    { bytes: Uint8Array; name: string },
    { slides: Address[]; fonts: string[]; diagnostics: string[] }
  > = {
    id: IMPORT_PPTX_COMMAND,
    title: "Open a PowerPoint deck",
    args: importPptxArgs as ValueType,
    result: importPptxResult as ValueType,
    async handler(_ctx, args) {
      const report = await options.openDeck(args.name, args.bytes);
      if (!report) throw new Error("failed: this host cannot open a document");
      return {
        slides: report.slides.map((s) => slideAddress(s.pageId)),
        fonts: report.fonts,
        diagnostics: report.diagnostics,
      };
    },
  };

  return host.contribute.objectModel({
    kinds: [deckKind, slideKind, layoutKind, placeholderKind],
    commands: [newSlide, importPptx] as readonly TypedCommandContribution[],
    batch: planBatch,
  });
}
