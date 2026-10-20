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

// The demo guide's per-viewer layout: collapsed or open, which corner it
// sits in, and whether the script is shown. A convenience only: storage
// that throws or comes back empty (a private window, blocked site data)
// leaves the defaults.

export type GuideSide = "left" | "right";

export interface GuidePrefs {
  collapsed: boolean;
  side: GuideSide;
  script: boolean;
}

export const GUIDE_PREFS_KEY = "paged.demoGuide.v1";

/** What this viewer chose last time; fields that were never stored, or
 *  that do not parse, are absent. */
export function readGuidePrefs(): Partial<GuidePrefs> {
  try {
    const raw = localStorage.getItem(GUIDE_PREFS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<GuidePrefs> = {};
    if (typeof v.collapsed === "boolean") out.collapsed = v.collapsed;
    if (v.side === "left" || v.side === "right") out.side = v.side;
    if (typeof v.script === "boolean") out.script = v.script;
    return out;
  } catch {
    return {};
  }
}

export function writeGuidePrefs(prefs: GuidePrefs): void {
  try {
    localStorage.setItem(GUIDE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage refused: the choice lasts for this page only.
  }
}
