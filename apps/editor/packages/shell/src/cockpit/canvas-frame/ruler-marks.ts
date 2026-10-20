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

// The ruler's labelled marks (UX audit F-31, ADR 263). InDesign thins
// its ruler numbers as you zoom out so they never run into each other:
// the labelled step grows until the widest number in view, plus a gap,
// fits between two marks. The step comes from the 1-2-5 progression
// (1, 2, 5, 10, 20, 50, …), so at every zoom the numbers stay round.

/** Width of one character of a ruler label, px: the labels are 9 px
 *  monospace, whose advance is 0.6 em. */
export const RULER_CHAR_PX = 5.4;
/** The label's inset from its mark, px. */
export const RULER_LABEL_INSET = 3;
/** The least free space between one label's end and the next mark, px. */
export const RULER_LABEL_GAP = 12;
/** The least distance between two labelled marks, px, whatever the
 *  labels: a ruler reads best with marks no closer than this. */
export const RULER_MIN_SPACING = 48;

/** The text a mark is labelled with. A real minus sign keeps a
 *  negative label as wide as it reads. */
export function rulerLabel(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : String(value);
}

/** Width in px of a label as drawn. */
export function rulerLabelWidth(value: number): number {
  return rulerLabel(value).length * RULER_CHAR_PX;
}

/** The 1-2-5 progression, from 1 upward, as long as `limit` needs. */
function* niceSteps(): Generator<number> {
  for (let decade = 1; ; decade *= 10) {
    yield decade;
    yield 2 * decade;
    yield 5 * decade;
  }
}

/**
 * The document-space step between labelled marks at `scale` (px per
 * document unit), for a ruler showing document coordinates
 * `[docStart, docEnd]`: the smallest 1-2-5 step whose marks leave room
 * for the widest label in view plus a gap.
 */
export function rulerStep(
  scale: number,
  docStart: number,
  docEnd: number,
): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 1;
  for (const step of niceSteps()) {
    const lo = Math.floor(docStart / step) * step;
    const hi = Math.ceil(docEnd / step) * step;
    const widest = Math.max(rulerLabelWidth(lo), rulerLabelWidth(hi));
    const need = Math.max(
      RULER_MIN_SPACING,
      RULER_LABEL_INSET + widest + RULER_LABEL_GAP,
    );
    if (step * scale >= need) return step;
    if (step > 1e9) return step;
  }
  return 1;
}

export interface RulerMark {
  /** Position along the ruler, px from its start. */
  px: number;
  /** The document coordinate the mark stands for. */
  value: number;
  /** The label, or null when it would be cut by the ruler's start. */
  label: string | null;
}

/**
 * The labelled marks of a ruler `length` px long whose document origin
 * sits at `translate` px and whose scale is `scale` px per unit. A mark
 * whose label would start before the ruler (a number half scrolled out
 * of view, which read "300" for −300) keeps its tick but not its label.
 */
export function rulerMarks(
  scale: number,
  translate: number,
  length: number,
): RulerMark[] {
  if (!(length > 0) || !(scale > 0)) return [];
  const docStart = -translate / scale;
  const docEnd = (length - translate) / scale;
  const step = rulerStep(scale, docStart, docEnd);
  const marks: RulerMark[] = [];
  const first = Math.floor(docStart / step) * step;
  for (let d = first; d * scale + translate < length; d += step) {
    const px = d * scale + translate;
    marks.push({
      px,
      value: d,
      label: px + RULER_LABEL_INSET >= 0 ? rulerLabel(d) : null,
    });
  }
  return marks;
}
