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
