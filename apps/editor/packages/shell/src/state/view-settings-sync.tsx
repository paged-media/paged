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

// Editor ADR 287 — the View menu's state, handed to the engine.
//
// The toggles (`view-toggles.ts`) and the Guides & Grid preferences
// (`view-preferences.ts`) are the editor's; the engine draws the screen in
// the view mode (`setViewSettings`, v77) and snaps every gesture and
// `requestSnapPoint` with the snap settings (`setSnapSettings`). Both are
// session state the worker keeps across document loads, so this sends them
// whenever they change and once on mount — nothing else needs to.
// Renders nothing.

import { useEffect, useSyncExternalStore } from "react";

import type { SnapSettings } from "@paged-media/client";

import { useBindingProviderHost } from "../catalog/binding-providers";
import type { ShellWorkspaceView } from "../catalog/binding-providers";
import { useCanvasClient } from "./canvas-client-context";
import { useEditorScope, type EditorScope } from "./editor-scope";
import {
  gridStep,
  useViewPreferences,
  type ViewPreferences,
} from "./view-preferences";
import {
  getViewToggle,
  subscribeViewToggles,
  viewModeOf,
} from "./view-toggles";

/** The snap settings the View menu and the preferences add up to. */
export function snapSettingsOf(
  scope: EditorScope,
  prefs: ViewPreferences,
): SnapSettings {
  const smart = getViewToggle(scope, "smartGuides");
  return {
    enabled: true,
    tolerancePx: prefs.tolerancePx,
    points: true,
    // Smart guides are the alignment lines through other objects' points
    // and edges, with their spacing / angle / intersection hints.
    alignment: smart,
    segments: true,
    page: true,
    guides: true,
    grid: getViewToggle(scope, "snapToGrid"),
    pixel: getViewToggle(scope, "snapToPixel"),
    // The grid the host draws is the grid that snaps: a step of
    // gridEvery / subdivisions.
    gridEvery: prefs.gridEvery,
    gridSubdivisions: Math.max(1, Math.round(prefs.gridSubdivisions)),
    angleGuides: smart && prefs.angleGuides,
    ...(prefs.customAngle != null ? { customAngle: prefs.customAngle } : {}),
    spacing: smart && prefs.spacing,
    rotate: prefs.rotateSnap,
    intersections: smart && prefs.intersections,
  };
}

/** Extensions ADR 3XX — the grid and snap state an edit context's own
 *  tools snap by (a raster image's marquee, crop and Ruler): the same
 *  grid the host draws over its workspace. */
export function workspaceViewOf(
  scope: EditorScope,
  prefs: ViewPreferences,
): ShellWorkspaceView {
  return {
    showGrid: getViewToggle(scope, "showGrid"),
    snapToGrid: getViewToggle(scope, "snapToGrid"),
    gridEveryPt: prefs.gridEvery,
    gridSubdivisions: Math.max(1, Math.round(prefs.gridSubdivisions)),
    snapTolerancePx: prefs.tolerancePx,
  };
}

/** The snap step the engine uses, pt (tests and the Info read it). */
export function snapGridStep(prefs: ViewPreferences): number {
  return gridStep(prefs);
}

export function ViewSettingsSync() {
  const client = useCanvasClient();
  const scope = useEditorScope();
  const prefs = useViewPreferences();
  const mode = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => viewModeOf(scope),
    () => "preview" as const,
  );
  // One string per distinct settings value: the effect runs when the
  // settings change, not on every render.
  const snapKey = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => JSON.stringify(snapSettingsOf(scope, prefs)),
    () => "",
  );
  const bindings = useBindingProviderHost();
  const workspaceKey = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => JSON.stringify(workspaceViewOf(scope, prefs)),
    () => "",
  );
  useEffect(() => {
    if (!workspaceKey || !bindings?.setWorkspaceView) return;
    bindings.setWorkspaceView(JSON.parse(workspaceKey) as ShellWorkspaceView);
  }, [bindings, workspaceKey]);
  useEffect(() => {
    void client.setViewSettings({ mode }).catch(() => {});
  }, [client, mode]);
  useEffect(() => {
    if (!snapKey) return;
    void client
      .setSnapSettings(JSON.parse(snapKey) as SnapSettings)
      .catch(() => {});
  }, [client, snapKey]);
  return null;
}
