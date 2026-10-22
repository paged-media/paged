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

// SDK Phase 5 / panel-gallery pass — Fonts panel.
//
// Gallery shape: All / In use / Missing filter tabs over the
// fonts-in-use registry. The parse layer doesn't carry a font
// registry — fonts are referenced from runs + style defaults and the
// accessor dedups — so "All" ≡ "In use" today.
//
// W2.12 — "Missing" is now REAL: it filters on `FontSummary.isMissing`
// (true when the worker's font registry couldn't resolve the family
// to face bytes and the renderer substituted a fallback). Each row
// carries a status dot — green when resolved, red when missing — and
// the Replace action stays a seam until a substitute-font Operation
// ships.

import { useState } from "react";

import { ListRows, useCollection, type ListRowSpec } from "@paged-media/shell";
import type { FontSummary } from "@paged-media/client";
import { Segment } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

type FontFilter = "All" | "In use" | "Missing";

const M = defineMessages("app.fontsPanel", {
  loading: "Loading fonts…",
  refs: "{count, plural, one {# ref} other {# refs}}",
  refsSubstituted: "{count, plural, one {# ref} other {# refs}} · substituted",
  missingBadge: "missing",
  all: "All",
  inUse: "In use",
  missing: "Missing",
  empty: "No fonts in use.",
  noneMissing: "No missing fonts — every referenced family resolved.",
});

const FILTER_LABEL: Record<FontFilter, string> = {
  All: M.all,
  "In use": M.inUse,
  Missing: M.missing,
};

export function FontsPanel() {
  const strings = useStrings();
  const items = useCollection<FontSummary>("fonts");
  const [filter, setFilter] = useState<FontFilter>("All");
  if (items === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-fonts-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }

  const missingCount = items.filter((f) => f.isMissing).length;
  const filtered =
    filter === "Missing" ? items.filter((f) => f.isMissing) : items;

  const rows: ListRowSpec[] = filtered.map((f) => ({
    key: f.family,
    // The leading dot reads the resolution outcome: green = at least
    // one style resolved to face bytes, red = substituted fallback.
    // ("ready" maps to --status-approved in the kit's tone table.)
    dot: f.isMissing ? "error" : "ready",
    icon: "panel-fonts",
    primary: f.family,
    secondary: strings.t(f.isMissing ? M.refsSubstituted : M.refs, {
      count: f.referenceCount,
    }),
    badge: f.isMissing
      ? { label: strings.t(M.missingBadge), tone: "error" }
      : undefined,
  }));

  return (
    <div data-fonts-panel="ready">
      <div className="flex gap-1 px-3 pt-3">
        {(["All", "In use", "Missing"] as FontFilter[]).map((f) => (
          <Segment
            key={f}
            pressed={filter === f}
            data-font-filter={f}
            onClick={() => setFilter(f)}
            className="text-xs px-2 h-[24px] rounded-[6px] border inline-flex items-center gap-1"
            style={{
              borderColor:
                filter === f ? "var(--pg-primary)" : "var(--pg-border)",
              background:
                filter === f ? "var(--pg-primary-soft)" : "var(--pg-bg)",
              color: filter === f ? "var(--pg-primary)" : "var(--pg-muted-fg)",
            }}
          >
            {strings.t(FILTER_LABEL[f])}
            {f === "Missing" && missingCount > 0 && (
              <span
                data-missing-count
                className="text-[9.5px] font-semibold"
                style={{ color: "var(--status-error)" }}
              >
                {missingCount}
              </span>
            )}
          </Segment>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-empty-fonts>
          {strings.t(M.empty)}
        </div>
      ) : filter === "Missing" && missingCount === 0 ? (
        <div
          className="p-3 text-xs text-muted-foreground italic"
          data-fonts-missing-empty
        >
          {strings.t(M.noneMissing)}
        </div>
      ) : (
        <div data-font-list>
          <ListRows rows={rows} />
        </div>
      )}
    </div>
  );
}
