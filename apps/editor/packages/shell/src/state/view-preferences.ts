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

// Guides & Grid preferences (editor ADR 287): the document grid's spacing,
// subdivisions, colour and stacking, and the smart guides' options.
// Illustrator's Preferences ▸ Guides & Grid and ▸ Smart Guides. An editor
// preference, not a document setting: stored in localStorage and read back
// with a shape check (ADR 247), like the unit preference (ADR 245).
//
// The engine snaps to the grid the host draws: `view-settings-sync.tsx`
// sends `gridEvery` / `gridSubdivisions` with the snap settings.

import { useSyncExternalStore } from "react";

import { parseStored, readStoredShape } from "../lib/stored-settings";

export interface ViewPreferences {
  /** "Gridline every", pt. */
  gridEvery: number;
  /** Subdivisions of a gridline (≥ 1); the snap grid is every / this. */
  gridSubdivisions: number;
  /** The gridlines' colour, `#rrggbb`. */
  gridColor: string;
  /** Draw the grid behind the artwork (true) or over it. */
  gridsInBack: boolean;
  /** Smart guides: 45° / 135° construction guides from the path being
   *  drawn. */
  angleGuides: boolean;
  /** One more construction angle (degrees), or null. */
  customAngle: number | null;
  /** Equal-spacing hints and snapping while moving. */
  spacing: boolean;
  /** Rotate snaps to 0/45/90° and the other items' angles. */
  rotateSnap: boolean;
  /** Where two outlines cross is a snap point. */
  intersections: boolean;
  /** Measurement labels on smart guides and the move's dX / dY. */
  measurementLabels: boolean;
  /** Snapping tolerance, screen px. */
  tolerancePx: number;
}

export const DEFAULT_VIEW_PREFERENCES: Readonly<ViewPreferences> = {
  // Illustrator's defaults: a gridline every 72 pt, eight subdivisions.
  gridEvery: 72,
  gridSubdivisions: 8,
  gridColor: "#8fb8ff",
  gridsInBack: true,
  angleGuides: true,
  customAngle: null,
  spacing: true,
  rotateSnap: true,
  intersections: true,
  measurementLabels: true,
  tolerancePx: 4,
};

const STORAGE_KEY = "paged.viewPreferences";

const isPositive = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

const CHECKS = {
  gridEvery: isPositive,
  gridSubdivisions: (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100,
  gridColor: (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v),
  customAngle: (v: unknown) =>
    v === null || (typeof v === "number" && Number.isFinite(v)),
  tolerancePx: isPositive,
};

function stored(): ViewPreferences {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  return readStoredShape(
    parseStored(raw),
    { ...DEFAULT_VIEW_PREFERENCES },
    CHECKS,
  );
}

let current: ViewPreferences | null = null;
const listeners = new Set<() => void>();

/** The preferences in force (the defaults until the user changes one). */
export function viewPreferences(): ViewPreferences {
  if (current === null) current = stored();
  return current;
}

/** Change some preferences; persisted, and every subscriber re-renders. A
 *  value of the wrong shape is ignored. */
export function setViewPreferences(patch: Partial<ViewPreferences>): void {
  const next = readStoredShape(
    { ...viewPreferences(), ...patch },
    { ...viewPreferences() },
    CHECKS,
  );
  const prev = viewPreferences();
  if ((Object.keys(next) as (keyof ViewPreferences)[]).every((k) => next[k] === prev[k])) {
    return;
  }
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private window): the change lasts this session.
  }
  for (const l of [...listeners]) l();
}

/** Re-read the stored preferences (a reload, or a test's fresh storage). */
export function resetViewPreferences(): void {
  current = null;
  for (const l of [...listeners]) l();
}

export function subscribeViewPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The preferences, re-rendering when they change. */
export function useViewPreferences(): ViewPreferences {
  return useSyncExternalStore(
    subscribeViewPreferences,
    viewPreferences,
    viewPreferences,
  );
}

/** The snap grid's step, pt: a gridline every `gridEvery`, divided. */
export function gridStep(prefs: ViewPreferences): number {
  return prefs.gridEvery / Math.max(1, Math.round(prefs.gridSubdivisions));
}
