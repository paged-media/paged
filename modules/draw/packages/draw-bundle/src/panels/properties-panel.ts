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

import { BIND_RECIPE_REVISION } from "../link-index";
import { DRAW_ID } from "../object-model/shared";
import { defineMessages, t } from "@paged-media/strings";

import { tokenLabel } from "./panel-parts";

export const DRAW_PROPERTIES_PANEL_ID = "media.paged.draw.panel.properties";

const kindOf = (kind: string) => `plugin:${DRAW_ID}/${kind}`;

/** EVERY writable row each kind shows, in schema order (a spec holds this
 *  to the manifest), except the per-point item rows below. */
export const DRAW_PANEL_FIELDS = {
  path: ["points", "subpathStarts"],
  appearance: ["fills", "strokes", "graphicStyle"],
  symbolInstance: ["linked"],
  graphicStyle: [
    "name",
    "fills",
    "strokes",
    "baseFill",
    "baseFillTint",
    "baseStroke",
    "baseStrokeWeight",
    "baseOpacity",
    "baseBlendMode",
  ],
  symbol: ["name"],
  pattern: [
    "name",
    "layout",
    "tile",
    "spacing",
    "columns",
    "rows",
    "offset",
    "dim",
    "overlap",
    "fitToArtboard",
  ],
  repeat: [
    "name",
    "kind",
    "count",
    "radiusPt",
    "startDeg",
    "sweepDeg",
    "rotateInstances",
    "columns",
    "rows",
    "spacing",
    "flipColumns",
    "flipRows",
    "angleDeg",
    "offsetPt",
    "clip",
    "clipRect",
    "fitToArtboard",
  ],
  blend: [
    "name",
    "spacing",
    "steps",
    "distancePt",
    "orientation",
    "easing",
    "easingStrength",
    "colorEasing",
    "colorEasingStrength",
    "reverseSpine",
    "reverseFrontToBack",
    "fitToArtboard",
  ],
  livePaint: ["name"],
  objectsOnPath: [
    "name",
    "distribute",
    "spacingPt",
    "startOffsetPt",
    "alignToPath",
    "pivot",
    "reverseOrder",
    "order",
    "fitToArtboard",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * Documented exception: the per-point ITEM rows of `path` (`points[3]`,
 * `points[3].anchor`, …) have no row of their own. A panel row's path is
 * static, and these rows exist for an index a script or binding names; the
 * panel reaches the same values as the items of the `points` list row
 * (anchor / left / right per item), whose edits write the point table.
 */
export const DRAW_PANEL_ITEM_ROWS: Readonly<
  Record<string, { via: string; why: string }>
> = {
  "path.points[]": {
    via: "path.points",
    why: "one point = one item of the points list row",
  },
  "path.points[].anchor": {
    via: "path.points",
    why: "the item field anchor of the points list row",
  },
  "path.points[].left": {
    via: "path.points",
    why: "the item field left of the points list row",
  },
  "path.points[].right": {
    via: "path.points",
    why: "the item field right of the points list row",
  },
};

const M = defineMessages("draw.properties", {
  across: "Across",
  down: "Down",
  smoothColor: "Smooth colour",
  specifiedSteps: "Specified steps",
  specifiedDistance: "Specified distance",
  countEvenly: "Count (evenly)",
  graphicStyle: "Graphic style",
  linked: "Linked to symbol",
  subpathStarts: "Contour starts",
  clipRect: "Clip rectangle",
  order: "Object order",
  repeat: "Repeat",
  blend: "Blend",
  pattern: "Pattern",
  objectsOnPath: "Objects on path",
  symbol: "Symbol",
  livePaint: "Live paint",
  intro:
    "Edit the saved settings of the selected vector object and of every repeat, blend, pattern, objects-on-path set, graphic style, symbol and live paint group in the document, in place. To make new ones or rebuild their artwork, use the panel for each feature.",
  title: "Draw settings",
  selectedObject: "Selected object",
  path: "Path",
});

/** Enum rows show human labels ("easeIn" → "Ease in"), never the token;
 *  `labels` are message keys. Read in the locale when the panel is built. */
const choices = (
  values: readonly string[],
  labels: Record<string, string> = {},
) =>
  values.map((value) => ({
    value,
    label: labels[value] ? t(labels[value]) : tokenLabel(value),
  }));
const EASES = () => choices(["linear", "easeIn", "easeOut", "easeInOut"]);
const PIVOTS = () =>
  choices([
    "topLeft",
    "top",
    "topRight",
    "left",
    "center",
    "right",
    "bottomLeft",
    "bottom",
    "bottomRight",
  ]);

/** List / struct presentation per (kind.path). */
const STACK = { reversed: true, itemLabel: "color" } as const;
const rowOptions = (): Readonly<
  Record<string, Omit<PanelSchemaPropertyRow, "field" | "path" | "address">>
> => ({
  "path.points": {
    items: {
      fields: ["anchor", "left", "right"],
      newItem: { anchor: [0, 0], left: [0, 0], right: [0, 0] },
    },
  },
  "appearance.fills": { items: STACK },
  "appearance.strokes": { items: STACK },
  "graphicStyle.fills": { items: STACK },
  "graphicStyle.strokes": { items: STACK },
  "pattern.overlap": {
    fields: [
      {
        field: "horizontal",
        label: t(M.across),
        style: "segments",
        options: choices(["rightInFront", "leftInFront"]),
      },
      {
        field: "vertical",
        label: t(M.down),
        style: "segments",
        options: choices(["bottomInFront", "topInFront"]),
      },
    ],
  },
  "pattern.layout": { options: choices(["grid", "brick", "hex"]) },
  "repeat.kind": { options: choices(["radial", "grid", "mirror"]) },
  "blend.spacing": {
    options: choices(["smoothColor", "steps", "distance"], {
      smoothColor: M.smoothColor,
      steps: M.specifiedSteps,
      distance: M.specifiedDistance,
    }),
  },
  "blend.orientation": { options: choices(["page", "path"]) },
  "blend.easing": { options: EASES() },
  "blend.colorEasing": { options: EASES() },
  "objectsOnPath.distribute": {
    options: choices(["count", "spacing"], { count: M.countEvenly }),
  },
  "objectsOnPath.pivot": { options: PIVOTS() },
});

const labels = (): Readonly<Record<string, string>> => ({
  graphicStyle: t(M.graphicStyle),
  linked: t(M.linked),
  subpathStarts: t(M.subpathStarts),
  clipRect: t(M.clipRect),
  order: t(M.order),
});

const rowsOf = (
  kind: keyof typeof DRAW_PANEL_FIELDS,
  address: PropertyFieldAddress,
) => {
  const options = rowOptions();
  return propertyRows(kindOf(kind), DRAW_PANEL_FIELDS[kind], address, {
    labels: labels(),
    row: (p) => options[`${kind}.${p}`] ?? {},
  });
};

type DocKind =
  | "graphicStyle"
  | "symbol"
  | "pattern"
  | "repeat"
  | "blend"
  | "livePaint"
  | "objectsOnPath";

/** Each kind's section title is a message key. */
const DOC_KINDS: ReadonlyArray<{ kind: DocKind; title: string }> = [
  { kind: "repeat", title: M.repeat },
  { kind: "blend", title: M.blend },
  { kind: "pattern", title: M.pattern },
  { kind: "objectsOnPath", title: M.objectsOnPath },
  { kind: "graphicStyle", title: M.graphicStyle },
  { kind: "symbol", title: M.symbol },
  { kind: "livePaint", title: M.livePaint },
];

/** Published bindings: the rows of a document kind's list, and the pick. */
export const listBinding = (kind: DocKind) =>
  `media.paged.draw.properties.${kind}s`;
export const pickBinding = (kind: DocKind) =>
  `media.paged.draw.properties.${kind}`;

const listRow = (kind: DocKind): PanelSchemaRow => ({
  widget: "paged.list",
  list: {
    items: { kind: "binding", bind: listBinding(kind) },
    labelField: "name",
    selectionBinding: pickBinding(kind),
  },
});

/** The intro line: how this panel differs from the feature panels (a
 *  message key). */
export const DRAW_PROPERTIES_INTRO = M.intro;

/** The panel's schema, in the editor's locale (built when the bundle
 *  activates). */
export const drawPropertiesPanel = (): PanelSchema => ({
  id: DRAW_PROPERTIES_PANEL_ID,
  // "Draw settings", not "properties": the host has a Properties panel,
  // and the recipe panels (Blend options, Repeat options…) edit the same
  // settings one feature at a time.
  title: t(M.title),
  // Its own glyph: `panel-stroke` belongs to the host Stroke panel.
  icon: "tool-pen",
  defaultDock: "right",
  defaultGroup: "draw",
  sections: [
    {
      title: t(M.selectedObject),
      rows: [
        { widget: "paged.label", props: { text: t(DRAW_PROPERTIES_INTRO) } },
        ...rowsOf("appearance", "selection"),
        ...rowsOf("symbolInstance", "selection"),
      ],
    },
    {
      title: t(M.path),
      collapsible: true,
      rows: rowsOf("path", "selection"),
    },
    ...DOC_KINDS.map(({ kind, title }) => ({
      title: t(title),
      collapsible: true,
      rows: [listRow(kind), ...rowsOf(kind, { bind: pickBinding(kind) })],
    })),
  ],
});

/** The lists re-read on object-model changes. A batch announces several
 *  changes and seven lists follow it, so the lists see ONE coalesced
 *  change per burst, after the writer's own reads (`ms` later), never in
 *  the middle of a batch.
 *
 *  A RECIPE WRITE IS A CHANGE TOO. The document kinds are read out of the
 *  recipe parts, and a command saves its recipe AFTER its batch, through
 *  a `.paged` part write that `objects.onDidChange` never reports. In the
 *  editor every door is a worker round trip, so the read the batch's
 *  change started could run before the write landed, and nothing re-read
 *  afterwards: a repeat made from the menu was missing from its list. The
 *  write's announcement (`announceRecipeChange`) is the missing event. */
function coalescedChanges(host: BundleHost, ms = 50): BundleHost & Disposable {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const l of [...listeners]) l();
    }, ms);
  };
  const subs: Disposable[] = [host.objects.onDidChange(changed)];
  try {
    subs.push(
      host.bindings.onDidChange((name) => {
        if (name === BIND_RECIPE_REVISION) changed();
      }),
    );
  } catch {
    /* no binding store: a recipe write reaches the lists only through
       the next document or selection change */
  }
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
      for (const s of subs) s.dispose();
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
