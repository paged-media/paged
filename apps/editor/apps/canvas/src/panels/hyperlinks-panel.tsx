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

// SDK Phase 5 / panel-gallery pass — Hyperlinks panel.
//
// Gallery list shape: glyph rows with the destination as the mono
// secondary. CRUD + jump-to land with their Operations.

import { ListRows, useCollection } from "@paged-media/shell";
import type { HyperlinkSummary, PageSummary } from "@paged-media/client";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("app.hyperlinksPanel", {
  numbered: "Hyperlink {number}",
  page: "Page {name}",
  aPage: "A page",
  aTextAnchor: "A text anchor",
  loading: "Loading hyperlinks…",
  empty: "No hyperlinks in this document.",
});

// R13 (ADR 254) — what a row says, in words. The destination is where
// the link goes (its URL, or the page by its folio), never the
// destination OBJECT's id; a hyperlink with no name of its own (the
// engine falls back to its `Self`) is named as InDesign's panel names
// one: after its URL, else "Hyperlink n".

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

export function hyperlinkName(h: HyperlinkSummary, index: number): string {
  const named =
    h.name && h.name !== h.selfId && !h.name.startsWith("Hyperlink/");
  if (named) return h.name;
  return h.destinationUrl ?? t(M.numbered, { number: index + 1 });
}

export function hyperlinkDestination(
  h: HyperlinkSummary,
  pages: readonly PageSummary[] | null,
): string | undefined {
  if (h.destinationUrl) return h.destinationUrl;
  if (h.destinationPage) {
    const page = pages?.find((p) => p.selfId === h.destinationPage);
    return page ? t(M.page, { name: page.name ?? page.index }) : t(M.aPage);
  }
  // A text anchor: the summary names no place in words yet.
  return h.destination ? t(M.aTextAnchor) : undefined;
}

export function HyperlinksPanel() {
  const strings = useStrings();
  const items = useCollection<HyperlinkSummary>("hyperlinks");
  const pages = useCollection<PageSummary>("pages");
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-hyperlinks-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-hyperlinks-panel="ready">
      {items.length === 0 ? (
        <div
          className="p-3 text-xs text-muted-foreground"
          data-empty-hyperlinks
        >
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-hyperlink-list>
          <ListRows
            rows={items.map((h, i) => {
              const name = hyperlinkName(h, i);
              const to = hyperlinkDestination(h, pages);
              return {
                key: h.selfId,
                icon: "panel-hyperlinks",
                primary: name,
                secondary: to ? `→ ${clip(to)}` : undefined,
                searchText: `${name} ${to ?? ""}`,
              };
            })}
          />
        </div>
      )}
    </div>
  );
}
