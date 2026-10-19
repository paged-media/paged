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

// Keyboard focus for the editor (ADR 234): who owns a key, focus scopes
// for dialogs, roving tabindex for toolbars, and the canvas's keyboard
// surfaces.

export {
  CANVAS_SURFACE_ATTR,
  KEY_OWNING_CONTAINERS,
  WIDGET_KEYS,
  WIDGET_KEY_OWNERS,
  canvasKeyYields,
  canvasSurfaceOf,
  insideKeyOwningContainer,
  isActivatable,
  isCanvasSurface,
  isComposingKey,
  isFormField,
  type KeyOwnershipEvent,
} from "./key-ownership";
export {
  FocusScope,
  useFocusScope,
  type FocusScopeHandle,
  type FocusScopeProps,
} from "./FocusScope";
export {
  RovingFocusGroup,
  useRovingFocus,
  type RovingFocusOptions,
  type RovingFocusProps,
  type RovingOrientation,
} from "./roving-focus";
export { tabbableElements } from "./tabbable";
export {
  canvasHasPointerFocus,
  canvasViewport,
  canvasViewportSurfaceProps,
  focusCanvasViewport,
} from "./canvas-surface";
