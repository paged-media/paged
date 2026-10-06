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

// ADR 323 (object-model design §4 "Panels") — draw's OBJECT properties as
// a schema panel of property rows. The host renders each row with its one
// schema-driven `PropertyField` over `host.objects` (the widget comes from
// the kind's schema row, a commit is one undo step, every field offers
// "Bind to data…"). The bundle declares fields, never widgets.
//
//   · element-anchored kinds (appearance, symbolInstance) follow the
//     selection: `<selected item> > <kind>`;
//   · library / recipe kinds live on the document: a list of the
//     document's objects (publishObjectList) picks ONE, and the rows below
//     address `{ bind }` the picked one.
//
// Not here (no LIST/struct widget yet): appearance fills/strokes, path
// points, pattern tile/spacing/overlap, repeat spacing/clipRect,
// objectsOnPath order. The React recipe panels stay for those and for the
// commands that rebuild the artwork.

import type { BundleHost, Disposable, PanelSchema, PanelSchemaRow } from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";

import { DRAW_ID } from "../object-model/shared";

export const DRAW_PROPERTIES_PANEL_ID = "media.paged.draw.panel.properties";

const kindOf = (kind: string) => `plugin:${DRAW_ID}/${kind}`;

/** The writable scalar rows each kind shows, in panel order (a spec holds
 *  this to the manifest: every writable bool/number/length/enum/text/
 *  color/ref row of each kind). */
export const DRAW_PANEL_FIELDS = {
  appearance: ["graphicStyle"],
  symbolInstance: ["linked"],
  graphicStyle: ["name", "baseFill", "baseFillTint", "baseStroke", "baseStrokeWeight", "baseOpacity", "baseBlendMode"],
  symbol: ["name"],
  pattern: ["name", "layout", "columns", "rows", "offset", "dim", "fitToArtboard"],
  repeat: [
    "name", "kind", "count", "radiusPt", "startDeg", "sweepDeg", "rotateInstances", "columns", "rows",
    "flipColumns", "flipRows", "angleDeg", "offsetPt", "clip", "fitToArtboard",
  ],
  blend: [
    "name", "spacing", "steps", "distancePt", "orientation", "easing", "easingStrength", "colorEasing",
    "colorEasingStrength", "reverseSpine", "reverseFrontToBack", "fitToArtboard",
  ],
  livePaint: ["name"],
  objectsOnPath: ["name", "distribute", "spacingPt", "startOffsetPt", "alignToPath", "pivot", "reverseOrder", "fitToArtboard"],
} as const satisfies Record<string, readonly string[]>;

type DocKind = "graphicStyle" | "symbol" | "pattern" | "repeat" | "blend" | "livePaint" | "objectsOnPath";

const DOC_KINDS: ReadonlyArray<{ kind: DocKind; title: string }> = [
  { kind: "repeat", title: "Repeat" },
  { kind: "blend", title: "Blend" },
  { kind: "pattern", title: "Pattern" },
  { kind: "objectsOnPath", title: "Objects on path" },
  { kind: "graphicStyle", title: "Graphic style" },
  { kind: "symbol", title: "Symbol" },
  { kind: "livePaint", title: "Live paint" },
];

/** Published bindings: the rows of a document kind's list, and the pick. */
export const listBinding = (kind: DocKind) => `media.paged.draw.properties.${kind}s`;
export const pickBinding = (kind: DocKind) => `media.paged.draw.properties.${kind}`;

const listRow = (kind: DocKind): PanelSchemaRow => ({
  widget: "paged.list",
  list: {
    items: { kind: "binding", bind: listBinding(kind) },
    labelField: "name",
    selectionBinding: pickBinding(kind),
  },
});

export const DRAW_PROPERTIES_PANEL: PanelSchema = {
  id: DRAW_PROPERTIES_PANEL_ID,
  title: "Draw properties",
  icon: "panel-stroke",
  defaultDock: "right",
  defaultGroup: "draw",
  sections: [
    {
      title: "Selected object",
      rows: [
        ...propertyRows(kindOf("appearance"), DRAW_PANEL_FIELDS.appearance, "selection", {
          labels: { graphicStyle: "Graphic style" },
        }),
        ...propertyRows(kindOf("symbolInstance"), DRAW_PANEL_FIELDS.symbolInstance, "selection", {
          labels: { linked: "Linked to symbol" },
        }),
      ],
    },
    ...DOC_KINDS.map(({ kind, title }) => ({
      title,
      collapsible: true,
      rows: [listRow(kind), ...propertyRows(kindOf(kind), DRAW_PANEL_FIELDS[kind], { bind: pickBinding(kind) })],
    })),
  ],
};

/** The lists re-read on object-model changes. A batch announces several
 *  changes and seven lists follow it, so the lists see ONE coalesced
 *  change per burst, after the writer's own reads (`ms` later), never in
 *  the middle of a batch. */
function coalescedChanges(host: BundleHost, ms = 50): BundleHost & Disposable {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = host.objects.onDidChange(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const l of [...listeners]) l();
    }, ms);
  });
  const objects = Object.create(host.objects) as BundleHost["objects"];
  objects.onDidChange = (listener) => {
    const l = () => listener({ addresses: [], origin: "core" });
    listeners.add(l);
    return { dispose: () => void listeners.delete(l) };
  };
  return Object.assign(Object.create(host) as BundleHost, {
    objects,
    dispose() {
      if (timer) clearTimeout(timer);
      sub.dispose();
      listeners.clear();
    },
  });
}

/** Keep the document-kind lists live. */
export function publishDrawPropertyLists(host: BundleHost): Disposable {
  const shared = coalescedChanges(host);
  const subs = DOC_KINDS.map(({ kind }) =>
    publishObjectList(shared, {
      rows: listBinding(kind),
      select: pickBinding(kind),
      selector: () => kindOf(kind),
    }),
  );
  return {
    dispose: () => {
      subs.forEach((s) => s.dispose());
      shared.dispose();
    },
  };
}
