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

export { createViewer, ViewerError } from "./viewer.js";
export { createSessionFromBundledWasm } from "./bootstrap.js";
export type {
  CreateViewerOptions,
  LayoutMode,
  Viewer,
  ViewerErrorCode,
  ViewerEvents,
} from "./viewer.js";
export type { InputOptions } from "./input.js";
export type {
  SessionDiagnostic,
  SessionDiagnostics,
  SessionPageRect,
  SessionPagesLayout,
  SessionRaster,
  ViewerSessionLike,
} from "./session.js";
export {
  clampScroll,
  clampZoom,
  contentExtent,
  currentPageAt,
  fitPage,
  scrollToPage,
  zoomAt,
} from "./camera.js";
export type { Camera, Viewport, ZoomLimits } from "./camera.js";
