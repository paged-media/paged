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

// The words of the design constraints (editor ADR 1233): what a constraint
// keeps, whether it holds and by how much it misses, and what its fix will
// do — said before the fix runs. Lengths in the document's unit.

import { formatLength } from "@paged-media/ui";
import { defineMessages, t } from "@paged-media/strings";

import type { ConstraintResult, FixPlan } from "./evaluate";
import type {
  AlignEdge,
  Constraint,
  ConstraintKind,
  MarginEdge,
} from "./model";

export const CONSTRAINT_WORDS = defineMessages("app.constraints", {
  kindAlign: "Align",
  kindEqualSpacing: "Equal spacing",
  kindMaxLines: "Maximum lines",
  kindMinGap: "Minimum gap",
  kindFits: "Must fit",
  kindMargin: "Align to margin",
  edgeLeft: "left edges",
  edgeRight: "right edges",
  edgeTop: "top edges",
  edgeBottom: "bottom edges",
  edgeCenterX: "horizontal centres",
  edgeCenterY: "vertical centres",
  edgeBaseline: "first baselines",
  marginOuter: "outer margin",
  marginInner: "inner margin",
  marginLeft: "left margin",
  marginRight: "right margin",
  marginTop: "top margin",
  marginBottom: "bottom margin",
  titleAlign: "{edge} aligned ({count} items)",
  titleEqualSpacingH: "Evenly spaced across ({count} items)",
  titleEqualSpacingV: "Evenly spaced down ({count} items)",
  titleMaxLines:
    "{lines, plural, one {At most # line} other {At most # lines}}",
  titleMinGap: "At least {gap} apart",
  titleFits: "Text fits its frame",
  titleMargin:
    "{count, plural, one {On the {margin}} other {On the {margin} (# items)}}",
  holds: "Holds",
  alignOff: "Off by up to {worst}",
  spacingOff: "Gaps from {min} to {max}; even is {target}",
  gapShort: "{gap} apart; at least {required}",
  overlap: "They overlap; at least {required} apart",
  linesOver: "{lines} lines; at most {max}",
  linesOverset: "The text runs over; at most {max} lines",
  doesNotFit: "The text does not fit",
  marginOff: "Off the {margin} by up to {worst}",
  missingMember: "An item it names is no longer in the document",
  noPage: "An item it names is on the pasteboard",
  differentPages: "Its items are on different pages",
  notText: "It needs text frames",
  unread: "Not measured yet",
  fixAlign: "Align to the key object",
  fixSpace: "Space evenly",
  fixMoveApart: "Move apart",
  fixToMargin: "Move to the margin",
  fixMoves:
    "{count, plural, one {Moves 1 item by {by}.} other {Moves # items, by up to {by}.}} Nothing else changes.",
  fixEditText: "Edit the text",
  fixEditTextPreview:
    "Fewer lines take other words or other type; Paged never changes the text itself.",
  issue: "{title}: {state}",
});

const W = CONSTRAINT_WORDS;

export function kindLabel(kind: ConstraintKind): string {
  switch (kind) {
    case "align":
      return t(W.kindAlign);
    case "equal-spacing":
      return t(W.kindEqualSpacing);
    case "max-lines":
      return t(W.kindMaxLines);
    case "min-gap":
      return t(W.kindMinGap);
    case "fits":
      return t(W.kindFits);
    case "margin":
      return t(W.kindMargin);
  }
}

export function edgeLabel(edge: AlignEdge): string {
  switch (edge) {
    case "left":
      return t(W.edgeLeft);
    case "right":
      return t(W.edgeRight);
    case "top":
      return t(W.edgeTop);
    case "bottom":
      return t(W.edgeBottom);
    case "centerX":
      return t(W.edgeCenterX);
    case "centerY":
      return t(W.edgeCenterY);
    case "baseline":
      return t(W.edgeBaseline);
  }
}

export function marginLabel(margin: MarginEdge): string {
  switch (margin) {
    case "outer":
      return t(W.marginOuter);
    case "inner":
      return t(W.marginInner);
    case "left":
      return t(W.marginLeft);
    case "right":
      return t(W.marginRight);
    case "top":
      return t(W.marginTop);
    case "bottom":
      return t(W.marginBottom);
  }
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the constraint keeps, as a title ("Left edges aligned (3 items)"). */
export function constraintTitle(
  c: Constraint,
  len: (pt: number) => string = (pt) => formatLength(pt),
): string {
  if (c.label) return c.label;
  const count = c.members.length;
  switch (c.kind) {
    case "align":
      return sentence(
        t(W.titleAlign, { edge: edgeLabel(c.params.edge!), count }),
      );
    case "equal-spacing":
      return t(
        c.params.axis === "vertical"
          ? W.titleEqualSpacingV
          : W.titleEqualSpacingH,
        { count },
      );
    case "max-lines":
      return t(W.titleMaxLines, { lines: c.params.lines! });
    case "min-gap":
      return t(W.titleMinGap, { gap: len(c.params.gap!) });
    case "fits":
      return t(W.titleFits);
    case "margin":
      return t(W.titleMargin, { margin: marginLabel(c.params.margin!), count });
  }
}

/** Whether it holds, in words ("Holds", "Off by up to 4.5 pt"). */
export function resultText(
  r: ConstraintResult | undefined,
  len: (pt: number) => string = (pt) => formatLength(pt),
): string {
  if (!r) return t(W.unread);
  if (r.status === "unknown") {
    switch (r.reason) {
      case "missing-member":
        return t(W.missingMember);
      case "no-page":
        return t(W.noPage);
      case "different-pages":
        return t(W.differentPages);
      case "not-text":
        return t(W.notText);
      default:
        return t(W.unread);
    }
  }
  if (r.status === "holds" || !r.measure) return t(W.holds);
  const m = r.measure;
  switch (m.kind) {
    case "align":
      return t(W.alignOff, { worst: len(m.worst) });
    case "equal-spacing":
      return t(W.spacingOff, {
        min: len(m.min),
        max: len(m.max),
        target: len(m.target),
      });
    case "min-gap":
      return m.gap < 0
        ? t(W.overlap, { required: len(m.required) })
        : t(W.gapShort, { gap: len(m.gap), required: len(m.required) });
    case "max-lines":
      return m.overset
        ? t(W.linesOverset, { max: m.max })
        : t(W.linesOver, { lines: m.lines, max: m.max });
    case "fits":
      return t(W.doesNotFit);
    case "margin":
      return t(W.marginOff, {
        margin: marginLabel(m.margin),
        worst: len(m.worst),
      });
  }
}

/** The issue's words: "Left edges aligned (3 items): Off by up to 4.5 pt". */
export function issueLabel(
  c: Constraint,
  r: ConstraintResult | undefined,
  len?: (pt: number) => string,
): string {
  return t(W.issue, {
    title: constraintTitle(c, len),
    state: resultText(r, len),
  });
}

/** A move fix's label and what it will do. */
export function moveFixWords(
  c: Constraint,
  plan: Extract<FixPlan, { kind: "move" }>,
  len: (pt: number) => string = (pt) => formatLength(pt),
): { label: string; preview: string } {
  const label =
    c.kind === "equal-spacing"
      ? t(W.fixSpace)
      : c.kind === "min-gap"
        ? t(W.fixMoveApart)
        : c.kind === "margin"
          ? t(W.fixToMargin)
          : t(W.fixAlign);
  const by = Math.max(0, ...plan.moves.map((m) => Math.hypot(m.dx, m.dy)));
  return {
    label,
    preview: t(W.fixMoves, {
      count: plan.moves.length,
      by: len(Math.round(by * 100) / 100),
    }),
  };
}
