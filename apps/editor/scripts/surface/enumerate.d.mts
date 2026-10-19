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

// Types for the surface gate's enumeration (enumerate.mjs), for the
// TypeScript tests that check it against the live registrations.

export interface SurfaceItem {
  kind:
    | "command"
    | "panel"
    | "tool"
    | "menu"
    | "keybinding"
    | "setting"
    | "cli"
    | "script"
    | "importer"
    | "exporter";
  id: string;
  origin: "host" | "plugin";
  owner: string;
  source?: string;
  /** Menu items and keybindings: the command they run. */
  command?: string;
  family?: boolean;
  members?: string[];
}

export interface SurfaceBundle {
  name: string;
  dir: string | null;
  id?: string;
  counts?: Record<string, number>;
}

export interface Surface {
  items: SurfaceItem[];
  families: {
    kind: string;
    id: string;
    members: string[];
    sources: string[];
  }[];
  unresolved: { kind: string; at: string; file: string; pattern?: string }[];
  sentinels: [what: string, got: number, floor: number][];
  bundles: SurfaceBundle[];
  plumbing: { kind: string; id: string; owner: string; source: string }[];
  settingsInventory: number | null;
  notes: string[];
  parseErrors: string[];
}

export function enumerateSurface(root: string): Surface;
