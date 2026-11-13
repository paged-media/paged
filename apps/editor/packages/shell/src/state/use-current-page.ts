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

// The current page for a component: the one rule of `current-page.ts`
// over the document's page layout and the live camera, re-rendered as
// either changes.

import type { PageId } from "@paged-media/client";

import { layoutPageRects } from "../cockpit/canvas-frame/page-layout";
import { useCamera } from "./camera-context";
import { currentPageIndex } from "./current-page";
import { useDocument } from "./document-context";

export interface CurrentPage {
  /** The page's index, -1 without pages. */
  index: number;
  /** Its id, null without pages. */
  pageId: PageId | null;
  /** How many pages the document has. */
  count: number;
}

export function useCurrentPage(): CurrentPage {
  const { handle } = useDocument();
  const { camera, viewportSize } = useCamera();
  const sizes = handle?.pageSizesPt ?? [];
  const rects = layoutPageRects(sizes, handle?.pageOriginsPt);
  const index = currentPageIndex(rects, camera, viewportSize);
  return {
    index,
    pageId: index >= 0 ? (handle?.pageIds[index] ?? null) : null,
    count: sizes.length,
  };
}
