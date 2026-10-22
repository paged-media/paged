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

// SDK Phase 5 / panel-gallery pass — Info panel.
//
// The gallery's readout shape over the singleton `DocumentMeta`:
// label · mono tabular value rows with hairline separators. Same
// six fields (the spec hooks key off the row labels); richer
// Document / Active page / Output sections arrive as the meta
// surface grows (per-page size, colour profile reads).

import { useCollection, useDocumentMeta } from "@paged-media/shell";
import { DOCUMENT_UNITS, useDocumentUnit } from "@paged-media/ui";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

const M = defineMessages("app.infoPanel", {
  page: "Page {number}",
  loading: "Loading document info…",
  document: "Document",
  pages: "Pages",
  activePage: "Active page",
  units: "Units",
  colorMode: "Color mode",
  dirty: "Dirty",
  yes: "yes",
  no: "no",
});

/** "Page 3", not the page's IDML id. */
function pageLabel(
  strings: Strings,
  id: unknown,
  pages: ReadonlyArray<{ selfId?: string }> | null,
): string {
  if (!id) return "—";
  const i = pages?.findIndex((p) => p.selfId === String(id)) ?? -1;
  return i >= 0 ? strings.t(M.page, { number: i + 1 }) : String(id);
}

/** `row` names the row for tests (English); `label` is what it shows. */
function Row({
  row,
  label,
  value,
}: {
  row: string;
  label: string;
  value: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-1.5 border-b border-input last:border-b-0"
      data-info-row={row}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="pg-value text-xs" data-info-value>
        {value}
      </span>
    </div>
  );
}

export function InfoPanel() {
  const strings = useStrings();
  const meta = useDocumentMeta();
  const pages = useCollection<{ selfId?: string }>("pages");
  // The unit lengths are shown in (ADR 245), once there is a document.
  const unit = useDocumentUnit();
  const unitName = DOCUMENT_UNITS.find(([u]) => u === unit)?.[1] ?? unit;
  if (!meta) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-info-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div className="p-3 flex flex-col" data-info-panel="ready">
      <Row
        row="Document"
        label={strings.t(M.document)}
        value={meta.documentName || "—"}
      />
      <Row
        row="Pages"
        label={strings.t(M.pages)}
        value={String(meta.pageCount)}
      />
      <Row
        row="Active page"
        label={strings.t(M.activePage)}
        value={pageLabel(strings, meta.activePage, pages)}
      />
      <Row
        row="Units"
        label={strings.t(M.units)}
        value={meta.pageCount > 0 ? unitName : "—"}
      />
      <Row
        row="Color mode"
        label={strings.t(M.colorMode)}
        value={meta.colorMode || "—"}
      />
      <Row
        row="Dirty"
        label={strings.t(M.dirty)}
        value={meta.dirty ? strings.t(M.yes) : strings.t(M.no)}
      />
    </div>
  );
}
