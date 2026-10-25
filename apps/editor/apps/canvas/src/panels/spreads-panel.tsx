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

// SDK Phase 5 / panel-gallery pass — Spreads panel.
//
// Gallery list shape over `documentCollection:spreads`. The secondary
// reads the spread's pages and the objects on it (WP2.7: SpreadSummary
// carries `pageIds` and `members`): "2 pages · 5 objects".

import {
  ListRows,
  displayName,
  isIdLikeLabel,
  useCollection,
} from "@paged-media/shell";
import type { SpreadSummary } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.spreadsPanel", {
  loading: "Loading spreads…",
  empty: "No spreads.",
  spread: "Spread {number}",
  pages: "{count, plural, one {# page} other {# pages}}",
  pagesAndObjects:
    "{count, plural, one {# page} other {# pages}} · {objects, plural, one {# object} other {# objects}}",
});

export function SpreadsPanel() {
  const strings = useStrings();
  const items = useCollection<SpreadSummary>("spreads");
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-spreads-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-spreads-panel="ready">
      {items.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-empty-spreads>
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-spread-list>
          <ListRows
            rows={items.map((s, i) => ({
              key: s.selfId,
              icon: "panel-spreads",
              // An unnamed spread's label is its id ("u630080", "us") or,
              // from engine 0.71.8, its folios ("2–3"): neither is a name.
              primary: isIdLikeLabel(s.label, s.selfId)
                ? strings.t(M.spread, { number: i + 1 })
                : displayName(s.label),
              // An older engine sends no members: the page count alone.
              secondary: s.members
                ? strings.t(M.pagesAndObjects, {
                    count: s.pageIds?.length || s.pageCount,
                    objects: s.members.length,
                  })
                : strings.t(M.pages, { count: s.pageCount }),
            }))}
          />
        </div>
      )}
    </div>
  );
}
