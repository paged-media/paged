/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// What differs between two states of a document (editor ADRs 1234 and
// 1235): a checkpoint and the open document, or two layout variants. Two
// readings, both deterministic, neither asking the engine anything new:
//
//   · the PICTURE: two renders of a page compared cell by cell; the cells
//     that differ, merged into boxes (fractions of the page, so they lay
//     over either render at any size);
//   · the ITEMS, as each state's engine reports them (the open document's,
//     or a second engine holding the other state): page items by id with
//     their boxes (added, removed, moved, resized or reshaped) and how they
//     are painted (restyled); the pictures they place (a link that points
//     elsewhere is a content substitution); each story's text and its
//     formatting (paragraph styles and the runs' type: a typography
//     difference); the paragraph and character style definitions.
//
// The engine is the reader: a `.paged` keeps the open model in its own
// part, so the facts come from the model, not from the package's XML.

import type {
  CanvasClient,
  ElementId,
  LinkSummary,
  SceneTreeNode,
  StorySummary,
  WorkerToMain,
} from "@paged-media/client";

/** A box on a page, as fractions of its width and height. */
export interface FracBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An RGBA image (row-major, 4 bytes a pixel). */
export interface Rgba {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** The cells of `a` and `b` that differ by more than `threshold` in any
 *  channel, `cell` px square, merged into boxes (row runs joined with the
 *  run below them when they overlap). Different sizes: the whole page. */
export function pixelDiff(
  a: Rgba,
  b: Rgba,
  cell = 8,
  threshold = 24,
): FracBox[] {
  if (a.width !== b.width || a.height !== b.height)
    return [{ x: 0, y: 0, w: 1, h: 1 }];
  const { width, height } = a;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) {
      const at = row + Math.floor(x / cell);
      if (hot[at]) continue;
      const i = (y * width + x) * 4;
      if (
        Math.abs(a.data[i]! - b.data[i]!) > threshold ||
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) > threshold ||
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) > threshold ||
        Math.abs(a.data[i + 3]! - b.data[i + 3]!) > threshold
      )
        hot[at] = 1;
    }
  }
  // Runs per row, then grown down while the next row holds an overlapping run.
  type Run = { c0: number; c1: number; r0: number; r1: number };
  const open: Run[] = [];
  const done: Run[] = [];
  for (let r = 0; r < rows; r++) {
    const runs: Array<[number, number]> = [];
    for (let c = 0; c < cols; c++) {
      if (!hot[r * cols + c]) continue;
      const start = c;
      while (c + 1 < cols && hot[r * cols + c + 1]) c++;
      runs.push([start, c]);
    }
    const next: Run[] = [];
    for (const [c0, c1] of runs) {
      const joined = open.filter((o) => o.c0 <= c1 + 1 && c0 <= o.c1 + 1);
      if (joined.length === 0) {
        next.push({ c0, c1, r0: r, r1: r });
        continue;
      }
      const merged: Run = {
        c0: Math.min(c0, ...joined.map((o) => o.c0)),
        c1: Math.max(c1, ...joined.map((o) => o.c1)),
        r0: Math.min(...joined.map((o) => o.r0)),
        r1: r,
      };
      for (const o of joined) open.splice(open.indexOf(o), 1);
      next.push(merged);
    }
    done.push(...open);
    open.length = 0;
    // Runs of this row may now overlap each other through a merge.
    for (const n of next) {
      const twin = open.find((o) => o.c0 <= n.c1 + 1 && n.c0 <= o.c1 + 1);
      if (twin) {
        twin.c0 = Math.min(twin.c0, n.c0);
        twin.c1 = Math.max(twin.c1, n.c1);
        twin.r0 = Math.min(twin.r0, n.r0);
      } else open.push(n);
    }
  }
  done.push(...open);
  return done.map((r) => ({
    x: (r.c0 * cell) / width,
    y: (r.r0 * cell) / height,
    w: Math.min(((r.c1 + 1) * cell) / width, 1) - (r.c0 * cell) / width,
    h: Math.min(((r.r1 + 1) * cell) / height, 1) - (r.r0 * cell) / height,
  }));
}

export type ItemChange =
  "added" | "removed" | "moved" | "reshaped" | "restyled";

/** One page item that differs. */
export interface ItemDiff {
  id: string;
  kind: string;
  change: ItemChange;
}

/** A picture placed somewhere else (or another picture in the same frame). */
export interface Substitution {
  frame: string;
  from: string;
  to: string;
}

/** A story whose text or formatting differs. */
export interface StoryDiff {
  story: string;
  change: "text" | "formatting" | "added" | "removed";
}

export interface DocumentDiff {
  items: ItemDiff[];
  substitutions: Substitution[];
  stories: StoryDiff[];
  /** Style definitions that differ ("paragraph: Heading"). */
  styles: string[];
}

/** What one state of a document is, as its engine reports it. */
export interface StateFacts {
  /** Page items by id: kind, page, box on the page (`[x, y, w, h]`, to the
   *  hundredth of a point) and, when read, how it is painted. */
  items: Map<
    string,
    { kind: string; page: string | null; box: string; look?: string }
  >;
  /** Picture links by the frame that holds them. */
  links: Map<string, string>;
  /** Stories by id: their text and their formatting's signature. */
  stories: Map<string, { text: string; format: string }>;
  /** Style definitions by "family: name". */
  styles: Map<string, string>;
}

/** The paint properties compared as an item's look. */
const LOOK_PATHS = new Set([
  "frameFillColor",
  "frameFillTint",
  "frameStrokeColor",
  "frameStrokeTint",
  "frameStrokeWeight",
  "frameOpacity",
  "appliedObjectStyle",
]);

/** Above this many items the look is not read (one read per item). */
export const LOOK_LIMIT = 400;

const r2 = (n: number) => Math.round(n * 100) / 100;

function pageItems(nodes: readonly SceneTreeNode[], out: ElementId[]): void {
  for (const n of nodes) {
    if (n.id && typeof n.id.id === "string" && n.id.kind !== "storyRange")
      out.push(n.id);
    if (n.children) pageItems(n.children, out);
  }
}

/** Read `client`'s document as facts for a comparison. Reads only. */
export async function readStateFacts(
  client: Pick<
    CanvasClient,
    | "sceneTree"
    | "elementGeometry"
    | "elementProperties"
    | "collection"
    | "send"
  >,
): Promise<StateFacts> {
  const facts: StateFacts = {
    items: new Map(),
    links: new Map(),
    stories: new Map(),
    styles: new Map(),
  };
  const ids: ElementId[] = [];
  pageItems(await client.sceneTree(), ids);
  const geometry = ids.length ? await client.elementGeometry(ids) : [];
  for (const g of geometry) {
    if (g.bounds.length < 4) continue;
    const [top, left, bottom, right] = g.bounds as number[];
    const [a, b, c, d, e, f] = (g.itemTransform ?? [
      1, 0, 0, 1, 0, 0,
    ]) as number[];
    const pts = [
      [left!, top!],
      [right!, top!],
      [right!, bottom!],
      [left!, bottom!],
    ].map(([x, y]) => [a! * x! + c! * y! + e!, b! * x! + d! * y! + f!]);
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    facts.items.set(String(g.id.id), {
      kind: g.id.kind,
      page: g.pageId ?? null,
      box: [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0]
        .map(r2)
        .join(","),
    });
  }
  if (facts.items.size <= LOOK_LIMIT)
    for (const g of geometry) {
      const props = await client.elementProperties(g.id).catch(() => null);
      const item = facts.items.get(String(g.id.id));
      if (!props || !item) continue;
      item.look = JSON.stringify(
        props.entries
          .filter((e) => LOOK_PATHS.has(e.path))
          .map((e) => [e.path, e.value])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
    }
  for (const l of await client.collection<LinkSummary>("links"))
    facts.links.set(l.hostSelfId, l.uri);
  for (const s of await client.collection<StorySummary>("stories")) {
    const reply: WorkerToMain = await client.send({
      kind: "requestStoryContent",
      payload: { storyId: s.selfId },
    });
    if (reply.kind !== "storyContentResult" || !reply.payload.content) continue;
    const paragraphs = reply.payload.content.paragraphs;
    facts.stories.set(s.selfId, {
      text: paragraphs
        .map((p) => p.runs.map((r) => r.text).join(""))
        .join("\n"),
      format: JSON.stringify(
        paragraphs.map((p) => [
          p.paragraphStyle ?? null,
          p.runs.map((r) => {
            const { text: _text, ...type } = r as unknown as Record<
              string,
              unknown
            >;
            return type;
          }),
        ]),
      ),
    });
  }
  for (const [collection, family] of [
    ["paragraphStyles", "paragraph"],
    ["characterStyles", "character"],
  ] as const) {
    const list = await client.collection<{ selfId: string; name: string }>(
      collection,
    );
    for (const style of list) {
      const reply: WorkerToMain = await client.send({
        kind: "requestStyleProperties",
        payload: { collection, styleId: style.selfId } as never,
      });
      if (reply.kind !== "styleProperties" || !reply.payload.result) continue;
      facts.styles.set(
        `${family}: ${style.name}`,
        JSON.stringify([
          reply.payload.result.basedOn ?? null,
          reply.payload.result.entries,
        ]),
      );
    }
  }
  return facts;
}

/** What differs from `before` to `after`. */
export function diffStates(
  before: StateFacts,
  after: StateFacts,
): DocumentDiff {
  const out: DocumentDiff = {
    items: [],
    substitutions: [],
    stories: [],
    styles: [],
  };
  for (const [id, x] of before.items) {
    const y = after.items.get(id);
    if (!y) {
      out.items.push({ id, kind: x.kind, change: "removed" });
      continue;
    }
    const [, , xw, xh] = x.box.split(",");
    const [, , yw, yh] = y.box.split(",");
    const change: ItemChange | null =
      xw !== yw || xh !== yh
        ? "reshaped"
        : x.box !== y.box || x.page !== y.page
          ? "moved"
          : x.look !== undefined && y.look !== undefined && x.look !== y.look
            ? "restyled"
            : null;
    if (change) out.items.push({ id, kind: y.kind, change });
  }
  for (const [id, y] of after.items)
    if (!before.items.has(id))
      out.items.push({ id, kind: y.kind, change: "added" });
  for (const [frame, from] of before.links) {
    const to = after.links.get(frame);
    if (to !== undefined && to !== from)
      out.substitutions.push({ frame, from, to });
  }
  for (const [story, x] of before.stories) {
    const y = after.stories.get(story);
    if (!y) out.stories.push({ story, change: "removed" });
    else if (x.text !== y.text) out.stories.push({ story, change: "text" });
    else if (x.format !== y.format)
      out.stories.push({ story, change: "formatting" });
  }
  for (const story of after.stories.keys())
    if (!before.stories.has(story))
      out.stories.push({ story, change: "added" });
  for (const name of new Set([...before.styles.keys(), ...after.styles.keys()]))
    if (before.styles.get(name) !== after.styles.get(name))
      out.styles.push(name);
  const byId = (p: { id?: string; story?: string; frame?: string }) =>
    p.id ?? p.story ?? p.frame ?? "";
  out.items.sort((p, q) => byId(p).localeCompare(byId(q)));
  out.stories.sort((p, q) => p.story.localeCompare(q.story));
  out.substitutions.sort((p, q) => p.frame.localeCompare(q.frame));
  out.styles.sort();
  return out;
}

/** Nothing differs. */
export function isEmptyDiff(d: DocumentDiff): boolean {
  return (
    d.items.length === 0 &&
    d.substitutions.length === 0 &&
    d.stories.length === 0 &&
    d.styles.length === 0
  );
}
