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

// The slides a deck has, as the panels show them: the document's pages in
// order, each with its own state (speaker notes, hidden, transition) read
// off its plugin metadata, its thumbnail, and which one the user is on.
// Pure parts (state parsing, the mutations) are plain functions; the store
// only talks to the host doors, so a test drives it with a fake host.

import type { BundleHost, MutationInput } from "@paged-media/plugin-api";

/** One plugin-metadata entry as the engine reports it. */
export interface PluginMetadataEntry {
  key: string;
  value: string;
}

/** The key a slide's state lives under on its page (written by the importer). */
export const SLIDE_KEY = "x-paged:media.paged.slide";
/** The plugin id the engine's caller gate checks the key against. */
export const SLIDE_CALLER = "media.paged.slide";

export interface Transition {
  kind?: string | null;
  dir?: string | null;
  speed?: string | null;
  durationMs?: number | null;
  /** The deck's own element, kept for export. */
  xml?: string;
}

/** A slide's own state; absent fields mean "none". */
export interface SlideState {
  /** The master spread of the layout the slide was made from. */
  layout?: string;
  /** The slide part of the deck the page came from (export writes it back
   *  as that slide). */
  part?: string;
  notes?: string;
  hidden?: boolean;
  transition?: Transition;
}

export interface Slide {
  pageId: string;
  /** 1-based position. */
  number: number;
  sizePt: [number, number];
  state: SlideState;
}

/** The slide state in a page's plugin metadata, or empty. A value that is
 *  not the engine's envelope is ignored rather than trusted. */
export function parseState(meta: readonly PluginMetadataEntry[] | undefined): SlideState {
  const entry = meta?.find((m) => m.key === SLIDE_KEY);
  if (!entry) return {};
  try {
    const env = JSON.parse(entry.value) as { v?: unknown; data?: unknown };
    if (typeof env.data !== "object" || env.data === null) return {};
    const d = env.data as Record<string, unknown>;
    const out: SlideState = {};
    if (typeof d.layout === "string" && d.layout !== "") out.layout = d.layout;
    if (typeof d.part === "string" && d.part !== "") out.part = d.part;
    if (typeof d.notes === "string" && d.notes !== "") out.notes = d.notes;
    if (d.hidden === true) out.hidden = true;
    if (typeof d.transition === "object" && d.transition !== null) {
      out.transition = d.transition as Transition;
    }
    return out;
  } catch {
    return {};
  }
}

/** The envelope for `state`, or null when there is nothing to keep. */
export function encodeState(state: SlideState): string | null {
  const data: Record<string, unknown> = {};
  if (state.layout) data.layout = state.layout;
  if (state.part) data.part = state.part;
  if (state.notes && state.notes.trim() !== "") data.notes = state.notes;
  if (state.hidden) data.hidden = true;
  if (state.transition) data.transition = state.transition;
  return Object.keys(data).length === 0 ? null : JSON.stringify({ v: 1, data });
}

/** Write a slide's whole state (one undoable step). */
export function setStateMutation(pageId: string, state: SlideState): MutationInput {
  return {
    op: "setPageMetadata",
    args: { page: pageId, key: SLIDE_KEY, value: encodeState(state), caller: SLIDE_CALLER },
  };
}

/** Move `pageId` so it lands at position `to` (0-based) of `order`. */
export function moveMutation(order: readonly string[], pageId: string, to: number): MutationInput | null {
  const from = order.indexOf(pageId);
  if (from < 0) return null;
  const rest = order.filter((p) => p !== pageId);
  const at = Math.max(0, Math.min(to, rest.length));
  if (at === from) return null;
  return { op: "movePage", args: { page: pageId, after: at === 0 ? null : rest[at - 1] } };
}

export function duplicateMutation(pageId: string): MutationInput {
  return { op: "duplicatePage", args: { page: pageId } };
}

export function deleteMutation(pageId: string): MutationInput {
  return { op: "deletePage", args: { pageId } };
}

type PageSummary = {
  selfId: string;
  sizePt: [number, number];
  pluginMetadata?: PluginMetadataEntry[];
};

/** Thumbnail width in device pixels. */
export const THUMB_WIDTH = 320;

/**
 * The slides of the open document, kept current: re-read on every document
 * change, thumbnails rendered on demand and dropped when the page they show
 * is reported changed.
 */
export class SlidesStore {
  private slides: Slide[] = [];
  private active: string | null = null;
  private readonly thumbs = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private generation = 0;

  constructor(
    private readonly host: BundleHost,
    private readonly urlOf: (png: Uint8Array) => string = defaultUrl,
    private readonly revoke: (url: string) => void = defaultRevoke,
  ) {
    this.active = host.viewport.activePage();
    this.disposers.push(
      // A change repaints the pages it names; one that names none (a notes
      // edit) keeps every thumbnail.
      host.document.onDidChange((e) => {
        this.invalidate(e.pageIds);
        void this.refresh();
      }).dispose,
      // Another document: nothing of the old one applies.
      host.document.onDidOpen(() => {
        this.invalidate(null);
        this.active = host.viewport.activePage();
        void this.refresh();
      }).dispose,
      host.viewport.onDidChangeActivePage((p) => {
        this.active = p;
        this.emit();
      }).dispose,
    );
    void this.refresh();
  }

  list(): readonly Slide[] {
    return this.slides;
  }

  activePage(): string | null {
    return this.active;
  }

  activeSlide(): Slide | null {
    return this.slides.find((s) => s.pageId === this.active) ?? null;
  }

  /** The thumbnail URL, or null while it renders (the store emits when it lands). */
  thumbnail(pageId: string): string | null {
    const url = this.thumbs.get(pageId);
    if (url) return url;
    if (!this.pending.has(pageId) && this.host.supports("render.snapshot@1")) {
      const gen = this.generation;
      const job = this.host.render
        .snapshot(pageId, { widthPx: THUMB_WIDTH })
        .then((shot) => {
          if (shot && gen === this.generation) {
            this.thumbs.set(pageId, this.urlOf(shot.png));
            this.emit();
          }
        })
        .catch(() => {})
        .finally(() => this.pending.delete(pageId));
      this.pending.set(pageId, job);
    }
    return null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    let pages: readonly PageSummary[];
    try {
      pages = await this.host.document.collection<PageSummary>("pages");
    } catch {
      pages = [];
    }
    this.slides = pages.map((p, i) => ({
      pageId: p.selfId,
      number: i + 1,
      sizePt: p.sizePt,
      state: parseState(p.pluginMetadata),
    }));
    for (const id of [...this.thumbs.keys()]) {
      if (!pages.some((p) => p.selfId === id)) this.drop(id);
    }
    this.emit();
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    for (const id of [...this.thumbs.keys()]) this.drop(id);
    this.listeners.clear();
  }

  /** Forget thumbnails of `pageIds` (all when null), so they re-render. */
  private invalidate(pageIds: readonly string[] | null): void {
    this.generation++;
    for (const id of pageIds ?? [...this.thumbs.keys()]) this.drop(id);
  }

  private drop(id: string): void {
    const url = this.thumbs.get(id);
    if (url) this.revoke(url);
    this.thumbs.delete(id);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

function defaultUrl(png: Uint8Array): string {
  return URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
}

function defaultRevoke(url: string): void {
  URL.revokeObjectURL(url);
}

/** A layout a new slide can be made from: a master spread some slide uses. */
export interface Layout {
  masterId: string;
  name: string;
  /** A slide made from it, copied to make the new one. */
  templatePageId: string;
}

/** The layouts new slides can be made from: every master spread a slide
 *  records as its layout, named as the deck named it. */
export async function layouts(host: BundleHost, slides: readonly Slide[]): Promise<Layout[]> {
  let masters: readonly { selfId: string; label: string }[] = [];
  try {
    masters = await host.document.collection<{ selfId: string; label: string }>("masterPages");
  } catch {
    masters = [];
  }
  const out: Layout[] = [];
  for (const m of masters) {
    const template = slides.find((s) => s.state.layout === m.selfId);
    if (template) out.push({ masterId: m.selfId, name: m.label, templatePageId: template.pageId });
  }
  return out;
}

/** Whether a scene-tree item is one of a layout's placeholders. */
function isPlaceholder(meta: readonly PluginMetadataEntry[] | undefined): boolean {
  const entry = meta?.find((m) => m.key === SLIDE_KEY);
  if (!entry) return false;
  try {
    const env = JSON.parse(entry.value) as { data?: { placeholder?: unknown } };
    return typeof env.data?.placeholder === "object" && env.data.placeholder !== null;
  } catch {
    return false;
  }
}

/** The length of a story in the text-editing unit: UTF-8 bytes, plus one
 *  per paragraph break. */
function storyLength(content: { paragraphs: { runs: { text: string }[] }[] }): number {
  const enc = new TextEncoder();
  return content.paragraphs.reduce(
    (n, p, i) => n + (i > 0 ? 1 : 0) + p.runs.reduce((m, r) => m + enc.encode(r.text).length, 0),
    0,
  );
}

type TreeNode = {
  id?: { kind: string; id: string } | null;
  kind: string;
  children?: TreeNode[];
  pluginMetadata?: PluginMetadataEntry[];
};

/**
 * A new slide from `layout`, after `afterPageId` (or last): a copy of a
 * slide made from that layout, keeping only its placeholders, emptied. The
 * copy brings the layout's master and its placeholders with PowerPoint's
 * own formatting, which the engine keeps on an emptied paragraph. Answers
 * the new page's id, or null when the host refused a step.
 */
export async function newSlide(
  host: BundleHost,
  layout: Layout,
  afterPageId: string | null,
): Promise<string | null> {
  const doc = host.document;
  const storiesBefore = new Set(
    (await doc.collection<{ selfId: string }>("stories")).map((s) => s.selfId),
  );
  const pagesBefore = new Set((await doc.collection<{ selfId: string }>("pages")).map((p) => p.selfId));
  const dup = await doc.mutate(duplicateMutation(layout.templatePageId));
  if (!dup.applied) return null;

  const pages = await doc.collection<{ selfId: string }>("pages");
  const index = pages.findIndex((p) => !pagesBefore.has(p.selfId));
  if (index < 0) return null;
  const pageId = pages[index].selfId;

  // The copy's items: the tree lists spreads in page order, one page each.
  const tree = (await doc.tree()) as TreeNode[];
  const items = tree[index]?.children?.[0]?.children ?? [];
  const placeholders = new Set(
    items.filter((n) => n.id && isPlaceholder(n.pluginMetadata)).map((n) => n.id!.id),
  );

  // The copy's stories and the frames they flow in.
  const storyOf = new Map<string, string>();
  for (const s of await doc.collection<{ selfId: string }>("stories")) {
    if (storiesBefore.has(s.selfId)) continue;
    for (const link of await doc.frameChain(s.selfId)) storyOf.set(link.frameId, s.selfId);
  }

  const ops: MutationInput[] = [];
  for (const n of items) {
    if (!n.id) continue;
    if (!placeholders.has(n.id.id)) {
      ops.push({ op: "deleteFrame", args: { frameId: n.id.id } });
      continue;
    }
    const story = storyOf.get(n.id.id);
    if (!story) continue;
    const content = await doc.storyContent(story);
    const end = content ? storyLength(content) : 0;
    if (end > 0) ops.push({ op: "deleteRange", args: { storyId: story, start: 0, end } });
  }
  // A new slide has no notes and is shown; it keeps its layout.
  ops.push(setStateMutation(pageId, { layout: layout.masterId }));
  const order = pages.map((p) => p.selfId);
  const target = afterPageId ? order.filter((p) => p !== pageId).indexOf(afterPageId) + 1 : order.length - 1;
  const move = moveMutation(order, pageId, target);
  if (move) ops.push(move);

  const out = await doc.mutate({ op: "batch", args: { ops } } as MutationInput);
  return out.applied ? pageId : null;
}
