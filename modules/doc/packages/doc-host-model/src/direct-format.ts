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

// Word's direct formatting in a table cell as direct properties (engine ADR
// 1098, doc ADR 600 amendment 2026-11-12). The lowering names a synthesized
// `docx-auto-*` style for every distinct set of direct formatting, because the
// host's mutation door once styled a range only by a named style. A cell's
// text now takes direct properties through a cell-qualified `storyRange`, so
// the pour applies the Word style a synthesized style stands on and sets its
// properties on the range, as the native body does in Rust
// (`docx-skeleton` `body.rs`: `split_style`, and the rule for a paragraph's
// character properties). The two read the same catalogue the same way.

import type { Mutation, PropertyPath, Value } from "@paged-media/plugin-api";

import type {
  LoweredParagraph,
  LoweredStyle,
  LoweredTable,
  StyleProp,
} from "./lowered.js";

const AUTO_PARA = "ParagraphStyle/docx-auto-p";
const AUTO_CHAR = "CharacterStyle/docx-auto-c";

/** Style properties a range does not take: the applied language (the old
 *  pour's engine refused it as a style property, so no text ever carried
 *  it; the native body leaves it out the same way) and a paragraph style's
 *  PDF export tag (a style's, never a paragraph's). */
const NOT_ON_A_RANGE = new Set([
  "characterLanguage",
  "paragraphStylePdfExportTag",
]);

/** Whether `id` names a style the lowering synthesized for direct
 *  formatting. */
export function isSynthesized(id: string | null | undefined): boolean {
  return !!id && (id.startsWith(AUTO_PARA) || id.startsWith(AUTO_CHAR));
}

/** The style catalogue by id. */
export type StyleCatalogue = ReadonlyMap<string, LoweredStyle>;

export function catalogue(styles: readonly LoweredStyle[]): StyleCatalogue {
  return new Map(styles.map((s) => [s.id, s]));
}

/** A style as the Word style it stands on and the direct properties laid
 *  over it (a synthesized chain flattened, the nearest style's value last).
 *  A Word style is itself with no properties. */
export interface Direct {
  base: string | null;
  props: StyleProp[];
}

/** {@link Direct} of `id`, or null when a synthesized style in its chain is
 *  not in the catalogue (the caller then applies `id` as it is). */
export function splitStyle(
  styles: StyleCatalogue,
  id: string | null | undefined,
): Direct | null {
  if (!id) return { base: null, props: [] };
  if (!isSynthesized(id)) return { base: id, props: [] };
  const chain: LoweredStyle[] = [];
  let at: string | null | undefined = id;
  while (at && isSynthesized(at)) {
    const s = styles.get(at);
    if (!s || chain.length > 16) return null;
    chain.push(s);
    at = s.basedOn;
  }
  const byPath = new Map<string, StyleProp>();
  for (const s of chain.reverse())
    for (const p of s.props) {
      byPath.delete(p.path);
      byPath.set(p.path, p);
    }
  return {
    base: at ?? null,
    props: [...byPath.values()].filter((p) => !NOT_ON_A_RANGE.has(p.path)),
  };
}

/** The paths a style sets through its whole chain (Word styles included). */
function resolvedPaths(styles: StyleCatalogue, id: string): Set<string> {
  const out = new Set<string>();
  let at: string | null | undefined = id;
  for (let n = 0; at && n < 32; n++) {
    const s = styles.get(at);
    if (!s) break;
    for (const p of s.props) out.add(p.path);
    at = s.basedOn;
  }
  return out;
}

const isCharPath = (path: string) => path.startsWith("character");

/** How one cell paragraph is formatted directly. */
export interface ParagraphPlan {
  /** The paragraph style to apply (a Word style, or — `kept` — the
   *  synthesized one as it is), if any. */
  style: string | null;
  /** The synthesized paragraph style is applied as it is: its character
   *  properties have no run to carry them (the paragraph is empty), or a
   *  run's Word character style sets one of them, where a run's own value
   *  would win over the character style the cascade lets win. */
  kept: boolean;
  /** Paragraph properties set on the paragraph. */
  props: StyleProp[];
  /** Per run: the character style to apply (null: none) and the direct
   *  properties (the paragraph style's character properties, then the
   *  run's own). Null for a run whose style is applied as it is. */
  runs: ({ style: string | null; props: StyleProp[] } | null)[];
}

/** The plan of one cell paragraph — the native body's rule
 *  (`docx-skeleton` `native_paragraph`). */
export function paragraphPlan(
  styles: StyleCatalogue,
  para: LoweredParagraph,
): ParagraphPlan {
  const direct = splitStyle(styles, para.paraStyleId);
  const runs = para.runs.map((r) => splitStyle(styles, r.charStyleId));
  if (!direct) {
    return {
      style: para.paraStyleId ?? null,
      kept: true,
      props: [],
      runs: runs.map((d) => d && { style: d.base, props: d.props }),
    };
  }
  const chars = direct.props.filter((p) => isCharPath(p.path));
  const allEmpty = para.runs.every((r) => r.text.length === 0);
  const overlaps =
    chars.length > 0 &&
    runs.some((d) => {
      if (!d?.base) return false;
      const theirs = resolvedPaths(styles, d.base);
      return chars.some((c) => theirs.has(c.path));
    });
  const kept = chars.length > 0 && (allEmpty || overlaps);
  const under = kept ? [] : chars;
  return {
    style: kept ? (para.paraStyleId ?? null) : direct.base,
    kept,
    props: kept ? [] : direct.props.filter((p) => !isCharPath(p.path)),
    runs: runs.map((d) => {
      if (!d) return null;
      const byPath = new Map<string, StyleProp>();
      for (const p of [...under, ...d.props]) {
        byPath.delete(p.path);
        byPath.set(p.path, p);
      }
      return { style: d.base, props: [...byPath.values()] };
    }),
  };
}

/** One direct property on a cell's text range (`setElementProperty` on a
 *  cell-qualified `storyRange`, engine ADR 1098). */
export function cellRangePropertyOp(
  storyId: string,
  cell: { tableId: string; row: number; col: number },
  start: number,
  end: number,
  prop: StyleProp,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: {
        kind: "storyRange",
        id: { story_id: storyId, start, end, cell },
      },
      path: prop.path as PropertyPath,
      value: prop.value as Value,
    },
  };
}

/** The synthesized styles the cells of `table` (nested tables included)
 *  still name once their direct formatting is set directly: a kept
 *  paragraph style, a style missing from the catalogue, and a tracked
 *  format change's look before (a change names its look by a style). */
function cellStyleRefs(
  styles: StyleCatalogue,
  table: LoweredTable,
  out: Set<string>,
): void {
  for (const cell of table.cells) {
    for (const para of cell.paragraphs) {
      const plan = paragraphPlan(styles, para);
      if (plan.kept && plan.style) out.add(plan.style);
      para.runs.forEach((r, k) => {
        if (!plan.runs[k] && r.charStyleId) out.add(r.charStyleId);
        if (r.formatChange?.beforeCharStyleId)
          out.add(r.formatChange.beforeCharStyleId);
      });
      if (para.propsChange?.beforeParaStyleId)
        out.add(para.propsChange.beforeParaStyleId);
      collectRefs(
        { ...para, runs: [], paraStyleId: null, propsChange: null },
        out,
      );
      for (const r of para.runs)
        collectRefs({ ...r, charStyleId: null, formatChange: null }, out);
    }
    for (const n of cell.nested ?? []) cellStyleRefs(styles, n.table, out);
  }
}

/** Every synthesized style id anywhere in `value` (a deep walk). */
function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (isSynthesized(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

/** The synthesized styles the document still needs minted: every one named
 *  outside a native table cell (the body, notes, headers and footers, text
 *  boxes, a tracked change's look), every one a cell still names
 *  ({@link cellStyleRefs}), and the synthesized styles those stand on. The
 *  rest carried only a cell's direct formatting, which is now set directly. */
export function synthesizedStylesInUse(
  doc: { styles: readonly LoweredStyle[] } & Record<string, unknown>,
): Set<string> {
  const styles = catalogue(doc.styles);
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && isSynthesized(value)) out.add(value);
      return;
    }
    const o = value as Record<string, unknown>;
    // A native table (not one poured as text): its cells are planned.
    if (o.kind === "table" && Array.isArray(o.cells) && !hasFlow(o)) {
      cellStyleRefs(styles, o as unknown as LoweredTable, out);
      for (const [k, v] of Object.entries(o)) if (k !== "cells") walk(v);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  for (const [k, v] of Object.entries(doc)) if (k !== "styles") walk(v);
  // The synthesized styles a kept one stands on.
  for (const id of [...out]) {
    let at = styles.get(id)?.basedOn;
    while (at && isSynthesized(at) && !out.has(at)) {
      out.add(at);
      at = styles.get(at)?.basedOn;
    }
  }
  return out;
}

function hasFlow(o: Record<string, unknown>): boolean {
  return Array.isArray(o.flow) && o.flow.length > 0;
}
