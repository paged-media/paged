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

// The v30 kernel PATH OPS as commands — Outline Stroke / Offset Path /
// Simplify Path over the selection (the dash.ts command pattern; all
// three ops are on the wire and engine-classified "supported" by the
// editor's capability matrix).
//
// UNITS (documented here, asserted in conformance):
//   · outlineStroke `width`      — pt (the stroke weight to outline)
//   · offsetPath    `delta`      — pt (positive grows outward,
//                                  negative shrinks)
//   · simplifyPath  `tolerance`  — pt (max deviation a removed anchor
//                                  may introduce — RDP semantics)
//   · `miterLimit`               — the usual unitless ratio
//   · `cap`  ∈ "butt" | "round" | "square"
//   · `join` ∈ "miter" | "round" | "bevel"
//
// PARAMETERS: each command accepts an optional payload object
// overriding the defaults (`host.contribute.command` handlers receive
// `(paged, payload)`); Outline Stroke additionally reads the element's
// OWN stroke weight / end-cap / join / miter limit from the typed
// elementProperties door, so the outline matches what is rendered —
// the payload then overrides per key.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";

export const PATH_OPS_COMMAND_CATEGORY = "Path";

export const OUTLINE_STROKE_COMMAND_ID =
  "media.paged.draw.command.outlineStroke";
export const OFFSET_PATH_COMMAND_ID = "media.paged.draw.command.offsetPath";
export const SIMPLIFY_PATH_COMMAND_ID =
  "media.paged.draw.command.simplifyPath";

/** The contributed command ids, in registration order. */
export const PATH_OPS_COMMAND_IDS = [
  OUTLINE_STROKE_COMMAND_ID,
  OFFSET_PATH_COMMAND_ID,
  SIMPLIFY_PATH_COMMAND_ID,
];

export type StrokeCapToken = "butt" | "round" | "square";
export type StrokeJoinToken = "miter" | "round" | "bevel";

/** Sensible defaults (units above). */
export const DEFAULT_OUTLINE_WIDTH_PT = 1;
export const DEFAULT_OFFSET_DELTA_PT = 6;
export const DEFAULT_SIMPLIFY_TOLERANCE_PT = 1;
export const DEFAULT_MITER_LIMIT = 4;

export interface OutlineStrokeParams {
  width: number;
  cap: StrokeCapToken;
  join: StrokeJoinToken;
  miterLimit: number;
}

export interface OffsetPathParams {
  delta: number;
  join: StrokeJoinToken;
  miterLimit: number;
}

/** The four path-bearing kinds the topology ops accept (the same set
 *  the anchor tools edit). */
function supportsPathOps(id: ElementId): boolean {
  return (
    id.kind === "polygon" ||
    id.kind === "rectangle" ||
    id.kind === "textFrame" ||
    id.kind === "graphicLine"
  );
}

// ---------------------------------------------------------- builders
// Exported so the conformance specs assert the EXACT wire shape each
// command emits (no second copy to drift from).

export function outlineStrokeMutationFor(
  elementId: ElementId,
  params: OutlineStrokeParams,
): Mutation {
  return {
    op: "outlineStroke",
    args: {
      elementId,
      width: params.width,
      cap: params.cap,
      join: params.join,
      miterLimit: params.miterLimit,
    },
  };
}

export function offsetPathMutationFor(
  elementId: ElementId,
  params: OffsetPathParams,
): Mutation {
  return {
    op: "offsetPath",
    args: {
      elementId,
      delta: params.delta,
      join: params.join,
      miterLimit: params.miterLimit,
    },
  };
}

export function simplifyPathMutationFor(
  elementId: ElementId,
  tolerance: number,
): Mutation {
  return { op: "simplifyPath", args: { elementId, tolerance } };
}

// ---------------------------------------------------- payload parsing

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const capToken = (v: unknown): StrokeCapToken | undefined =>
  v === "butt" || v === "round" || v === "square" ? v : undefined;

const joinToken = (v: unknown): StrokeJoinToken | undefined =>
  v === "miter" || v === "round" || v === "bevel" ? v : undefined;

/** Map the IDML end-cap / join tokens the typed property door reads
 *  (`frameStrokeEndCap` / `frameStrokeJoin`) onto the kernel-op vocab. */
function capFromIdml(token: string): StrokeCapToken | undefined {
  if (token === "ButtEndCap") return "butt";
  if (token === "RoundEndCap") return "round";
  if (token === "ProjectingEndCap") return "square";
  return undefined;
}
function joinFromIdml(token: string): StrokeJoinToken | undefined {
  if (token.startsWith("Miter")) return "miter";
  if (token.startsWith("Round")) return "round";
  if (token.startsWith("Bevel")) return "bevel";
  return undefined;
}

/** Read the element's OWN stroke attributes so Outline Stroke outlines
 *  what is rendered. Unreadable values fall to the defaults — never a
 *  throw. */
export async function outlineParamsOf(
  host: BundleHost,
  id: ElementId,
): Promise<OutlineStrokeParams> {
  const params: OutlineStrokeParams = {
    width: DEFAULT_OUTLINE_WIDTH_PT,
    cap: "butt",
    join: "miter",
    miterLimit: DEFAULT_MITER_LIMIT,
  };
  try {
    const props = await host.document.elementProperties(id);
    for (const entry of props?.entries ?? []) {
      const v = entry.value;
      if (!v) continue;
      if (
        entry.path === "frameStrokeWeight" &&
        v.type === "length" &&
        v.value !== null &&
        v.value > 0
      ) {
        params.width = v.value;
      } else if (entry.path === "frameStrokeEndCap" && v.type === "text") {
        params.cap = capFromIdml(v.value) ?? params.cap;
      } else if (entry.path === "frameStrokeJoin" && v.type === "text") {
        params.join = joinFromIdml(v.value) ?? params.join;
      } else if (
        entry.path === "frameStrokeMiterLimit" &&
        v.type === "length" &&
        v.value !== null &&
        v.value > 0
      ) {
        params.miterLimit = v.value;
      }
    }
  } catch {
    /* defaults stand */
  }
  return params;
}

// ------------------------------------------------------------ appliers

type PathOpPayload = Record<string, unknown> | undefined;

function pathTargets(host: BundleHost, commandId: string): ElementId[] {
  const targets = host.selection.get().filter(supportsPathOps);
  if (targets.length === 0) {
    host.log.debug(`${commandId}: no path-bearing selection — no-op`);
  }
  return targets;
}

async function commitEach(
  host: BundleHost,
  commandId: string,
  mutations: Mutation[],
): Promise<void> {
  for (const mutation of mutations) {
    const outcome = await host.document.mutate(mutation);
    if (!outcome.applied) {
      host.log.warn(
        `${commandId} rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
}

/** Outline Stroke: per element, the element's own stroke attributes
 *  (typed property reads) with per-key payload overrides
 *  `{ width?, cap?, join?, miterLimit? }`. */
export async function applyOutlineStroke(
  host: BundleHost,
  payload?: PathOpPayload,
): Promise<void> {
  const targets = pathTargets(host, OUTLINE_STROKE_COMMAND_ID);
  const mutations: Mutation[] = [];
  for (const id of targets) {
    const own = await outlineParamsOf(host, id);
    mutations.push(
      outlineStrokeMutationFor(id, {
        width: num(payload?.width) ?? own.width,
        cap: capToken(payload?.cap) ?? own.cap,
        join: joinToken(payload?.join) ?? own.join,
        miterLimit: num(payload?.miterLimit) ?? own.miterLimit,
      }),
    );
  }
  await commitEach(host, OUTLINE_STROKE_COMMAND_ID, mutations);
}

/** Offset Path: defaults `{ delta: 6 pt, join: "miter", miterLimit: 4 }`,
 *  payload overrides `{ delta?, join?, miterLimit? }` (negative delta
 *  shrinks). */
export async function applyOffsetPath(
  host: BundleHost,
  payload?: PathOpPayload,
): Promise<void> {
  const params: OffsetPathParams = {
    delta: num(payload?.delta) ?? DEFAULT_OFFSET_DELTA_PT,
    join: joinToken(payload?.join) ?? "miter",
    miterLimit: num(payload?.miterLimit) ?? DEFAULT_MITER_LIMIT,
  };
  await commitEach(
    host,
    OFFSET_PATH_COMMAND_ID,
    pathTargets(host, OFFSET_PATH_COMMAND_ID).map((id) =>
      offsetPathMutationFor(id, params),
    ),
  );
}

/** Simplify Path: default tolerance 1 pt, payload `{ tolerance? }`. */
export async function applySimplifyPath(
  host: BundleHost,
  payload?: PathOpPayload,
): Promise<void> {
  const tolerance =
    num(payload?.tolerance) ?? DEFAULT_SIMPLIFY_TOLERANCE_PT;
  await commitEach(
    host,
    SIMPLIFY_PATH_COMMAND_ID,
    pathTargets(host, SIMPLIFY_PATH_COMMAND_ID).map((id) =>
      simplifyPathMutationFor(id, tolerance),
    ),
  );
}

/** Register the three path-op commands (the dash-command pattern);
 *  payload rides through to the applier. */
export function contributePathOpsCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: OUTLINE_STROKE_COMMAND_ID,
      title: "Path: Outline stroke",
      category: PATH_OPS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyOutlineStroke(host, payload as PathOpPayload),
    }),
    host.contribute.command({
      id: OFFSET_PATH_COMMAND_ID,
      title: "Path: Offset path",
      category: PATH_OPS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyOffsetPath(host, payload as PathOpPayload),
    }),
    host.contribute.command({
      id: SIMPLIFY_PATH_COMMAND_ID,
      title: "Path: Simplify",
      category: PATH_OPS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySimplifyPath(host, payload as PathOpPayload),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
