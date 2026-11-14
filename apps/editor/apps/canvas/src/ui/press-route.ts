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

// The canvas's ONE arbitration decision (the interaction specification,
// §4.1 `UXI-OWN-001`, §4.2; editor ADR 1210, IC4): what a press on the
// canvas is, decided once at pointerdown from what the canvas can tell
// then. The answer names the session's owner and the adapter that carries
// the press (§24.2); the move, the release and the cancel then go to that
// route and no other — there is no second reading of who owns the pointer.
//
// The order is the precedence the canvas has always applied (the
// `UXI-MIG-001` tapes hold it), written as a table instead of the order of
// `if`s in four handlers:
//
//   1. a second touch            → a pinch (the camera's, over anything)
//   2. the active edit context   → its content pointer, when it takes them
//                                  and the press is over its frame
//   3. a registered tool         → its gesture handler (the Type tool also
//                                  keeps the click: caret, word, line)
//   4. a bundle's handle         → that bundle (Selection tool)
//   5. path edit                 → the path's session (Selection tool)
//   6. the middle button, the Hand, the Zoom tool, a filler's touch
//                                → the camera
//   7. otherwise                 → the Selection or Type tool's legacy path
//                                  (handles, a move, a press, a marquee, a
//                                  click)

import type { InteractionOwner } from "@paged-media/shell";

/** What the canvas knows at a press. */
export interface PressFacts {
  /** 0 primary, 1 middle. */
  button: number;
  pointerType: string;
  /** Another touch is already down. */
  secondTouch: boolean;
  /** The active edit context takes content pointers and the press is over
   *  its frame (and the tool in hand is not one shared across contexts). */
  overContent: boolean;
  /** A registered tool's gesture handler is in hand. */
  toolGesture: boolean;
  /** That tool also keeps the click on the legacy path (the Type tool). */
  legacyAlso: boolean;
  /** A bundle's handle is under the press. */
  bundleHandle: boolean;
  /** Path edit mode is on and can read the press. */
  pathEdit: boolean;
  /** The Hand (or Space), a preview canvas. */
  forcePan: boolean;
  /** The Zoom tool (or Cmd+Space). */
  zoomClick: boolean;
  /** A filler or a viewer: one finger pans. */
  touchPans: boolean;
  /** The legacy tool in hand. */
  tool: "select" | "text";
}

export type PressRouteKind =
  | "pinch"
  | "content"
  | "tool"
  | "type"
  | "bundle-handle"
  | "path-edit"
  | "camera"
  | "legacy";

export type PressAdapter =
  | "CameraNavigationAdapter"
  | "ContentContextAdapter"
  | "RegisteredGestureAdapter"
  | "LegacySelectionAdapter";

export interface PressRoute {
  kind: PressRouteKind;
  /** The session's owner (§3.2), when the route decides it. The legacy
   *  route's owner follows what its press turns out to be. */
  owner: InteractionOwner | null;
  adapter: PressAdapter;
}

/** The route of a press (see the table above). */
export function routePress(f: PressFacts): PressRoute {
  if (f.pointerType === "touch" && f.secondTouch)
    return {
      kind: "pinch",
      owner: "canvas-camera",
      adapter: "CameraNavigationAdapter",
    };
  const primary = f.button === 0;
  if (primary && f.overContent)
    return {
      kind: "content",
      owner: "frame-content",
      adapter: "ContentContextAdapter",
    };
  if (primary && f.toolGesture)
    return f.legacyAlso
      ? {
          kind: "type",
          owner: "canvas-text",
          adapter: "RegisteredGestureAdapter",
        }
      : { kind: "tool", owner: null, adapter: "RegisteredGestureAdapter" };
  const touchPan = f.touchPans && f.pointerType === "touch";
  const camera = f.button === 1 || f.forcePan || f.zoomClick || touchPan;
  if (primary && f.tool === "select" && !camera) {
    if (f.bundleHandle)
      return {
        kind: "bundle-handle",
        owner: "canvas-transform",
        adapter: "LegacySelectionAdapter",
      };
    if (f.pathEdit)
      return {
        kind: "path-edit",
        owner: "canvas-path",
        adapter: "LegacySelectionAdapter",
      };
  }
  if (camera)
    return {
      kind: "camera",
      owner: "canvas-camera",
      adapter: "CameraNavigationAdapter",
    };
  return { kind: "legacy", owner: null, adapter: "LegacySelectionAdapter" };
}
