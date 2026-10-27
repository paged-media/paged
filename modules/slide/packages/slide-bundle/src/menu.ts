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

// paged.slide — the menu bar entries (`contribute.menu()`).
//
// The two file verbs go in the host's File menu beside the formats it opens
// and exports (File ▸ Open PDF…, File ▸ Export PDF…): opening a deck
// REPLACES the document, which is what File ▸ Open means, and the export
// writes a file. The slide verbs go in a `Slide` menu of the plugin's own,
// which the bar folds into Plugins ▸ Slide beside the panels.
//
// An entry is greyed where its command does not apply (the command's
// `when`, which the SDK's menu scope consults): the slide verbs outside a
// deck, Delete on the last slide, Move up on the first, Move down on the
// last. Every entry also needs an open document (the SDK's scope).

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

import { COMMAND_PREFIX } from "./commands.js";

/** `[path, command suffix, group, order]`; the File entries' orders place
 *  them after the host's Open PDF… (15) and Export PDF… (58). */
const ENTRIES: [path: string, suffix: string, group: string, order: number][] =
  [
    ["File/Open PowerPoint deck…", "importPptx", "open", 16],
    ["File/Export PowerPoint deck…", "exportPptx", "produce", 59],
    ["Slide/New slide", "newSlide", "slide", 10],
    ["Slide/Duplicate slide", "duplicateSlide", "slide", 20],
    ["Slide/Delete slide", "deleteSlide", "slide", 30],
    ["Slide/Move slide up", "moveSlideUp", "order", 10],
    ["Slide/Move slide down", "moveSlideDown", "order", 20],
    ["Slide/Previous slide", "previousSlide", "navigate", 10],
    ["Slide/Next slide", "nextSlide", "navigate", 20],
    ["Slide/New comment", "addComment", "comment", 10],
    // Insert is the host's menu: Insert ▸ Shapes… opens the Shapes panel.
    ["Insert/Shapes…", "insertShapes", "objects", 40],
  ];

/** Register an entry for each of `registered` (the command ids the bundle
 *  registered on this host); one Disposable drops them all. */
export function contributeMenu(
  host: BundleHost,
  registered: (id: string) => boolean,
): Disposable {
  const handles: Disposable[] = [];
  for (const [path, suffix, group, order] of ENTRIES) {
    const command = `${COMMAND_PREFIX}.${suffix}`;
    if (!registered(command)) continue;
    handles.push(host.contribute.menu({ path, command, group, order }));
  }
  host.log.info(`contributed ${handles.length} menu entries`);
  return {
    dispose() {
      for (const h of handles.splice(0)) h.dispose();
    },
  };
}

/** Exported for the bundle's own test. */
export const MENU_ENTRIES = ENTRIES;
