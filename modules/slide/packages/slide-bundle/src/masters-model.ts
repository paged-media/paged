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

// Slide masters and layouts (slide ADR 712). The importer writes one master
// spread per slide master and one per layout, based on its master (engine
// ADR 1026). A layout's placeholders are items of its spread; a slide holds
// its own copies of them (engine overrides) and hides every placeholder of
// its layout. This file reads that structure and builds the mutations of
// the Slide Master view and of the slide verbs that use it (New Slide from
// a layout, Change Layout, Reset Slide). Pure functions plus reads through
// the host's document doors, so a test drives it with a fake host.

import type { BundleHost, MutationInput } from "@paged-media/plugin-api";

import { storiesOf } from "./format-painter.js";
import {
  SLIDE_CALLER,
  SLIDE_KEY,
  parseState,
  setStateMutation,
  type PluginMetadataEntry,
  type SlideState,
} from "./slides-model.js";

/** A placeholder type as PowerPoint spells it (`canonical` in Rust: `obj`
 *  and an absent type are `body`, `ctrTitle` is `title`). */
export type PlaceholderType = string;

/** The placeholder types Insert Placeholder offers, PowerPoint's order. */
export const PLACEHOLDER_TYPES = [
  "body",
  "title",
  "pic",
  "chart",
  "tbl",
  "media",
  "dt",
  "ftr",
  "sldNum",
] as const;

/** The placeholders a new slide leaves out (Header & Footer turns them on). */
const FOOTER_TYPES = new Set(["dt", "ftr", "sldNum"]);

export interface ElementRef {
  kind: string;
  id: string;
}

/** One placeholder of a master or a layout: every element it is drawn as
 *  (an outline and a text frame), with its PowerPoint identity. */
export interface Placeholder {
  type: PlaceholderType;
  idx: number | null;
  name: string;
  /** The shape key (`<part>#<id>`); empty for one made in the editor. */
  shape: string;
  elements: ElementRef[];
}

export interface MasterSpread {
  /** The master spread's `Self`. */
  masterId: string;
  /** Its page's `Self`. */
  pageId: string;
  name: string;
  kind: "master" | "layout";
  /** The part it came from; absent for one made in the editor. */
  part?: string;
  /** A layout's `type` (`title`, `obj`, …). */
  type?: string;
  preserve: boolean;
  /** The master spread it is based on (a layout's slide master). */
  basedOn: string | null;
  overrides: string[];
  sizePt: [number, number];
  placeholders: Placeholder[];
  /** Slides made from it. */
  slides: number;
}

type TreeRow = {
  id?: ElementRef | null;
  kind: string;
  label?: string;
  children?: TreeRow[];
  pluginMetadata?: PluginMetadataEntry[] | null;
};

type MasterSummary = {
  selfId: string;
  label: string;
  pages?: {
    selfId: string;
    sizePt?: [number, number];
    appliedMaster?: string | null;
    overrideList?: string[];
    pluginMetadata?: PluginMetadataEntry[];
  }[];
  items?: TreeRow[];
};

type PageSummary = {
  selfId: string;
  appliedMaster?: string | null;
  overrideList?: string[];
  pluginMetadata?: PluginMetadataEntry[];
};

/** A master reference as a bare `Self` (`MasterSpread/m1` → `m1`). */
export function bare(ref: string | null | undefined): string | null {
  if (!ref || ref === "n") return null;
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

function data(
  meta: readonly PluginMetadataEntry[] | null | undefined,
): Record<string, unknown> | null {
  const entry = meta?.find((m) => m.key === SLIDE_KEY);
  if (!entry) return null;
  try {
    const env = JSON.parse(entry.value) as { data?: unknown };
    return typeof env.data === "object" && env.data !== null
      ? (env.data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A placeholder label's identity, or null when the item is not one. */
export function placeholderOf(
  meta: readonly PluginMetadataEntry[] | null | undefined,
): { type: string; idx: number | null; shape: string } | null {
  const d = data(meta);
  const ph = d?.placeholder as { type?: unknown; idx?: unknown } | undefined;
  if (!ph || typeof ph !== "object" || typeof ph.type !== "string") return null;
  return {
    type: ph.type,
    idx: typeof ph.idx === "number" ? ph.idx : null,
    shape: typeof d?.shape === "string" ? d.shape : "",
  };
}

/** The placeholders among scene-tree rows, grouped by shape. */
export function placeholdersOf(rows: readonly TreeRow[]): Placeholder[] {
  const out: Placeholder[] = [];
  for (const r of rows) {
    if (!r.id) continue;
    const ph = placeholderOf(r.pluginMetadata);
    if (!ph) continue;
    const same = out.find((p) =>
      ph.shape !== ""
        ? p.shape === ph.shape
        : p.shape === "" && p.type === ph.type && p.idx === ph.idx,
    );
    if (same) {
      same.elements.push(r.id);
      continue;
    }
    out.push({
      type: ph.type,
      idx: ph.idx,
      name: r.label ?? ph.type,
      shape: ph.shape,
      elements: [r.id],
    });
  }
  return out;
}

/** Whether placeholder `a` (a slide's) fills layout placeholder `b`:
 *  PowerPoint's rule, by index, else by type. */
export function fills(
  a: { type: string; idx: number | null },
  b: { type: string; idx: number | null },
): boolean {
  if (a.idx !== null && b.idx !== null) return a.idx === b.idx;
  return a.type === b.type;
}

/** The deck's masters and layouts, slide masters first in deck order, each
 *  followed by its layouts. */
export async function readMasters(host: BundleHost): Promise<MasterSpread[]> {
  let masters: readonly MasterSummary[] = [];
  let pages: readonly PageSummary[] = [];
  try {
    masters = await host.document.collection<MasterSummary>("masterPages");
    pages = await host.document.collection<PageSummary>("pages");
  } catch {
    return [];
  }
  const uses = new Map<string, number>();
  for (const p of pages) {
    const m = bare(p.appliedMaster) ?? parseState(p.pluginMetadata).layout;
    if (m) uses.set(m, (uses.get(m) ?? 0) + 1);
  }
  const rows: MasterSpread[] = [];
  for (const m of masters) {
    const page = m.pages?.[0];
    if (!page) continue;
    const d = (data(page.pluginMetadata)?.master ?? {}) as {
      kind?: unknown;
      part?: unknown;
      type?: unknown;
      preserve?: unknown;
    };
    const basedOn = bare(page.appliedMaster);
    rows.push({
      masterId: m.selfId,
      pageId: page.selfId,
      name: m.label,
      kind:
        d.kind === "master" || (d.kind === undefined && basedOn === null)
          ? "master"
          : "layout",
      ...(typeof d.part === "string" ? { part: d.part } : {}),
      ...(typeof d.type === "string" ? { type: d.type } : {}),
      preserve: d.preserve === true,
      basedOn,
      overrides: page.overrideList ?? [],
      sizePt: page.sizePt ?? [960, 540],
      placeholders: placeholdersOf(m.items ?? []),
      slides: uses.get(m.selfId) ?? 0,
    });
  }
  // Deck order: the importer's ids number masters `M1…` and layouts
  // `m1…`; anything made in the editor sorts after its master's.
  const num = (id: string) => Number(/\d+/.exec(id)?.[0] ?? 1e9);
  const tops = rows
    .filter((r) => r.kind === "master")
    .sort((a, b) => num(a.masterId) - num(b.masterId));
  const out: MasterSpread[] = [];
  for (const t of tops) {
    out.push(t);
    out.push(
      ...rows
        .filter((r) => r.kind === "layout" && r.basedOn === t.masterId)
        .sort((a, b) => num(a.masterId) - num(b.masterId)),
    );
  }
  for (const r of rows) if (!out.includes(r)) out.push(r);
  return out;
}

/** A layout's `{ kind, part, type, preserve }` label as an envelope. */
export function masterLabel(m: MasterSpread): string {
  const master: Record<string, unknown> = { kind: m.kind };
  if (m.part) master.part = m.part;
  if (m.type) master.type = m.type;
  if (m.preserve) master.preserve = true;
  return JSON.stringify({ v: 1, data: { master } });
}

/** Rename a master or a layout (one undo step). */
export function renameMutation(masterId: string, name: string): MutationInput {
  return {
    op: "renameMaster",
    args: { master: masterId, name: name.trim() === "" ? null : name.trim() },
  } as MutationInput;
}

/** Set or clear a master's or layout's Preserve flag (one undo step). */
export function preserveMutation(
  m: MasterSpread,
  preserve: boolean,
): MutationInput {
  return {
    op: "onMaster",
    args: {
      master: m.masterId,
      mutation: {
        op: "setPageMetadata",
        args: {
          page: m.pageId,
          key: SLIDE_KEY,
          value: masterLabel({ ...m, preserve }),
          caller: SLIDE_CALLER,
        },
      },
    },
  } as MutationInput;
}

/** Delete a layout no slide uses, or say why not. */
export function deleteLayoutMutation(
  m: MasterSpread,
  all: readonly MasterSpread[],
): MutationInput | string {
  if (m.slides > 0)
    return `${m.name} is used by ${m.slides} slide${m.slides === 1 ? "" : "s"}`;
  if (m.kind === "master" && all.some((x) => x.basedOn === m.masterId))
    return `${m.name} still has layouts`;
  return { op: "deleteMaster", args: { master: m.masterId } } as MutationInput;
}

/** PowerPoint's default box for a new placeholder of `type` on a page of
 *  `size` (pt): a title across the top, a footer row, the rest centred. */
export function placeholderBox(
  type: string,
  size: [number, number],
): [number, number, number, number] {
  const [w, h] = size;
  switch (type) {
    case "title":
      return [w * 0.07, h * 0.06, w * 0.86, h * 0.18];
    case "dt":
      return [w * 0.07, h * 0.9, w * 0.22, h * 0.06];
    case "ftr":
      return [w * 0.34, h * 0.9, w * 0.32, h * 0.06];
    case "sldNum":
      return [w * 0.71, h * 0.9, w * 0.22, h * 0.06];
    default:
      return [w * 0.07, h * 0.27, w * 0.86, h * 0.58];
  }
}

/** The prompt PowerPoint writes into a new placeholder on a layout. */
export function promptText(type: string): string {
  switch (type) {
    case "title":
      return "Click to edit Master title style";
    case "pic":
      return "Picture";
    case "chart":
      return "Chart";
    case "tbl":
      return "Table";
    case "media":
      return "Media";
    case "dt":
      return "Date";
    case "ftr":
      return "Footer";
    case "sldNum":
      return "#";
    default:
      return "Click to edit Master text styles";
  }
}

/** The lowest placeholder index the layout does not use yet (PowerPoint
 *  numbers new body-like placeholders from 1; a title has none). */
export function nextIdx(m: MasterSpread, type: string): number | null {
  if (type === "title") return null;
  const used = new Set(m.placeholders.map((p) => p.idx ?? 0));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Insert Placeholder on a layout: a text frame where `box` says (default:
 *  where PowerPoint puts one of `type`), its prompt, and its placeholder
 *  label. One undo step. */
export function insertPlaceholderMutation(
  m: MasterSpread,
  type: string,
  box?: [number, number, number, number],
): MutationInput {
  const [x, y, w, h] = box ?? placeholderBox(type, m.sizePt);
  const idx = nextIdx(m, type);
  const label = JSON.stringify({
    v: 1,
    data: { placeholder: { type, idx } },
  });
  const onMaster = (mutation: unknown) => ({
    op: "onMaster",
    args: { master: m.masterId, mutation },
  });
  return {
    op: "batch",
    args: {
      ops: [
        onMaster({
          op: "insertTextFrame",
          args: { pageId: m.pageId, bounds: [y, x, y + h, x + w] },
        }),
        { op: "bindCreated", args: { handle: "ph" } },
        // A master frame's story is a story like any other: no wrapper.
        {
          op: "insertText",
          args: { storyId: "$h:ph", offset: 0, text: promptText(type) },
        },
        onMaster({
          op: "setPluginMetadata",
          args: {
            elementId: { kind: "textFrame", id: "$h:ph" },
            key: SLIDE_KEY,
            value: label,
            caller: SLIDE_CALLER,
          },
        }),
      ],
    },
  } as MutationInput;
}

/** Delete a layout placeholder (every element it is drawn as). */
export function deletePlaceholderMutation(
  m: MasterSpread,
  ph: Placeholder,
): MutationInput {
  return {
    op: "onMaster",
    args: {
      master: m.masterId,
      mutation: {
        op: "batch",
        args: {
          ops: ph.elements.map((e) => ({
            op: "deleteFrame",
            args: { frameId: e.id },
          })),
        },
      },
    },
  } as MutationInput;
}

/** Every element of every placeholder of `layout`: what a slide made from
 *  it hides. */
export function placeholderElements(layout: MasterSpread): string[] {
  return layout.placeholders.flatMap((p) => p.elements.map((e) => e.id));
}

/**
 * New Slide from `layout` (any layout of any master, used or not), after
 * `afterPageId` (or at the end): a page on the layout with copies of its
 * placeholders, emptied (the layout's prompt is not the slide's text; the
 * copies keep its formatting), the footer placeholders left out as
 * PowerPoint leaves them, and the slide's own label. One undo step; the
 * page's id comes back as `createdPages[0]`.
 */
export function newSlideMutation(
  layout: MasterSpread,
  afterPageId: string | null,
): MutationInput {
  const copied = layout.placeholders
    .filter((p) => !FOOTER_TYPES.has(p.type))
    .flatMap((p) => p.elements.map((e) => e.id));
  const ops: unknown[] = [
    {
      op: "insertPage",
      args: { afterPageId, masterId: layout.masterId },
    },
    { op: "bindCreated", args: { handle: "slide" } },
  ];
  if (copied.length > 0)
    ops.push({
      op: "overrideMasterItems",
      args: { page: "$h:slide", items: copied, emptyText: true },
    });
  ops.push(
    {
      op: "setPageOverrides",
      args: { page: "$h:slide", overrides: placeholderElements(layout) },
    },
    {
      ...setStateMutation("$h:slide", { layout: layout.masterId }),
    },
  );
  return { op: "batch", args: { ops } } as MutationInput;
}

/** A slide's own placeholders: scene-tree rows of its page. */
export async function slidePlaceholders(
  host: BundleHost,
  pageId: string,
): Promise<Placeholder[]> {
  const pages = await host.document.collection<{ selfId: string }>("pages");
  const index = pages.findIndex((p) => p.selfId === pageId);
  if (index < 0) return [];
  const tree = (await host.document.tree()) as TreeRow[];
  return placeholdersOf(tree[index]?.children?.[0]?.children ?? []);
}

type Geometry = {
  id: ElementRef;
  itemTransform?: number[] | null;
  bounds?: number[];
};

/** Mutations that put each element of `slide` where the element of the
 *  same kind of `layout` sits. */
async function placeLike(
  host: BundleHost,
  slide: Placeholder,
  layout: Placeholder,
): Promise<MutationInput[]> {
  const geometry = (await host.document.elementGeometry([
    ...slide.elements,
    ...layout.elements,
  ] as never)) as Geometry[];
  const of = (e: ElementRef) => geometry.find((g) => g.id.id === e.id);
  const ops: MutationInput[] = [];
  for (const e of slide.elements) {
    const twin = layout.elements.find((l) => l.kind === e.kind);
    const g = twin ? of(twin) : undefined;
    if (!g || !g.bounds) continue;
    ops.push({
      op: "moveFrame",
      args: {
        frameId: e.id,
        transform: g.itemTransform ?? [1, 0, 0, 1, 0, 0],
      },
    } as MutationInput);
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: e,
        path: "frameBounds",
        value: { type: "bounds", value: g.bounds },
      },
    } as MutationInput);
  }
  return ops;
}

/**
 * Change Layout: the slide takes `layout`. Each of its placeholders that
 * fills one of the new layout's moves to where that one sits; the new
 * layout's placeholders the slide has no copy of are added, empty (not the
 * footers); the slide hides the new layout's placeholders and records it.
 * Content placed outside placeholders stays. One undo step.
 */
export async function changeLayoutMutation(
  host: BundleHost,
  pageId: string,
  state: SlideState,
  layout: MasterSpread,
): Promise<MutationInput> {
  const own = await slidePlaceholders(host, pageId);
  const ops: MutationInput[] = [
    {
      op: "applyMasterToPage",
      args: { page: pageId, master: layout.masterId },
    } as MutationInput,
  ];
  const missing: string[] = [];
  for (const lp of layout.placeholders) {
    const mine = own.find((p) => fills(p, lp));
    if (mine) ops.push(...(await placeLike(host, mine, lp)));
    else if (!FOOTER_TYPES.has(lp.type))
      missing.push(...lp.elements.map((e) => e.id));
  }
  if (missing.length > 0)
    ops.push({
      op: "overrideMasterItems",
      args: { page: pageId, items: missing, emptyText: true },
    } as MutationInput);
  ops.push(
    {
      op: "setPageOverrides",
      args: { page: pageId, overrides: placeholderElements(layout) },
    } as MutationInput,
    setStateMutation(pageId, { ...state, layout: layout.masterId }),
  );
  return { op: "batch", args: { ops } } as MutationInput;
}

/**
 * Reset Slide: every placeholder of the slide goes back to where its
 * layout's sits (PowerPoint's Reset keeps the text). One undo step; null
 * when nothing would change.
 */
export async function resetSlideMutation(
  host: BundleHost,
  pageId: string,
  layout: MasterSpread,
): Promise<MutationInput | null> {
  const own = await slidePlaceholders(host, pageId);
  const ops: MutationInput[] = [];
  for (const p of own) {
    const lp = layout.placeholders.find((l) => fills(p, l));
    if (lp) ops.push(...(await placeLike(host, p, lp)));
  }
  return ops.length > 0
    ? ({ op: "batch", args: { ops } } as MutationInput)
    : null;
}

const storyRange = (story: string, start: number, end: number) => ({
  kind: "storyRange",
  id: { story_id: story, start, end },
});

/** The story a placeholder's text frame flows, and its length. */
async function placeholderStory(
  host: BundleHost,
  ph: Placeholder,
): Promise<{ story: string; length: number } | null> {
  const frame = ph.elements.find((e) => e.kind === "textFrame");
  if (!frame) return null;
  const stories = await storiesOf(host, [frame as never]);
  return stories.get(frame.id) ?? null;
}

/** A text style a layout placeholder gives its text. */
export interface PlaceholderStyle {
  /** Points. */
  size?: number;
  /** The font style name (`Regular`, `Bold`, `Italic`, `Bold Italic`). */
  fontStyle?: string;
}

type Entry = { path: string; value: { type: string; value: unknown } | null };

async function firstCharEntries(
  host: BundleHost,
  story: string,
): Promise<Map<string, unknown>> {
  const p = await host.document.elementProperties(
    storyRange(story, 0, 1) as never,
  );
  const out = new Map<string, unknown>();
  for (const e of (p?.entries ?? []) as Entry[])
    if (e.value) out.set(e.path, e.value.value);
  return out;
}

/**
 * Set a layout placeholder's text style, and let the slides follow it
 * (PowerPoint's inheritance): the layout's text takes the style, and so
 * does the text of every slide placeholder made from it that still has the
 * layout's old value (one that set its own keeps it). One undo step; null
 * when the placeholder has no text.
 */
export async function placeholderStyleMutation(
  host: BundleHost,
  layout: MasterSpread,
  ph: Placeholder,
  style: PlaceholderStyle,
): Promise<MutationInput | null> {
  const own = await placeholderStory(host, ph);
  if (!own || own.length === 0) return null;
  const was = await firstCharEntries(host, own.story);
  const writes: [string, { type: string; value: unknown }][] = [];
  if (style.size !== undefined)
    writes.push(["characterFontSize", { type: "length", value: style.size }]);
  if (style.fontStyle !== undefined)
    writes.push([
      "characterFontStyle",
      { type: "text", value: style.fontStyle },
    ]);
  const ops: MutationInput[] = [];
  const set = (story: string, length: number) => {
    for (const [path, value] of writes)
      ops.push({
        op: "setElementProperty",
        args: { elementId: storyRange(story, 0, length), path, value },
      } as MutationInput);
  };
  set(own.story, own.length);
  // The slides made from the layout.
  const pages = await host.document.collection<PageSummary>("pages");
  for (const page of pages) {
    if (bare(page.appliedMaster) !== layout.masterId) continue;
    for (const sp of await slidePlaceholders(host, page.selfId)) {
      if (!fills(sp, ph)) continue;
      const st = await placeholderStory(host, sp);
      if (!st || st.length === 0) continue;
      const now = await firstCharEntries(host, st.story);
      const inherited = writes.every(
        ([path]) =>
          JSON.stringify(now.get(path)) === JSON.stringify(was.get(path)),
      );
      if (inherited) set(st.story, st.length);
    }
  }
  return { op: "batch", args: { ops } } as MutationInput;
}
