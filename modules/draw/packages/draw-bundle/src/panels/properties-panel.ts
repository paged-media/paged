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
// List and struct values (plugin-sdk 0.2.45, DESIGN.md §12.8) are rows too:
// path points (items of anchor / left / right), appearance and graphic
// style stacks (items, listed top-first), a pattern's overlap (struct
// fields), tile / spacing points and the repeat clip rectangle. The host
// edits them item by item; every edit lowers to `set` ops in one batch.
// The React recipe panels stay for the commands that rebuild the artwork.

import type {
  BundleHost,
  Disposable,
  PanelSchema,
  PanelSchemaPropertyRow,
  PanelSchemaRow,
  PropertyFieldAddress,
} from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";

import { DRAW_ID } from "../object-model/shared";

export const DRAW_PROPERTIES_PANEL_ID = "media.paged.draw.panel.properties";

const kindOf = (kind: string) => `plugin:${DRAW_ID}/${kind}`;

/** EVERY writable row each kind shows, in schema order (a spec holds this
 *  to the manifest), except the per-point item rows below. */
export const DRAW_PANEL_FIELDS = {
  path: ["points", "subpathStarts"],
  appearance: ["fills", "strokes", "graphicStyle"],
  symbolInstance: ["linked"],
  graphicStyle: ["name", "fills", "strokes", "baseFill", "baseFillTint", "baseStroke", "baseStrokeWeight", "baseOpacity", "baseBlendMode"],
  symbol: ["name"],
  pattern: ["name", "layout", "tile", "spacing", "columns", "rows", "offset", "dim", "overlap", "fitToArtboard"],
  repeat: [
    "name", "kind", "count", "radiusPt", "startDeg", "sweepDeg", "rotateInstances", "columns", "rows", "spacing",
    "flipColumns", "flipRows", "angleDeg", "offsetPt", "clip", "clipRect", "fitToArtboard",
  ],
  blend: [
    "name", "spacing", "steps", "distancePt", "orientation", "easing", "easingStrength", "colorEasing",
    "colorEasingStrength", "reverseSpine", "reverseFrontToBack", "fitToArtboard",
  ],
  livePaint: ["name"],
  objectsOnPath: ["name", "distribute", "spacingPt", "startOffsetPt", "alignToPath", "pivot", "reverseOrder", "order", "fitToArtboard"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Documented exception: the per-point ITEM rows of `path` (`points[3]`,
 * `points[3].anchor`, …) have no row of their own. A panel row's path is
 * static, and these rows exist for an index a script or binding names; the
 * panel reaches the same values as the items of the `points` list row
 * (anchor / left / right per item), whose edits write the point table.
 */
export const DRAW_PANEL_ITEM_ROWS: Readonly<Record<string, { via: string; why: string }>> = {
  "path.points[]": { via: "path.points", why: "one point = one item of the points list row" },
  "path.points[].anchor": { via: "path.points", why: "the item field anchor of the points list row" },
  "path.points[].left": { via: "path.points", why: "the item field left of the points list row" },
  "path.points[].right": { via: "path.points", why: "the item field right of the points list row" },
};

/** List / struct presentation per (kind.path). */
const STACK = { reversed: true, itemLabel: "color" } as const;
const ROW_OPTIONS: Readonly<Record<string, Omit<PanelSchemaPropertyRow, "field" | "path" | "address">>> = {
  "path.points": { items: { fields: ["anchor", "left", "right"], newItem: { anchor: [0, 0], left: [0, 0], right: [0, 0] } } },
  "appearance.fills": { items: STACK },
  "appearance.strokes": { items: STACK },
  "graphicStyle.fills": { items: STACK },
  "graphicStyle.strokes": { items: STACK },
  "pattern.overlap": {
    fields: [
      { field: "horizontal", label: "Across", style: "segments" },
      { field: "vertical", label: "Down", style: "segments" },
    ],
  },
};

const LABELS: Readonly<Record<string, string>> = {
  graphicStyle: "Graphic style",
  linked: "Linked to symbol",
  subpathStarts: "Contour starts",
  clipRect: "Clip rectangle",
  order: "Object order",
};

const rowsOf = (kind: keyof typeof DRAW_PANEL_FIELDS, address: PropertyFieldAddress) =>
  propertyRows(kindOf(kind), DRAW_PANEL_FIELDS[kind], address, {
    labels: LABELS,
    row: (p) => ROW_OPTIONS[`${kind}.${p}`] ?? {},
  });

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
        ...rowsOf("appearance", "selection"),
        ...rowsOf("symbolInstance", "selection"),
      ],
    },
    {
      title: "Path",
      collapsible: true,
      rows: rowsOf("path", "selection"),
    },
    ...DOC_KINDS.map(({ kind, title }) => ({
      title,
      collapsible: true,
      rows: [listRow(kind), ...rowsOf(kind, { bind: pickBinding(kind) })],
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
