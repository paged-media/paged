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

import type { Timing } from "./anim/model.js";
import { newSlideMutation, readMasters } from "./masters-model.js";

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
  /** Advance on a click (PowerPoint's default) and/or after this long
   *  (the Transition panel edits both; Rehearse Timings records the
   *  latter). Absent: as the deck's element says. */
  advanceOnClick?: boolean;
  advanceAfterMs?: number | null;
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
  /** The slide's animations (slide ADR 714): the engine's timing model,
   *  with each shape named by its page item and shape key. */
  timing?: Timing;
  /** A section starts at this slide (slide ADR 720): its id and name. The
   *  slides after it belong to it until the next start. */
  section?: SectionStart;
}

/** A section's start, as its first slide's label holds it. */
export interface SectionStart {
  /** PowerPoint's `{GUID}`. */
  id: string;
  name: string;
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
export function parseState(
  meta: readonly PluginMetadataEntry[] | undefined,
): SlideState {
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
    if (
      typeof d.timing === "object" &&
      d.timing !== null &&
      Array.isArray((d.timing as { nodes?: unknown }).nodes)
    ) {
      out.timing = d.timing as Timing;
    }
    const sec = d.section as { id?: unknown; name?: unknown } | undefined;
    if (
      typeof sec === "object" &&
      sec !== null &&
      typeof sec.id === "string" &&
      typeof sec.name === "string"
    ) {
      out.section = { id: sec.id, name: sec.name };
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
  if (state.timing) data.timing = state.timing;
  if (state.section) data.section = state.section;
  return Object.keys(data).length === 0 ? null : JSON.stringify({ v: 1, data });
}

/** Write a slide's whole state (one undoable step). */
export function setStateMutation(
  pageId: string,
  state: SlideState,
): MutationInput {
  return {
    op: "setPageMetadata",
    args: {
      page: pageId,
      key: SLIDE_KEY,
      value: encodeState(state),
      caller: SLIDE_CALLER,
    },
  };
}

/** Move `pageId` so it lands at position `to` (0-based) of `order`. */
export function moveMutation(
  order: readonly string[],
  pageId: string,
  to: number,
): MutationInput | null {
  const from = order.indexOf(pageId);
  if (from < 0) return null;
  const rest = order.filter((p) => p !== pageId);
  const at = Math.max(0, Math.min(to, rest.length));
  if (at === from) return null;
  return {
    op: "movePage",
    args: { page: pageId, after: at === 0 ? null : rest[at - 1] },
  };
}

export function duplicateMutation(pageId: string): MutationInput {
  return { op: "duplicatePage", args: { page: pageId } };
}

/** Delete a slide. Given the deck's slides, a section the slide starts is
 *  handed to the slide after it (when that one starts none), so deleting
 *  a section's first slide keeps the section, as in PowerPoint. */
export function deleteMutation(
  pageId: string,
  slides?: readonly Slide[],
): MutationInput {
  const del: MutationInput = { op: "deletePage", args: { pageId } };
  const i = slides?.findIndex((s) => s.pageId === pageId) ?? -1;
  const here = i >= 0 ? slides![i] : undefined;
  const next = i >= 0 ? slides![i + 1] : undefined;
  if (!here?.state.section || !next || next.state.section) return del;
  return {
    op: "batch",
    args: {
      ops: [
        setStateMutation(next.pageId, {
          ...next.state,
          section: here.state.section,
        }),
        del,
      ],
    },
  } as MutationInput;
}

type PageSummary = {
  selfId: string;
  sizePt: [number, number];
  pluginMetadata?: PluginMetadataEntry[];
};

/** The deck's slides as the document holds them now (null when no page
 *  carries a slide label: not a deck). */
export async function readSlides(host: BundleHost): Promise<Slide[] | null> {
  const pages = await host.document.collection<PageSummary>("pages");
  if (!pages.some((p) => p.pluginMetadata?.some((m) => m.key === SLIDE_KEY)))
    return null;
  return pages.map((p, i) => ({
    pageId: p.selfId,
    number: i + 1,
    sizePt: p.sizePt,
    state: parseState(p.pluginMetadata),
  }));
}

/** Thumbnail width in device pixels. */
export const THUMB_WIDTH = 320;

/**
 * The slides of the open document, kept current: re-read on every document
 * change, thumbnails rendered on demand and dropped when the page they show
 * is reported changed.
 */
export class SlidesStore {
  private slides: Slide[] = [];
  private deck = false;
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

  /** Whether the open document is a deck: some page carries the slide
   *  state the importer writes. False until the first read lands. */
  isDeck(): boolean {
    return this.deck;
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
    this.deck = pages.some((p) =>
      p.pluginMetadata?.some((m) => m.key === SLIDE_KEY),
    );
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
  return URL.createObjectURL(
    new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
  );
}

function defaultRevoke(url: string): void {
  URL.revokeObjectURL(url);
}

/** A layout a new slide can be made from (slide ADR 712: any layout of
 *  any master, used or not). */
export interface Layout {
  masterId: string;
  name: string;
}

/** The layouts new slides can be made from, in deck order: every layout
 *  of every slide master. */
export async function layouts(
  host: BundleHost,
  _slides?: readonly Slide[],
): Promise<Layout[]> {
  return (await readMasters(host))
    .filter((m) => m.kind === "layout")
    .map((m) => ({ masterId: m.masterId, name: m.name }));
}

/**
 * A new slide from `layout`, after `afterPageId` (or last): a page on the
 * layout with copies of its placeholders, emptied, which keep the layout's
 * formatting (masters-model.ts, engine ADR 1026). ONE undo step. Answers
 * the new page's id, or null when the host refused.
 */
export async function newSlide(
  host: BundleHost,
  layout: Layout,
  afterPageId: string | null,
): Promise<string | null> {
  const m = (await readMasters(host)).find(
    (x) => x.masterId === layout.masterId,
  );
  if (!m) return null;
  const out = await host.document.mutate(newSlideMutation(m, afterPageId));
  if (!out.applied) {
    host.log.warn(
      `paged.slide new slide: refused (${JSON.stringify(out.error)})`,
    );
    return null;
  }
  return out.createdPages?.[0] ?? null;
}
