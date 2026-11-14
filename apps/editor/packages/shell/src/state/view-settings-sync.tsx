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
// Since protocol 81 (engine ADR 1306, editor ADR 1212) the view settings
// also carry the screen mode's proof (no page edge, no degraded-asset
// markers) and whether nonprinting items show: the Nonprinting items aid,
// and never in a proof, which shows what prints. Renders nothing.

import { useEffect, useSyncExternalStore } from "react";

import type { SnapSettings } from "@paged-media/client";

import { useBindingProviderHost } from "../catalog/binding-providers";
import type { ShellWorkspaceView } from "../catalog/binding-providers";
import { useCanvasClient } from "./canvas-client-context";
import { isProofMode } from "./editing-aids";
import { useEditorScope, type EditorScope } from "./editor-scope";
import { useOptionalScreenMode } from "./screen-mode-context";
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
    // UXI-GDE-004: hidden guides do not pull geometry. With the Ruler
    // guides aid off nothing shows that a guide is there, so nothing
    // snaps to one (InDesign's rule: guides snap only while shown).
    guides: getViewToggle(scope, "guides"),
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

/** Extensions ADR 340 — the grid and snap state an edit context's own
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
  const proof = isProofMode(useOptionalScreenMode()?.screenMode);
  const showNonprinting = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "nonprinting"),
    () => true,
  );
  const hideNonprinting = proof || !showNonprinting;
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
    void client
      .setViewSettings({ mode, hideNonprinting, proof })
      .catch(() => {});
  }, [client, mode, hideNonprinting, proof]);
  useEffect(() => {
    if (!snapKey) return;
    void client
      .setSnapSettings(JSON.parse(snapKey) as SnapSettings)
      .catch(() => {});
  }, [client, snapKey]);
  return null;
}
