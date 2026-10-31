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

// Image ADR 482 — the HOST Links panel shows the image's SMART OBJECTS'
// files while the `rasterImage` context is active: each smart object
// whose source is a file (embedded or linked) is a `links` row, and the
// panel's Relink / Update / Embed buttons run this bundle's commands for
// the row (`ProvidedLinkRow.actions`, payload `{ link }`). A smart object
// made from pixels has no file and no row.

import type {
  BindingCollection,
  BindingProvider,
  ProvidedLinkRow,
} from "@paged-media/plugin-api";

import type { ImageSession } from "../session";

const C = "media.paged.image.command.";

/** A smart object's row id: its stable layer id. */
export const linkRowId = (layerId: number): string => `smart:${layerId}`;

/** The layer INDEX a row id names in the open stack, or null. */
export function layerOfLink(
  session: ImageSession,
  link: unknown,
): number | null {
  if (typeof link !== "string") return null;
  const m = /^smart:(\d+)$/.exec(link);
  if (!m) return null;
  const id = Number(m[1]);
  const i = session.state().layers.layers.findIndex((l) => l.id === id);
  return i < 0 ? null : i;
}

export function makeLinksBindingProvider(session: ImageSession): {
  provider: BindingProvider;
} {
  const provider: BindingProvider = {
    provides: { collections: ["links"] },
    readCollection(request): BindingCollection {
      if (request.collection !== "links") {
        return { kind: "decline", reason: "only the links collection" };
      }
      const rows: ProvidedLinkRow[] = [];
      for (const l of session.state().layers.layers) {
        if (l.kind !== "smart") continue;
        const info = session.smart().info(l.index);
        const f = info?.file;
        if (!f) continue;
        rows.push({
          hostSelfId: linkRowId(l.id),
          hostKind: "smartObject",
          uri: f.path ?? f.name,
          status: !f.available ? "missing" : f.linked ? "ok" : "embedded",
          actions: {
            relink: `${C}smartRelink`,
            ...(f.linked ? { update: `${C}smartUpdateLinked` } : {}),
            ...(f.linked ? { embed: `${C}smartEmbed` } : {}),
          },
        });
      }
      // No files: decline, so the panel shows the document's own links.
      if (rows.length === 0)
        return { kind: "decline", reason: "no smart object has a file" };
      return { kind: "rows", rows };
    },
  };
  return { provider };
}
