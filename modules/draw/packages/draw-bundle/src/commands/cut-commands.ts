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

// The three TOOL-ONLY cuts as commands (plan G4): the Knife, Scissors at
// any point and the Shape Builder, each with its gesture given as data —
// so a script, the CLI and `host.objects.invoke` reach them through their
// typed twins. Each runs exactly the tool's own code on the SELECTION
// (the twins select their `targets` first) and lands as the tool's one
// undo step. A cut that does nothing throws `failed: <why>`, so a caller
// is never left guessing.
//
//   knife       { page, cut: [[x, y], …] }        page pt; page "" = the
//                                                 first selected item's
//   scissorsAt  { point: [x, y], tolerance }      the one selected path
//   shapeBuild  { path: [[x, y], …], mode }       keep (merge) / remove

import type {
  BundleHost,
  Disposable,
  ElementId,
} from "@paged-media/plugin-api";

import { applyKnife } from "./knife";
import { selectionTopToBottom } from "./pathfinder-region";
import { applyScissorsAt } from "../handlers/scissors";
import { applyShapeBuild } from "../handlers/shape-builder";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

/** Command titles, message keys `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.cut", {
  knife: "Knife along a polyline",
  scissors: "Cut the selected path at a point",
  shapeBuilder: "Shape Builder along a path",
});

export const KNIFE_COMMAND_ID = "media.paged.draw.command.knife";
export const SCISSORS_AT_COMMAND_ID = "media.paged.draw.command.scissorsAt";
export const SHAPE_BUILD_COMMAND_ID = "media.paged.draw.command.shapeBuild";
export const CUT_COMMAND_CATEGORY = "Path";
export const CUT_COMMAND_IDS = [
  KNIFE_COMMAND_ID,
  SCISSORS_AT_COMMAND_ID,
  SHAPE_BUILD_COMMAND_ID,
] as const;

type Pt = [number, number];

const pointsOf = (v: unknown): Pt[] =>
  Array.isArray(v)
    ? v.filter(
        (p): p is Pt =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every((n) => typeof n === "number" && Number.isFinite(n)),
      )
    : [];

const payloadOf = (p: unknown): Record<string, unknown> =>
  p && typeof p === "object" ? (p as Record<string, unknown>) : {};

const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

/** The page an item sits on (the knife's `page: ""`). */
async function pageOf(host: BundleHost, id: ElementId): Promise<string | null> {
  const read = await host.document.pathAnchors(id).catch(() => null);
  if (read?.pageId) return read.pageId;
  const [g] = await host.document.elementGeometry([id]).catch(() => []);
  return g?.pageId ?? null;
}

export async function runKnife(
  host: BundleHost,
  payload: unknown,
): Promise<{ cut: number; pieces: number }> {
  const p = payloadOf(payload);
  const cut = pointsOf(p.cut);
  if (cut.length < 2) failed("a cut is at least two points");
  let page = typeof p.page === "string" ? p.page : "";
  if (page === "") {
    const [first] = host.selection.get();
    page = (first && (await pageOf(host, first))) || "";
  }
  if (page === "") failed("name the page, or select what to cut");
  const r = await applyKnife(host, page, cut);
  if (r.cut.length === 0)
    failed(
      r.skipped.map((s) => `${String(s.id.id)}: ${s.reason}`).join("; ") ||
        "the cut divides no closed path",
    );
  return { cut: r.cut.length, pieces: r.pieces.length };
}

export async function runScissorsAt(
  host: BundleHost,
  payload: unknown,
): Promise<{ cut: string }> {
  const p = payloadOf(payload);
  const [point] = pointsOf([p.point]);
  if (!point) failed("a cut needs a point");
  const selection = host.selection.get();
  if (selection.length !== 1) failed("select the one path to cut");
  const target = selection[0]!;
  const page = (await pageOf(host, target)) ?? "";
  const tolerance =
    typeof p.tolerance === "number" && p.tolerance > 0 ? p.tolerance : 1;
  const r = await applyScissorsAt(host, target, page, point!, tolerance);
  if (!r) failed(`the point is on no cuttable segment of ${String(target.id)}`);
  return { cut: String(target.id) };
}

export async function runShapeBuild(
  host: BundleHost,
  payload: unknown,
): Promise<null> {
  const p = payloadOf(payload);
  const operands = await selectionTopToBottom(host);
  const page = operands[0] ? ((await pageOf(host, operands[0])) ?? "") : "";
  const r = await applyShapeBuild(
    host,
    operands,
    pointsOf(p.path),
    p.mode === "remove" ? "remove" : "keep",
    page,
  );
  if (!r.applied) failed(r.reason);
  return null;
}

/** A typed call (with a payload) fails loudly; the palette's bare invoke
 *  cannot supply the points a cut needs, so it logs why and does nothing. */
const fromPalette =
  <T>(host: BundleHost, id: string, run: (payload: unknown) => Promise<T>) =>
  async (_paged: unknown, payload: unknown): Promise<T | null> => {
    if (payload !== undefined) return run(payload);
    try {
      return await run(payload);
    } catch (e) {
      host.log.info(`${id}: ${String(e)}`);
      return null;
    }
  };

export function contributeCutCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: KNIFE_COMMAND_ID,
      title: M.knife,
      category: CUT_COMMAND_CATEGORY,
      handler: fromPalette(host, KNIFE_COMMAND_ID, (p) => runKnife(host, p)),
    }),
    registerCommand(host, {
      id: SCISSORS_AT_COMMAND_ID,
      title: M.scissors,
      category: CUT_COMMAND_CATEGORY,
      handler: fromPalette(host, SCISSORS_AT_COMMAND_ID, (p) =>
        runScissorsAt(host, p),
      ),
    }),
    registerCommand(host, {
      id: SHAPE_BUILD_COMMAND_ID,
      title: M.shapeBuilder,
      category: CUT_COMMAND_CATEGORY,
      handler: fromPalette(host, SHAPE_BUILD_COMMAND_ID, (p) =>
        runShapeBuild(host, p),
      ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
