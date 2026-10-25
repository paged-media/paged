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

// THE LIQUIFY FAMILY as a command — `liquifyStroke { kind, path, … }`:
// the tool's gesture as data (a press at `path[0]`, a move per point, a
// release at the last), run through the SAME machine the tool drives
// (draw-tools `LiquifyMachine`) over the same targets (the selection's
// paths on the page, or every path on it when nothing is selected), and
// written the same way: every path the brush changed, re-fitted, in ONE
// batch — one undo step. This is what the CLI, scripting and the
// headless specs run; the tool (`handlers/liquify.ts`) adds only the
// live preview, the dwell timer and the pointer.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { LIQUIFY_KINDS, type LiquifyKind } from "@paged-media/draw-geometry";
import {
  LIQUIFY_DEFAULTS,
  LiquifyMachine,
  type LiquifyToolOptions,
} from "@paged-media/draw-tools";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import {
  distortTargetsOn,
  failed,
  numberOr,
  payloadOf,
  pointsOf,
  writeDistorted,
  type DistortTarget,
  type Pt,
} from "./distort-shared";
import { resolveTargetPage } from "../io/svg";

const M = defineMessages("draw.liquify", {
  stroke: "Liquify along a path",
});

export const LIQUIFY_STROKE_COMMAND_ID =
  "media.paged.draw.command.liquifyStroke";
export const LIQUIFY_COMMAND_IDS = [LIQUIFY_STROKE_COMMAND_ID] as const;

export interface LiquifyResult {
  /** How many paths the stroke changed (and wrote). */
  changed: number;
  applied: boolean;
}

/** Run one liquify drag along `path` (page pt) over `targets`; write the
 *  changed paths in one batch. */
export async function applyLiquifyStroke(
  host: BundleHost,
  targets: readonly DistortTarget[],
  options: LiquifyToolOptions,
  path: readonly Pt[],
): Promise<LiquifyResult> {
  if (path.length === 0 || targets.length === 0)
    return { changed: 0, applied: false };
  const machine = new LiquifyMachine({
    options,
    targets: targets.map((t) => t.page),
  });
  machine.handle({ type: "down", point: path[0]! });
  for (const p of path.slice(1, -1)) machine.handle({ type: "move", point: p });
  const snap = machine.handle({ type: "up", point: path[path.length - 1]! });
  if (!snap.commit) return { changed: 0, applied: false };
  const applied = await writeDistorted(
    host,
    "liquify",
    snap.commit.map((c) => ({ target: targets[c.index]!, page: c.table })),
  );
  return { changed: applied ? snap.commit.length : 0, applied };
}

const bool = (v: unknown, d: boolean): boolean =>
  typeof v === "boolean" ? v : d;

/** The tool options a payload names, over Illustrator's defaults. */
export function liquifyOptionsFrom(
  p: Record<string, unknown>,
): LiquifyToolOptions {
  const kind = LIQUIFY_KINDS.includes(p.kind as LiquifyKind)
    ? (p.kind as LiquifyKind)
    : failed(`kind is one of ${LIQUIFY_KINDS.join(", ")}`);
  const d = LIQUIFY_DEFAULTS;
  return {
    kind,
    width: Math.max(1, numberOr(p.width, d.width)),
    height: Math.max(1, numberOr(p.height, d.height)),
    angle: numberOr(p.angle, d.angle),
    intensity: Math.max(0, Math.min(100, numberOr(p.intensity, d.intensity))),
    usePressure: false,
    detail: Math.max(1, Math.min(10, numberOr(p.detail, d.detail))),
    simplify: Math.max(0.2, Math.min(100, numberOr(p.simplify, d.simplify))),
    twirlRate: Math.max(
      -180,
      Math.min(180, numberOr(p.twirlRate, d.twirlRate)),
    ),
    complexity: Math.max(0, Math.min(15, numberOr(p.complexity, d.complexity))),
    horizontal: Math.max(
      0,
      Math.min(100, numberOr(p.horizontal, d.horizontal)),
    ),
    vertical: Math.max(0, Math.min(100, numberOr(p.vertical, d.vertical))),
    affectAnchors: bool(p.affectAnchors, d.affectAnchors),
    affectIn: bool(p.affectIn, d.affectIn),
    affectOut: bool(p.affectOut, d.affectOut),
    seed: numberOr(p.seed, 0),
  };
}

export async function runLiquifyStroke(
  host: BundleHost,
  payload: unknown,
): Promise<{ changed: number }> {
  const p = payloadOf(payload);
  const options = liquifyOptionsFrom(p);
  const path = pointsOf(p.path);
  if (path.length === 0) failed("a liquify stroke is at least one point");
  let page = typeof p.page === "string" ? p.page : "";
  if (page === "") {
    const [first] = host.selection.get();
    if (first) {
      const read = await host.document.pathAnchors(first).catch(() => null);
      page = read?.pageId ?? "";
    }
  }
  if (page === "") page = (await resolveTargetPage(host)) ?? "";
  if (page === "") failed("name the page, or select the paths");
  const targets = await distortTargetsOn(host, page, {
    allWhenNoneSelected: true,
  });
  if (targets.length === 0) failed("there is no path to distort on the page");
  const r = await applyLiquifyStroke(host, targets, options, path);
  if (!r.applied) failed("the stroke touches no path");
  return { changed: r.changed };
}

export function contributeLiquifyCommands(host: BundleHost): Disposable {
  return registerCommand(host, {
    id: LIQUIFY_STROKE_COMMAND_ID,
    title: M.stroke,
    category: "Path",
    handler: async (_paged, payload) => {
      if (payload !== undefined) return runLiquifyStroke(host, payload);
      // From the palette there is no stroke to run: the tool is the way.
      host.log.info(
        `${LIQUIFY_STROKE_COMMAND_ID}: pick a Liquify tool and drag over the artwork`,
      );
      return null;
    },
  });
}
