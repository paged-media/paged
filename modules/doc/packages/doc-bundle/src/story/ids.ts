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

// Doc ADR 630 — the ids of the Story view, the Story Map and their commands,
// apart from the React surfaces so the headless object model can name the
// commands' typed twins (ADR 323).

export const STORY_VIEW_ID = "media.paged.doc.view.story";
export const STORY_MAP_PANEL_ID = "media.paged.doc.panel.storyMap";
const C = "media.paged.doc.command";
export const STORY_VIEW_COMMAND = `${C}.storyView`;
export const STORY_MAP_COMMAND = `${C}.storyMap`;
export const NEXT_OVERSET_COMMAND = `${C}.nextOverset`;

/** The story commands, each also a typed command of the object model. */
export const STORY_COMMANDS = [
  STORY_VIEW_COMMAND,
  STORY_MAP_COMMAND,
  NEXT_OVERSET_COMMAND,
] as const;

/** What a story command did: whether it acted, and the story it showed or
 *  went to (its self id; the typed twins answer its address as `story`). */
export interface StoryCommandResult {
  applied: boolean;
  storyId?: string;
}
