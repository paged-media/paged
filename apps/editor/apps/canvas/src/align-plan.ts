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

// ADR 323 — Align / Distribute as TYPED COMMANDS over `host.objects`.
//
// Align is not a property: it is a verb over a set of objects. The Align
// panel invokes `paged.align.objects` with declared args
// `{ kind, targets, to?, key?, spacing? }`; the command reads every
// target's geometry, plans the moves here (pure, so the unit tests pin
// them), and commits them as ONE `host.objects.batch` = one undo step. A
// script, the CLI's editor bridge or a data binding invokes the same
// command with the same args.
//
// WP4.4 — the plan runs in SPREAD space on each object's TRANSFORMED box
// (a rotated frame aligns by the box it shows, not by its unrotated
// frame), and every move is a translation written through the
// `frameTransform` door (transform-targets.ts), so it is right for any
// transform. What it aligns AGAINST (`to`):
//
//   selection   the union of the selection's boxes (the default);
//   keyObject   the key object's box; the key never moves (`key`, an
//               address; the first target when absent);
//   page        each object's own page (a pasteboard object: its
//               spread's first page);
//   margins     that page inset by its margins;
//   spread      the union of the object's spread's pages.
//
// The kinds: six alignments; DISTRIBUTE OBJECTS by an edge or centre
// (`distributeLeft`, `distributeH` — horizontal centres —,
// `distributeRight`, `distributeTop`, `distributeV`, `distributeBottom`),
// which spaces that edge evenly; and DISTRIBUTE SPACING (`spaceH`,
// `spaceV`), which makes the gaps between objects equal. A `spacing`
// (pt) fixes the step (distribute objects) or the gap (distribute
// spacing) instead of deriving it — InDesign's "Use spacing".
//
// Pure: no editor state; the unit tests run it as-is.

import type { ShellObjectOp, ShellValueType } from "@paged-media/shell";

import {
  transformOpFor,
  translate,
  type Bounds,
  type SpreadTarget,
} from "./transform-targets";

export type { Bounds } from "./transform-targets";

export const ALIGN_KINDS = [
  "left",
  "centerH",
  "right",
  "top",
  "centerV",
  "bottom",
  "distributeLeft",
  "distributeH",
  "distributeRight",
  "distributeTop",
  "distributeV",
  "distributeBottom",
  "spaceH",
  "spaceV",
] as const;
export type AlignKind = (typeof ALIGN_KINDS)[number];

export const ALIGN_SCOPES = [
  "selection",
  "keyObject",
  "margins",
  "page",
  "spread",
] as const;
export type AlignScope = (typeof ALIGN_SCOPES)[number];

export const ALIGN_COMMAND = "paged.align.objects";

/** The declared args: which alignment, over which object addresses,
 *  against what, and an optional fixed spacing. */
export const ALIGN_ARGS: ShellValueType = {
  kind: "struct",
  fields: {
    kind: { kind: "enum", members: ALIGN_KINDS },
    targets: { kind: "list", of: { kind: "text" } },
    to: { kind: "enum", members: ALIGN_SCOPES, optional: true },
    key: { kind: "text", optional: true },
    spacing: { kind: "number", unit: "pt", optional: true },
  },
};

export interface AlignArgs {
  kind: AlignKind;
  targets: readonly string[];
  to?: AlignScope;
  key?: string;
  spacing?: number;
}

/** A page as Align sees it: its box in SPREAD space and its margins. */
export interface AlignPage {
  id: string;
  spreadId: string | null;
  /** `[top, left, bottom, right]`, spread space. */
  rect: Bounds;
  /** Physical margins (pt). */
  margins: { top: number; left: number; bottom: number; right: number };
}

/** One planned move: `target` translated by `[dx, dy]` (spread pt). */
export interface AlignMove {
  address: string;
  delta: [number, number];
}

type Axis = "h" | "v";

const EDGE: Record<
  AlignKind,
  { axis: Axis; at: 0 | 0.5 | 1; mode: "align" | "distribute" | "space" }
> = {
  left: { axis: "h", at: 0, mode: "align" },
  centerH: { axis: "h", at: 0.5, mode: "align" },
  right: { axis: "h", at: 1, mode: "align" },
  top: { axis: "v", at: 0, mode: "align" },
  centerV: { axis: "v", at: 0.5, mode: "align" },
  bottom: { axis: "v", at: 1, mode: "align" },
  distributeLeft: { axis: "h", at: 0, mode: "distribute" },
  distributeH: { axis: "h", at: 0.5, mode: "distribute" },
  distributeRight: { axis: "h", at: 1, mode: "distribute" },
  distributeTop: { axis: "v", at: 0, mode: "distribute" },
  distributeV: { axis: "v", at: 0.5, mode: "distribute" },
  distributeBottom: { axis: "v", at: 1, mode: "distribute" },
  spaceH: { axis: "h", at: 0, mode: "space" },
  spaceV: { axis: "v", at: 0, mode: "space" },
};

/** `[start, end]` of a box on an axis. */
const span = ([t, l, b, r]: Bounds, axis: Axis): [number, number] =>
  axis === "h" ? [l, r] : [t, b];

const union = (boxes: readonly Bounds[]): Bounds | null => {
  if (boxes.length === 0) return null;
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const [bt, bl, bb, br] of boxes) {
    t = Math.min(t, bt);
    l = Math.min(l, bl);
    b = Math.max(b, bb);
    r = Math.max(r, br);
  }
  return [t, l, b, r];
};

/** The page a target is aligned to: its own, or (on the pasteboard) its
 *  spread's first page. */
function pageOf(
  t: SpreadTarget,
  pages: readonly AlignPage[],
): AlignPage | null {
  return (
    (t.pageId ? pages.find((p) => p.id === t.pageId) : undefined) ??
    pages.find((p) => t.spreadId !== null && p.spreadId === t.spreadId) ??
    null
  );
}

/** The rect `t` aligns against in a page scope, and the key that groups
 *  the targets sharing it. */
function scopeRect(
  to: "page" | "margins" | "spread",
  t: SpreadTarget,
  pages: readonly AlignPage[],
): { key: string; rect: Bounds } | null {
  const page = pageOf(t, pages);
  if (!page) return null;
  if (to === "spread") {
    const rect = union(
      pages.filter((p) => p.spreadId === page.spreadId).map((p) => p.rect),
    );
    return rect ? { key: `spread:${page.spreadId ?? page.id}`, rect } : null;
  }
  const [pt, pl, pb, pr] = page.rect;
  if (to === "page") return { key: `page:${page.id}`, rect: page.rect };
  const m = page.margins;
  return {
    key: `page:${page.id}`,
    rect: [pt + m.top, pl + m.left, pb - m.bottom, pr - m.right],
  };
}

/**
 * The moves an alignment makes, in spread space. Objects already in place
 * are left out. Selection / key-object scopes need two objects (three to
 * distribute or space without a fixed spacing); a page scope aligns one
 * object on its own and distributes two or more.
 */
export function planAlign(
  args: Omit<AlignArgs, "targets">,
  targets: readonly SpreadTarget[],
  pages: readonly AlignPage[] = [],
): AlignMove[] {
  const { axis, at, mode } = EDGE[args.kind];
  const to = args.to ?? "selection";
  const spacing =
    typeof args.spacing === "number" && Number.isFinite(args.spacing)
      ? args.spacing
      : undefined;
  const moves = new Map<string, number>();

  // The groups of targets that share a reference rect, each with it.
  const groups: Array<{
    items: SpreadTarget[];
    rect: Bounds | null;
    key: SpreadTarget | null;
  }> = [];
  if (to === "selection" || to === "keyObject") {
    const key =
      to === "keyObject"
        ? (targets.find((t) => t.address === args.key) ?? targets[0] ?? null)
        : null;
    const fixed = spacing !== undefined;
    const min = mode === "align" || fixed ? 2 : 3;
    if (targets.length < min) return [];
    groups.push({
      items: [...targets],
      rect: key ? key.box : union(targets.map((t) => t.box)),
      key,
    });
  } else {
    const byRect = new Map<string, { items: SpreadTarget[]; rect: Bounds }>();
    for (const t of targets) {
      const s = scopeRect(to, t, pages);
      if (!s) continue;
      const g = byRect.get(s.key) ?? { items: [], rect: s.rect };
      g.items.push(t);
      byRect.set(s.key, g);
    }
    for (const g of byRect.values()) {
      if (mode !== "align" && g.items.length < 2) continue;
      groups.push({ ...g, key: null });
    }
  }

  for (const { items, rect, key } of groups) {
    if (!rect) continue;
    const [rs, re] = span(rect, axis);
    if (mode === "align") {
      const target = rs + (re - rs) * at;
      for (const t of items) {
        if (t === key) continue;
        const [s, e] = span(t.box, axis);
        moves.set(t.address, target - (s + (e - s) * at));
      }
      continue;
    }
    // Distribute: order by the edge (or the start, for spacing).
    const edge = (t: SpreadTarget) => {
      const [s, e] = span(t.box, axis);
      return s + (e - s) * at;
    };
    const sorted = [...items].sort((a, b) => edge(a) - edge(b));
    const n = sorted.length;
    const size = (t: SpreadTarget) => {
      const [s, e] = span(t.box, axis);
      return e - s;
    };
    const scoped = to !== "selection" && to !== "keyObject";
    // The anchor stays where it is (the key; else the first object, or
    // in a page scope the first object flush with the rect's start).
    const anchorIndex = key ? Math.max(0, sorted.indexOf(key)) : 0;
    const anchor = sorted[anchorIndex]!;
    const [as] = span(anchor.box, axis);
    const anchorStart = scoped && !key ? rs : as;
    if (mode === "distribute") {
      let step: number;
      if (spacing !== undefined) step = spacing;
      else if (scoped) {
        const first = rs + size(sorted[0]!) * at;
        const last = re - size(sorted[n - 1]!) * (1 - at);
        step = n > 1 ? (last - first) / (n - 1) : 0;
      } else {
        step = n > 1 ? (edge(sorted[n - 1]!) - edge(sorted[0]!)) / (n - 1) : 0;
      }
      const anchorEdge = anchorStart + size(anchor) * at;
      for (const [i, t] of sorted.entries()) {
        const want = anchorEdge + (i - anchorIndex) * step;
        moves.set(t.address, want - edge(t));
      }
    } else {
      let gap: number;
      const total = sorted.reduce((sum, t) => sum + size(t), 0);
      if (spacing !== undefined) gap = spacing;
      else if (scoped) gap = n > 1 ? (re - rs - total) / (n - 1) : 0;
      else {
        const [s0] = span(sorted[0]!.box, axis);
        const [, e1] = span(sorted[n - 1]!.box, axis);
        gap = n > 1 ? (e1 - s0 - total) / (n - 1) : 0;
      }
      const starts: number[] = new Array<number>(n);
      starts[anchorIndex] = anchorStart;
      for (let i = anchorIndex + 1; i < n; i++)
        starts[i] = starts[i - 1]! + size(sorted[i - 1]!) + gap;
      for (let i = anchorIndex - 1; i >= 0; i--)
        starts[i] = starts[i + 1]! - gap - size(sorted[i]!);
      for (const [i, t] of sorted.entries()) {
        const [s] = span(t.box, axis);
        moves.set(t.address, starts[i]! - s);
      }
    }
    if (key) moves.delete(key.address);
  }

  const out: AlignMove[] = [];
  for (const t of targets) {
    const d = moves.get(t.address);
    if (d === undefined || Math.abs(d) < 1e-3) continue;
    out.push({
      address: t.address,
      delta: axis === "h" ? [d, 0] : [0, d],
    });
  }
  return out;
}

/** The writes of `moves`: each a translation through the target's own
 *  transform door. */
export function alignOps(
  moves: readonly AlignMove[],
  targets: readonly SpreadTarget[],
): ShellObjectOp[] {
  const byAddress = new Map(targets.map((t) => [t.address, t]));
  const ops: ShellObjectOp[] = [];
  for (const m of moves) {
    const t = byAddress.get(m.address);
    if (t) ops.push(transformOpFor(t, translate(m.delta[0], m.delta[1])));
  }
  return ops;
}

/** What `runAlign` reads and writes through. */
export interface AlignDeps {
  /** The targets' spread-space geometry (an address with none is left out). */
  targets(addresses: readonly string[]): Promise<SpreadTarget[]>;
  /** Every page, for the page scopes. */
  pages(): Promise<AlignPage[]>;
  batch(
    ops: readonly ShellObjectOp[],
    opts?: { label?: string },
  ): Promise<{
    applied: boolean;
    undoSteps: 0 | 1;
    code?: string;
    reason?: string;
  }>;
}

/** Run an alignment: read → plan → ONE batch. Returns the batch result
 *  (`undoSteps: 0` when nothing moved). */
export async function runAlign(deps: AlignDeps, args: AlignArgs) {
  const targets = await deps.targets(args.targets);
  const to = args.to ?? "selection";
  const pages =
    to === "page" || to === "margins" || to === "spread"
      ? await deps.pages()
      : [];
  const ops = alignOps(planAlign(args, targets, pages), targets);
  if (ops.length === 0) return { applied: true, undoSteps: 0 as const };
  return deps.batch(ops, { label: `align ${args.kind}` });
}
