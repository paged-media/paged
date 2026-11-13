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

// Who may own an interaction, and in which order a claim is decided
// (the interaction specification, §3.2 and §3.4; editor ADR 1200).
//
// The owner names are the spec's `InteractionOwner`. The interaction
// inventory (apps/editor/scripts/interaction-inventory.json) names its
// owners with these strings, and its guard checks that this file names
// every one of them.

/** The spec's `InteractionOwner` (§3.2), in its order. */
export const INTERACTION_OWNERS = [
  "canvas-select",
  "canvas-transform",
  "canvas-draw",
  "canvas-text",
  "canvas-path",
  "canvas-camera",
  "frame-content",
  "ruler-guide",
  "drag-drop",
  "panel",
  "modal",
  "plugin-surface",
] as const;
export type InteractionOwner = (typeof INTERACTION_OWNERS)[number];

/** The spec's `InteractionPhase` (§3.2): where a session is in its life. */
export const INTERACTION_PHASES = [
  "idle",
  "pressed",
  "pending-hit",
  "previewing",
  "committing",
  "canceling",
  "settled",
] as const;
export type InteractionPhase = (typeof INTERACTION_PHASES)[number];

/**
 * The legal edges of §3.3. A session moves only along these
 * (`UXI-STATE-002`); `settled` is reached through `end`.
 */
export const PHASE_EDGES: Readonly<
  Record<InteractionPhase, readonly InteractionPhase[]>
> = {
  idle: ["pressed", "pending-hit"],
  pressed: ["pressed", "pending-hit", "previewing", "canceling", "settled"],
  "pending-hit": ["pressed", "previewing", "canceling", "settled"],
  previewing: ["previewing", "committing", "canceling", "settled"],
  committing: ["settled", "canceling"],
  canceling: ["settled"],
  settled: ["idle"],
};

/** Phases in which a session holds the pointer: a second claim on the
 *  pointer is refused (`UXI-INV-001`). A committing session has let the
 *  pointer go; the next press may begin beside it. */
export const POINTER_PHASES: ReadonlySet<InteractionPhase> = new Set([
  "pressed",
  "pending-hit",
  "previewing",
  "canceling",
]);

/**
 * §3.4 — the priority of interaction owners, most specific first. Rank 1
 * (an input method composing) and rank 9 (the browser's default) name no
 * owner: the editor stays out of both. Rank 4 is whichever owner already
 * holds a captured gesture: an active session outranks a new claim of
 * the same or a lower rank.
 */
export const OWNER_PRIORITY: ReadonlyArray<{
  rank: number;
  claim: string;
  owners: readonly InteractionOwner[];
}> = [
  { rank: 1, claim: "os text composition", owners: [] },
  {
    rank: 2,
    claim: "a modal dialog, a menu or a focus trap",
    owners: ["modal"],
  },
  {
    rank: 3,
    claim: "a focused surface that declares its events",
    owners: ["plugin-surface", "panel"],
  },
  { rank: 4, claim: "the existing captured gesture", owners: [] },
  {
    rank: 5,
    claim: "an explicit overlay handle",
    owners: ["canvas-transform", "canvas-path", "ruler-guide"],
  },
  {
    rank: 6,
    claim: "the active nested edit context",
    owners: ["frame-content"],
  },
  {
    rank: 7,
    claim: "the effective tool's gesture handler",
    owners: ["canvas-draw", "canvas-text"],
  },
  {
    rank: 8,
    claim: "canvas selection and navigation",
    owners: ["canvas-select", "canvas-camera", "drag-drop"],
  },
  { rank: 9, claim: "the browser's default", owners: [] },
];

const RANK = new Map<InteractionOwner, number>(
  OWNER_PRIORITY.flatMap((p) => p.owners.map((o) => [o, p.rank] as const)),
);

/** An owner's §3.4 rank (lower wins). */
export function ownerRank(owner: InteractionOwner): number {
  return RANK.get(owner) ?? 8;
}

/** Tools whose gesture transforms what is selected. */
const TRANSFORM_TOOLS = new Set([
  "paged.tool.freeTransform",
  "paged.tool.rotate",
  "paged.tool.scale",
  "paged.tool.shear",
  "paged.tool.page",
  "paged.tool.artboard",
]);
/** Tools whose gesture edits an existing path's points. */
const PATH_TOOLS = new Set([
  "paged.tool.smooth",
  "paged.tool.scissors",
  "paged.tool.directSelect",
]);

/** The owner of a registered tool's gesture (the inventory's table). */
export function ownerOfTool(toolId: string): InteractionOwner {
  if (TRANSFORM_TOOLS.has(toolId)) return "canvas-transform";
  if (PATH_TOOLS.has(toolId)) return "canvas-path";
  if (toolId === "paged.tool.hand" || toolId === "paged.tool.zoom")
    return "canvas-camera";
  return "canvas-draw";
}
