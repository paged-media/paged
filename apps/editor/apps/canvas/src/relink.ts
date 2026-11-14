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

// Relink a placed picture to a file the user picks (engine ADR 1308): the
// one path the Links panel's Relink… and Publication health's Relink fix
// share. The frame keeps its box, its fitting and the picture's size on the
// page; the link names the picked file (`file:///<name>`) and carries its
// bytes, which the editor has and the engine cannot fetch. One undo step.

import type { PagedEditor } from "@paged-media/shell";

import { pickFiles, type PickedFile } from "./shell-file-picker";

/** What a relink picker accepts: the picture formats the engine reads. */
export const RELINK_ACCEPT: readonly string[] = [
  "image/*",
  ".tif",
  ".tiff",
  ".psd",
  ".psb",
];

/** Relink the picture of the graphic frame `elementId` to `file`. True
 *  when the engine applied it. */
export async function relinkToFile(
  paged: PagedEditor,
  elementId: string,
  file: PickedFile,
): Promise<boolean> {
  const reply = await paged.client.mutateWithBytes(
    {
      op: "relinkImage",
      args: { elementId, uri: `file:///${file.name}`, bytes: [] },
    },
    file.bytes,
  );
  return reply.kind === "mutationApplied";
}

/** Ask for a file and relink `elementId`'s picture to it. False when the
 *  user cancelled or the engine refused. */
export async function relinkFromPicker(
  paged: PagedEditor,
  elementId: string,
): Promise<boolean> {
  const [file] = await pickFiles({ accept: RELINK_ACCEPT });
  if (!file) return false;
  return relinkToFile(paged, elementId, file);
}
