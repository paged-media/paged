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

// SDK Phase 5 / panel-gallery pass — Links panel.
//
// W2.12 — the W0.6 wire summaries land: each row now carries a status
// dot (`LinkSummary.status` ok/missing), a `missing` badge when the
// renderer fell back to the grey placeholder, the placed-image
// colourspace, and the effective PPI with a `lo-res` badge below the
// 150-ppi preflight convention. The toolbar (relink/update/go-to)
// stays a seam until the relocate/update/break Operations ship.
//
// Image ADR 482 — a bundle whose content links or embeds files (paged.image's
// smart objects) serves its own `links` rows while its edit context is
// active (`useProvidedCollection`, ADR 023): they are listed after the
// document's links, and a selected one gets a second toolbar whose
// Relink / Update / Embed run the commands the ROW names
// (`ProvidedLinkRow.actions`) with `{ link }` — the panel branches on what
// the row offers, never on who served it.

import { useState } from "react";
import {
  ListRows,
  PanelToolbar,
  ToolbarBtn,
  useCollection,
  useProvidedCollection,
  useRegistries,
  type ListRowBadge,
  type ListRowSpec,
} from "@paged-media/shell";
import type { LinkSummary } from "@paged-media/client";
import type { ProvidedLinkRow } from "@paged-media/plugin-api";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.linksPanel", {
  loading: "Loading links…",
  updateLink: "Update link — awaiting engine support",
  relinkHistory: "Relink history — awaiting engine support",
  goToLink: "Go to link — awaiting engine support",
  empty: "No image links in this document.",
  filter: "Filter links",
  missing: "missing",
  notDrawn: "not drawn",
  lowRes: "lo-res",
  embedded: "embedded",
  relinkProvided: "Relink…",
  updateProvided: "Update from file…",
  embedProvided: "Embed",
});

/** Low-res convention — placed images whose effective PPI falls below
 *  this get the `lo-res` badge. The print floor is 300 ppi; 150 is the
 *  editor's "warn, not fail" threshold shared with Publication health. */
const LOW_RES_PPI = 150;

export function LinksPanel() {
  const strings = useStrings();
  const links = useCollection<LinkSummary>("links");
  const provided = useProvidedCollection<ProvidedLinkRow>("links");
  const registries = useRegistries();
  const [selected, setSelected] = useState<string | null>(null);
  // A provider's rows (a smart object's file), after the document's own.
  const extra: ProvidedLinkRow[] =
    provided.provider !== null ? (provided.rows ?? []) : [];
  const picked = extra.find((r) => r.hostSelfId === selected) ?? null;
  const run = (command: string | undefined) => {
    if (!command || !picked) return;
    void Promise.resolve(
      registries.commands.invoke(command, { link: picked.hostSelfId }),
    ).catch((err: unknown) =>
      console.warn(`paged.links: ${command} refused`, err),
    );
  };
  if (links === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-links-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }
  return (
    <div data-links-panel="ready">
      <PanelToolbar>
        <ToolbarBtn icon="ui-return" label={strings.t(M.updateLink)} />
        <ToolbarBtn icon="ui-history" label={strings.t(M.relinkHistory)} />
        <ToolbarBtn icon="ui-target" label={strings.t(M.goToLink)} />
      </PanelToolbar>
      {picked && (
        <div data-provided-link-actions className="flex gap-2 px-3 py-1">
          <button
            type="button"
            data-link-action="relink"
            disabled={!picked.actions?.relink}
            onClick={() => run(picked.actions?.relink)}
          >
            {strings.t(M.relinkProvided)}
          </button>
          <button
            type="button"
            data-link-action="update"
            disabled={!picked.actions?.update}
            onClick={() => run(picked.actions?.update)}
          >
            {strings.t(M.updateProvided)}
          </button>
          <button
            type="button"
            data-link-action="embed"
            disabled={!picked.actions?.embed}
            onClick={() => run(picked.actions?.embed)}
          >
            {strings.t(M.embedProvided)}
          </button>
        </div>
      )}
      {links.length === 0 && extra.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-empty-links>
          {strings.t(M.empty)}
        </div>
      ) : (
        <div data-link-list>
          <ListRows
            search={links.length > 8}
            searchPlaceholder={strings.t(M.filter)}
            rows={links
              .map((link): ListRowSpec => {
                // The displayed name strips path prefixes for
                // legibility — full URI lives in searchText.
                const filename = link.uri.split("/").pop() ?? link.uri;
                const missing = link.status === "missing";
                // The file is there but this engine has no decoder for it
                // (an EPS): not missing, and not drawn either (engine ADR 207).
                const undecoded = link.status === "undecoded";
                const lowRes =
                  link.effectivePpi != null && link.effectivePpi < LOW_RES_PPI;
                // status dot: missing → error, undecoded → warn, resolved →
                // ready, unknown (older wasm) → no dot.
                const dot =
                  link.status === "missing"
                    ? ("error" as const)
                    : undecoded
                      ? ("warn" as const)
                      : link.status === "ok"
                        ? ("ok" as const)
                        : undefined;
                // The mono secondary line carries colourspace + PPI when
                // the IDML baked them (synthetic fixtures omit both).
                const meta: string[] = [];
                if (link.colorspace) meta.push(link.colorspace);
                if (link.effectivePpi != null) {
                  meta.push(`${Math.round(link.effectivePpi)} ppi`);
                }
                const secondary =
                  meta.length > 0 ? meta.join(" · ") : `${link.hostKind}`;
                // A single trailing badge — missing wins over not drawn,
                // which wins over lo-res.
                const badge: ListRowBadge | undefined = missing
                  ? { label: strings.t(M.missing), tone: "error" }
                  : undecoded
                    ? { label: strings.t(M.notDrawn), tone: "warn" }
                    : lowRes
                      ? { label: strings.t(M.lowRes), tone: "warn" }
                      : undefined;
                return {
                  key: link.hostSelfId,
                  dot,
                  icon: "panel-links",
                  primary: filename,
                  secondary,
                  badge,
                  searchText: `${filename} ${link.uri} ${link.colorspace ?? ""}`,
                };
              })
              .concat(
                extra.map((row): ListRowSpec => {
                  const name = row.uri.split("/").pop() ?? row.uri;
                  const missing = row.status === "missing";
                  return {
                    key: row.hostSelfId,
                    dot: missing ? "error" : "ok",
                    icon: "panel-links",
                    primary: name,
                    secondary: row.hostKind,
                    badge: missing
                      ? { label: strings.t(M.missing), tone: "error" }
                      : row.status === "embedded"
                        ? { label: strings.t(M.embedded), tone: "info" }
                        : undefined,
                    selected: row.hostSelfId === selected,
                    onClick: () => setSelected(row.hostSelfId),
                    searchText: `${name} ${row.uri}`,
                  };
                }),
              )}
          />
        </div>
      )}
    </div>
  );
}
