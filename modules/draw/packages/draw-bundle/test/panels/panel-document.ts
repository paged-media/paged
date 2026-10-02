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

// The document every panel spec measures against, and the two bursts.
//
// DOM-free on purpose: the two binding-driver specs run in the plain Node
// environment and import this file only; the React-panel specs reach it
// through `./harness`, which re-exports everything here.
//
// THE SHAPE, stated once because every budget in this folder is a
// function of it: R = 5 records among L = 40 PLAIN leaves. A plain leaf
// carries no record of any kind — it is the part of the document a panel
// has no business reading, which is exactly why it is in the fixture. A
// panel that reads it once per reload shows up as "+40"; one that reads
// it once per RECORD per reload shows up as "+200".

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import type { WorkLog } from "../perf/counting-host";

/** The page every panel fixture lives on (`packageWithSpread`). */
export const PAGE_ID = "usp";

/** L — the plain leaves every budget document carries. */
export const PLAIN_LEAVES = 40;

/** R — the records every budget document carries. */
export const RECORDS = 5;

/** The size of both bursts. */
export const BURST = 20;

/** A closed square polygon, `size` pt on a side, top-left at (x, y). */
export function squareItem(id: string, x: number, y: number, size = 20): string {
  return pathItem(
    "Polygon",
    id,
    // GeometricBounds is "top left bottom right".
    `${y} ${x} ${y + size} ${x + size}`,
    false,
    [
      { a: [x, y] },
      { a: [x + size, y] },
      { a: [x + size, y + size] },
      { a: [x, y + size] },
    ],
  );
}

/** An OPEN two-anchor polygon from (x1, y1) to (x2, y2) — a spine. */
export function lineItem(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  return pathItem(
    "Polygon",
    id,
    `${Math.min(y1, y2)} ${Math.min(x1, x2)} ${Math.max(y1, y2)} ${Math.max(x1, x2)}`,
    true,
    [{ a: [x1, y1] }, { a: [x2, y2] }],
  );
}

/** A `<Rectangle>` — the element kind the appearance bake writes real
 *  paint onto — authored inline the way `F1_MULTI_SHAPE` authors its
 *  metadata carrier. */
export function rectItem(id: string, x: number, y: number, size = 40): string {
  const pt = (px: number, py: number) =>
    `<PathPointType Anchor="${px} ${py}" LeftDirection="${px} ${py}" RightDirection="${px} ${py}"/>`;
  return (
    `<Rectangle Self="${id}" GeometricBounds="${y} ${x} ${y + size} ${x + size}" ` +
    `ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    pt(x, y) +
    pt(x, y + size) +
    pt(x + size, y + size) +
    pt(x + size, y) +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>`
  );
}

/** A polygon element id. */
export const poly = (id: string): ElementId =>
  ({ kind: "polygon", id }) as ElementId;

/** The id of plain leaf `i` (0 … PLAIN_LEAVES − 1). */
export const plainId = (i: number): ElementId => poly(`p${i}`);

/**
 * The budget document: `seeds` (whatever artwork a spec builds its
 * records from, in the page's upper half) plus the 40 plain leaves `p0`
 * … `p39`, an 8 × 5 grid of 20 pt squares in the lower half. Everything
 * sits well inside the 612 × 792 page, because the geometry doors answer
 * nothing for an element off it (RFI C-23).
 */
export function panelDocument(seeds: string): Uint8Array {
  let plain = "";
  for (let i = 0; i < PLAIN_LEAVES; i++) {
    plain += squareItem(`p${i}`, 40 + (i % 8) * 60, 520 + Math.floor(i / 8) * 50);
  }
  return packageWithSpread(seeds + plain);
}

/** The EMPTY document: one page and no page item at all — what a panel
 *  is mounted against before anything has been drawn. */
export function emptyDocument(): Uint8Array {
  return packageWithSpread("");
}

/** `count` seed squares `<prefix>0` … along one row: 110 pt apart, so a
 *  20 pt square has room for a copy, an intermediate or a partner. */
export function seedRow(
  prefix: string,
  count: number,
  opts: { x?: number; y?: number; size?: number } = {},
): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += squareItem(
      `${prefix}${i}`,
      (opts.x ?? 40) + i * 110,
      opts.y ?? 40,
      opts.size ?? 20,
    );
  }
  return out;
}

/** Every leaf id in the document, in tree order. */
export async function leafIds(h: HeadlessHost): Promise<ElementId[]> {
  type Node = { id?: ElementId | null; children?: unknown };
  const out: ElementId[] = [];
  const walk = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as readonly Node[];
      if (children.length > 0) walk(children);
      else if (node.id) out.push(node.id);
    }
  };
  walk(await h.host.document.tree());
  return out;
}

/** One element property, as the engine reports it (undefined = absent). */
export async function propertyOf(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const entry of props?.entries ?? []) {
    if (entry.path === path) return entry.value;
  }
  return undefined;
}

/** One document change that touches NO record and adds NO leaf: a stroke
 *  weight on plain leaf `p0`. `n` varies the value so consecutive writes
 *  are each a real change. */
export async function plainChange(h: HeadlessHost, n: number): Promise<void> {
  const out = await h.host.document.mutate({
    op: "setElementProperty",
    args: {
      elementId: plainId(0),
      path: "frameStrokeWeight",
      value: { type: "length", value: 1 + (n % 7) },
    },
  });
  if (!out.applied) {
    throw new Error(`plain change refused: ${JSON.stringify(out.error)}`);
  }
}

/** BURST document changes, back to back — no macrotask between them, so
 *  every piece of work one starts is still in flight when the next
 *  lands. */
export async function documentChanges(h: HeadlessHost): Promise<void> {
  for (let i = 0; i < BURST; i++) await plainChange(h, i);
}

/** BURST selection changes, back to back, each to a DIFFERENT plain leaf
 *  (`p1` … `p20`), so every one is a real change and none selects a
 *  record. */
export async function selectionChanges(h: HeadlessHost): Promise<void> {
  for (let i = 0; i < BURST; i++) await h.host.selection.set([plainId(i + 1)]);
}

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const callsIn = (work: WorkLog | undefined): number =>
  work ? Object.values(work.calls).reduce((n, v) => n + v, 0) : 0;

/**
 * Wait for fire-and-forget work to land. The headless engine answers
 * synchronously, so a reload is a chain of MICROTASKS and one macrotask
 * turn drains every one in flight; this does not trust that. It waits
 * until the counted work has held still for two consecutive turns (three
 * turns at the least).
 */
export async function quiesce(work?: WorkLog): Promise<void> {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 400 && still < 2; i++) {
    await turn();
    const now = callsIn(work);
    still = now === last ? still + 1 : 0;
    last = now;
  }
}
