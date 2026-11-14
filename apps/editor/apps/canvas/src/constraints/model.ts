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

// Design constraints as editable intent (editor ADR 1233; the UX strategy's
// Concept C; the interaction specification's §25.1 "constraint
// suggestions"). A constraint records what a designer means beside what the
// page stores — these four are evenly spaced, this caption aligns to its
// picture, this headline keeps within three lines — and the editor says,
// continuously, whether it holds. It is VALIDATED, never solved: nothing
// moves unless the user applies a suggested fix, which is one undo step.
//
// The records live in the document, as its own label `x-paged:constraints`
// (the document label of PM-0018 and protocol 69/70: undoable through
// `setDocumentMetadata`, written in a `.paged` file and kept by an `.idml`
// export as a `Properties/Label` entry on the designmap's Document, which
// InDesign preserves). A constraint names its members by their page item
// ids, which IDML keeps as `Self`. A member that is gone leaves its
// constraint unknown, never silently dropped.
//
// PURE: types, the label's encoding and its shape check, and which kinds a
// selection can take.

import { decodeEnvelope, encodeEnvelope } from "@paged-media/helpers";
import type { ElementId } from "@paged-media/client";

/** The document label the constraints live in. */
export const CONSTRAINTS_LABEL = "x-paged:constraints";

/** The payload version of the label. */
export const CONSTRAINTS_VERSION = 1;

/** How many constraints a document keeps (the label's 64 KiB cap holds
 *  this many with room to spare). */
export const MAX_CONSTRAINTS = 200;

/** The default tolerance, pt: below it an alignment or a spacing holds. */
export const DEFAULT_TOLERANCE_PT = 0.5;

export type ConstraintKind =
  "align" | "equal-spacing" | "max-lines" | "min-gap" | "fits" | "margin";

/** The edge an `align` constraint lines its members up on. `baseline` is
 *  the foot of each text frame's first line (the engine reports a line's
 *  box, not its baseline: equal for first lines of one size and font). */
export type AlignEdge =
  "left" | "right" | "top" | "bottom" | "centerX" | "centerY" | "baseline";

/** The page margin a `margin` constraint holds an edge to. `outer` and
 *  `inner` follow the page's side (the spine is `PageSummary.bindingEdge`). */
export type MarginEdge =
  "outer" | "inner" | "left" | "right" | "top" | "bottom";

export type SpacingAxis = "horizontal" | "vertical";

export interface ConstraintParams {
  edge?: AlignEdge;
  margin?: MarginEdge;
  axis?: SpacingAxis;
  /** `max-lines`: the most lines the text may take. */
  lines?: number;
  /** `min-gap`: the least distance between the two, pt. */
  gap?: number;
  /** pt; `DEFAULT_TOLERANCE_PT` when absent. */
  tolerance?: number;
}

/** One constraint: what it holds, among which items. The FIRST member of
 *  an alignment is its key object (D-07): the others line up to it. */
export interface Constraint {
  id: string;
  kind: ConstraintKind;
  members: ElementId[];
  params: ConstraintParams;
  /** The user's own name for it, if any. */
  label?: string;
}

const KINDS: readonly ConstraintKind[] = [
  "align",
  "equal-spacing",
  "max-lines",
  "min-gap",
  "fits",
  "margin",
];
const ALIGN_EDGES: readonly AlignEdge[] = [
  "left",
  "right",
  "top",
  "bottom",
  "centerX",
  "centerY",
  "baseline",
];
const MARGIN_EDGES: readonly MarginEdge[] = [
  "outer",
  "inner",
  "left",
  "right",
  "top",
  "bottom",
];
const PAGE_ITEM_KINDS = new Set([
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "group",
  "instance",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function readMember(v: unknown): ElementId | null {
  if (!isRecord(v)) return null;
  if (typeof v.kind !== "string" || !PAGE_ITEM_KINDS.has(v.kind)) return null;
  if (typeof v.id !== "string" || !v.id) return null;
  return { kind: v.kind, id: v.id } as ElementId;
}

/** The kind's member count: [least, most]. */
export function memberRange(kind: ConstraintKind): [number, number] {
  switch (kind) {
    case "align":
      return [2, 64];
    case "equal-spacing":
      return [3, 64];
    case "min-gap":
      return [2, 2];
    case "max-lines":
    case "fits":
      return [1, 1];
    case "margin":
      return [1, 64];
  }
}

/** One record as stored, shape-checked field by field (ADR 247): a record
 *  that cannot be read is left out, never repaired into something else. */
export function readConstraint(v: unknown): Constraint | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || !v.id) return null;
  if (!KINDS.includes(v.kind as ConstraintKind)) return null;
  const kind = v.kind as ConstraintKind;
  if (!Array.isArray(v.members)) return null;
  const members = v.members.map(readMember);
  if (members.some((m) => m === null)) return null;
  const [least, most] = memberRange(kind);
  if (members.length < least || members.length > most) return null;
  const p = isRecord(v.params) ? v.params : {};
  const params: ConstraintParams = {};
  if (ALIGN_EDGES.includes(p.edge as AlignEdge))
    params.edge = p.edge as AlignEdge;
  if (MARGIN_EDGES.includes(p.margin as MarginEdge))
    params.margin = p.margin as MarginEdge;
  if (p.axis === "horizontal" || p.axis === "vertical") params.axis = p.axis;
  if (finite(p.lines) && Number.isInteger(p.lines) && p.lines >= 1)
    params.lines = p.lines;
  if (finite(p.gap) && p.gap >= 0) params.gap = p.gap;
  if (finite(p.tolerance) && p.tolerance >= 0) params.tolerance = p.tolerance;
  // A kind without the parameter it needs is no constraint.
  if (kind === "align" && !params.edge) return null;
  if (kind === "margin" && !params.margin) return null;
  if (kind === "equal-spacing" && !params.axis) return null;
  if (kind === "max-lines" && params.lines === undefined) return null;
  if (kind === "min-gap" && params.gap === undefined) return null;
  const out: Constraint = {
    id: v.id,
    kind,
    members: members as ElementId[],
    params,
  };
  if (typeof v.label === "string" && v.label.trim())
    out.label = v.label.trim().slice(0, 120);
  return out;
}

/** The constraints of a document label's value (null or unreadable: none). */
export function readConstraintsLabel(
  text: string | null | undefined,
): Constraint[] {
  const envelope = decodeEnvelope<{ constraints?: unknown }>(text);
  const list =
    envelope && isRecord(envelope.data) ? envelope.data.constraints : null;
  if (!Array.isArray(list)) return [];
  const out: Constraint[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const c = readConstraint(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_CONSTRAINTS) break;
  }
  return out;
}

/** The label's value for `constraints`, or null for none (the label goes). */
export function encodeConstraintsLabel(
  constraints: readonly Constraint[],
): string | null {
  if (constraints.length === 0) return null;
  return encodeEnvelope({ constraints }, CONSTRAINTS_VERSION);
}

/** The document's constraints, from its meta's plugin metadata. */
export function constraintsOfMeta(
  meta: {
    pluginMetadata?: ReadonlyArray<{ key: string; value: string }>;
  } | null,
): Constraint[] {
  const entry = meta?.pluginMetadata?.find((e) => e.key === CONSTRAINTS_LABEL);
  return readConstraintsLabel(entry?.value ?? null);
}

/** The mutation that writes `constraints` (one undo step). */
export function constraintsMutation(constraints: readonly Constraint[]): {
  op: "setDocumentMetadata";
  args: { key: string; value: string | null };
} {
  return {
    op: "setDocumentMetadata",
    args: {
      key: CONSTRAINTS_LABEL,
      value: encodeConstraintsLabel(constraints),
    },
  };
}

/** A new constraint's id: short, unique in `taken`. */
export function newConstraintId(
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  for (;;) {
    const id = `c${Math.floor(random() * 0x7fffffff).toString(36)}`;
    if (!taken.has(id)) return id;
  }
}

/** The kinds a selection of `members` can take, in the dialog's order. A
 *  text frame alone also takes `max-lines` and `fits`. */
export function kindsFor(members: readonly ElementId[]): ConstraintKind[] {
  const n = members.length;
  const out: ConstraintKind[] = [];
  if (n >= 3) out.push("equal-spacing");
  if (n >= 2) out.push("align");
  if (n === 2) out.push("min-gap");
  if (n === 1 && members[0]!.kind === "textFrame")
    out.push("max-lines", "fits");
  if (n >= 1) out.push("margin");
  return out.filter((k) => {
    const [least, most] = memberRange(k);
    return n >= least && n <= most;
  });
}

/** A key that names an item (for maps and data attributes). */
export function memberKey(id: ElementId): string {
  return `${id.kind}:${String(id.id)}`;
}
