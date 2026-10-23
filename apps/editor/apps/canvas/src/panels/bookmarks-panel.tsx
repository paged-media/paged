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

// SDK Phase 5 / panel-gallery pass — Bookmarks panel.
//
// Gallery list shape: glyph rows; destinations as mono secondary.
// CRUD + reorder + PDF-bookmark export land with their Operations.

import { ListRows, useCollection } from "@paged-media/shell";
import type { BookmarkSummary, PageSummary } from "@paged-media/client";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

const M = defineMessages("app.bookmarksPanel", {
  page: "Page {name}",
  aPage: "A page",
  aTextAnchor: "A text anchor",
  loading: "Loading bookmarks…",
  empty: "No bookmarks in this document.",
});

// R13 (ADR 254) — a bookmark's destination in words: the page it goes to
// by its folio, never the destination object's id.
function destinationText(
  strings: Strings,
  b: BookmarkSummary,
  pages: readonly PageSummary[] | null,
): string | undefined {
  if (b.destinationPage) {
    const page = pages?.find((p) => p.selfId === b.destinationPage);
    return page
      ? strings.t(M.page, { name: page.name ?? page.index })
      : strings.t(M.aPage);
  }
  return b.destination ? strings.t(M.aTextAnchor) : undefined;
}

export function BookmarksPanel() {
  const strings = useStrings();
  const items = useCollection<BookmarkSummary>("bookmarks");
  const pages = useCollection<PageSummary>("pages");
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-bookmarks-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-bookmarks-panel="ready">
      {items.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-empty-bookmarks>
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-bookmark-list>
          <ListRows
            rows={items.map((b) => {
              const to = destinationText(strings, b, pages);
              return {
                key: b.selfId,
                icon: "panel-bookmarks",
                primary: b.name,
                secondary: to ? `→ ${to}` : undefined,
              };
            })}
          />
        </div>
      )}
    </div>
  );
}
