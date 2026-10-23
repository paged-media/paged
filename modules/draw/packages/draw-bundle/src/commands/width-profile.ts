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

// THE WIDTH PROFILE as a command (plan G4): what the Width tool bakes on
// release, with the profile given as data — so a script, the CLI and
// `host.objects.invoke` reach it through its typed twin, and the Path
// Options panel's "Width profile" section types one.
//
//   widthProfile  { widths: [pt, …] }
//
// `widths` are FULL stroke widths at evenly spaced stops along the path,
// start to end, by arc length (the engine's `outlineStrokeVariable`
// reads them so): one width is a uniform stroke, `[0, 8, 0]` swells in
// the middle and tapers to points at both ends. Each selected
// single-contour OPEN path is replaced by its outline at that profile —
// destructive, as the tool's bake is — and the whole selection is ONE
// batch and one undo step. Closed and compound paths are skipped (the
// engine's kernel outlines one open contour); when nothing selected can
// take a profile, or the engine refuses, the command throws
// `failed: <why>`, so a caller is never left guessing.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";

import { oneBatchFor } from "./batch-handles";
import { supportsPathOps } from "./path-ops";
import { outlineStrokeVariableMutationFor } from "../handlers/brush";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

/** The command title, a message key `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.widthProfile", {
  command: "Apply a width profile to the selected open paths",
});

export const WIDTH_PROFILE_COMMAND_ID = "media.paged.draw.command.widthProfile";
export const WIDTH_PROFILE_COMMAND_CATEGORY = "Path";
export const WIDTH_PROFILE_COMMAND_IDS = [WIDTH_PROFILE_COMMAND_ID] as const;

/** The most stops a profile may carry (a pressure stroke is bounded far
 *  below this; the cap keeps a scripted list from flooding the wire). */
export const WIDTH_PROFILE_MAX_STOPS = 256;

const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

/** The profile a payload names, validated: a non-empty list of finite
 *  widths ≥ 0, at most {@link WIDTH_PROFILE_MAX_STOPS}, not all zero.
 *  Throws `failed:` with the reason otherwise. Pure. */
export function widthProfileOf(payload: unknown): number[] {
  const raw =
    payload && typeof payload === "object"
      ? (payload as { widths?: unknown }).widths
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    failed("a width profile is a list of at least one width");
  const widths = raw as unknown[];
  if (widths.length > WIDTH_PROFILE_MAX_STOPS)
    failed(`a width profile has at most ${WIDTH_PROFILE_MAX_STOPS} stops`);
  if (!widths.every((w) => typeof w === "number" && Number.isFinite(w)))
    failed("every width is a number");
  const out = widths as number[];
  if (out.some((w) => w < 0)) failed("a width is never negative");
  if (out.every((w) => w === 0)) failed("a profile of zero widths has no area");
  return [...out];
}

/** Can `id` take a width profile — a single-contour OPEN path? */
async function profilable(host: BundleHost, id: ElementId): Promise<boolean> {
  const table = await host.document.pathAnchors(id).catch(() => null);
  if (!table || table.anchors.length < 2) return false;
  return (
    Math.max(1, table.subpathStarts.length) === 1 &&
    table.subpathOpen?.[0] === true
  );
}

/** Outline every selected single-contour open path at `widths`, in one
 *  batch. Answers how many paths were outlined. */
export async function applyWidthProfile(
  host: BundleHost,
  payload: unknown,
): Promise<{ outlined: number }> {
  const widths = widthProfileOf(payload);
  const paths = host.selection.get().filter(supportsPathOps);
  if (paths.length === 0) failed("select an open path");
  const targets: ElementId[] = [];
  for (const id of paths) if (await profilable(host, id)) targets.push(id);
  if (targets.length === 0)
    failed(
      "a width profile needs a single-contour open path; the selection has " +
        "only closed or compound ones",
    );
  const mutations: Mutation[] = targets.map((id) =>
    outlineStrokeVariableMutationFor(id, widths),
  );
  const outcome = await host.document.mutate(
    mutations.length === 1 ? mutations[0]! : oneBatchFor(mutations),
  );
  if (!outcome.applied)
    failed(`the engine refused the profile: ${JSON.stringify(outcome.error)}`);
  return { outlined: targets.length };
}

/** Register the command. Run with a payload it applies that profile; run
 *  BARE (a menu row, the command palette) it runs `bare` — activate passes
 *  the Path Options panel's Width profile section, which asks for the
 *  widths (or, on a host that cannot raise a panel, applies the profile
 *  last applied there). */
export function contributeWidthProfileCommands(
  host: BundleHost,
  bare?: () => Promise<unknown>,
): Disposable {
  return registerCommand(host, {
    id: WIDTH_PROFILE_COMMAND_ID,
    title: M.command,
    category: WIDTH_PROFILE_COMMAND_CATEGORY,
    handler: (_paged, payload) =>
      payload === undefined && bare ? bare() : applyWidthProfile(host, payload),
  });
}
