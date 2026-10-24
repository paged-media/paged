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

// ADR 323 (object-model design §4 "Panels") — the image frame's layer
// stack as a SCHEMA panel of property rows. The host renders each row with
// its schema-driven `PropertyField` over `host.objects` (type from the
// layer / mask / adjustment / smartObject schema row, one undo step per
// commit, "Bind to data…" on every field). The bundle declares fields,
// never widgets; the existing image panel keeps its tool and preview UI.
//
// A layer list (publishObjectList over `<selected frame> > layer`) picks
// ONE layer; its mask, adjustment and smart-object objects share the
// layer's id, so their addresses are derived from the picked layer and
// published as bindings, with booleans gating the sections that apply.

import type {
  BundleHost,
  Disposable,
  PanelSchema,
  PanelSchemaPropertyRow,
  PanelSchemaRow,
  PropertyFieldAddress,
} from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";
import { defineMessages, t } from "@paged-media/strings";

import {
  KIND_PREFIX,
  PLUGIN_ID,
  parseImageAddress,
  layerAddress,
} from "../object-model/image-objects";
import { hueSatRangeLabel } from "../words";

export const PROPERTIES_PANEL_ID = `${PLUGIN_ID}.panel.properties`;

const LAYER = `${KIND_PREFIX}layer`;
const MASK = `${KIND_PREFIX}mask`;
const ADJUSTMENT = `${KIND_PREFIX}adjustment`;
const SMART = `${KIND_PREFIX}smartObject`;

/** Published bindings the list, the property rows and the gates share. */
export const BIND = {
  layers: "image.properties.layers",
  layer: "image.properties.layer",
  mask: "image.properties.mask",
  adjustment: "image.properties.adjustment",
  smartObject: "image.properties.smartObject",
  hasMask: "image.properties.hasMask",
  isAdjustment: "image.properties.isAdjustment",
  isSmart: "image.properties.isSmart",
} as const;

/** One declared field: a schema row of `kind`, shown in section `group`. */
export interface ImagePanelField {
  kind: "layer" | "mask" | "adjustment" | "smartObject";
  path: string;
  group: string;
}

/**
 * The declared panel fields: EVERY writable row of the layer, mask, smart
 * object and adjustment kinds (a spec holds this to the schemas), grouped
 * into sections. Adjustment parameters stay flat scalar rows (the per-range
 * hue/saturation triples, the 3×4 channel mixer, per-channel levels and
 * colour balance are indexed scalar paths of the generated schema); the two
 * curves rows are list values: `curves.composite` one 256-entry table,
 * `curves.channels` three (red, green, blue).
 */
export const IMAGE_PANEL_FIELDS: ReadonlyArray<ImagePanelField> = [
  ...[
    "name",
    "visible",
    "opacity",
    "blendMode",
    "locked",
    "clipped",
    "order",
    "pixelSource",
  ].map((path) => ({ kind: "layer" as const, path, group: "Layers" })),
  // The blending options and locks Photoshop's Layers panel carries.
  ...[
    "fillOpacity",
    "knockout",
    "colorLabel",
    "lockTransparency",
    "lockPosition",
    "lockAll",
  ].map((path) => ({ kind: "layer" as const, path, group: "Blending" })),
  { kind: "mask", path: "enabled", group: "Mask" },
  { kind: "smartObject", path: "source", group: "Smart object" },
  ...[
    "exposure.ev",
    "brightnessContrast.brightness",
    "brightnessContrast.contrast",
    "saturation.sat",
    "vibrance.vibrance",
    "whiteBalance.temp",
    "whiteBalance.tint",
    "levels.inBlack",
    "levels.inWhite",
    "levels.gamma",
    "levels.outBlack",
    "levels.outWhite",
  ].map((path) => ({ kind: "adjustment" as const, path, group: "Tone" })),
  ...[
    "hueSaturation.master[0]",
    "hueSaturation.master[1]",
    "hueSaturation.master[2]",
    "hueSaturation.colorize[0]",
    "hueSaturation.colorize[1]",
    "hueSaturation.colorize[2]",
    "hueSaturation.colorize[3]",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Hue/saturation",
  })),
  ...[
    "hueSaturation.ranges[0][0]",
    "hueSaturation.ranges[0][1]",
    "hueSaturation.ranges[0][2]",
    "hueSaturation.ranges[1][0]",
    "hueSaturation.ranges[1][1]",
    "hueSaturation.ranges[1][2]",
    "hueSaturation.ranges[2][0]",
    "hueSaturation.ranges[2][1]",
    "hueSaturation.ranges[2][2]",
    "hueSaturation.ranges[3][0]",
    "hueSaturation.ranges[3][1]",
    "hueSaturation.ranges[3][2]",
    "hueSaturation.ranges[4][0]",
    "hueSaturation.ranges[4][1]",
    "hueSaturation.ranges[4][2]",
    "hueSaturation.ranges[5][0]",
    "hueSaturation.ranges[5][1]",
    "hueSaturation.ranges[5][2]",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Hue/saturation ranges",
  })),
  ...[
    "colorBalance.shCr",
    "colorBalance.shMg",
    "colorBalance.shYb",
    "colorBalance.midCr",
    "colorBalance.midMg",
    "colorBalance.midYb",
    "colorBalance.hiCr",
    "colorBalance.hiMg",
    "colorBalance.hiYb",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Colour balance",
  })),
  ...[
    "blackWhite.enabled",
    "blackWhite.reds",
    "blackWhite.yellows",
    "blackWhite.greens",
    "blackWhite.cyans",
    "blackWhite.blues",
    "blackWhite.magentas",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Black & white",
  })),
  ...[
    "channelMixer.rr",
    "channelMixer.rg",
    "channelMixer.rb",
    "channelMixer.rc",
    "channelMixer.gr",
    "channelMixer.gg",
    "channelMixer.gb",
    "channelMixer.gc",
    "channelMixer.br",
    "channelMixer.bg",
    "channelMixer.bb",
    "channelMixer.bc",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Channel mixer",
  })),
  ...[
    "levelsRgb.rInBlack",
    "levelsRgb.rInWhite",
    "levelsRgb.rGamma",
    "levelsRgb.gInBlack",
    "levelsRgb.gInWhite",
    "levelsRgb.gGamma",
    "levelsRgb.bInBlack",
    "levelsRgb.bInWhite",
    "levelsRgb.bGamma",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Levels per channel",
  })),
  ...[
    "photoFilter.density",
    "photoFilter.fr",
    "photoFilter.fg",
    "photoFilter.fb",
    "photoFilter.preserve",
  ].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Photo filter",
  })),
  ...["curves.composite", "curves.channels"].map((path) => ({
    kind: "adjustment" as const,
    path,
    group: "Curves",
  })),
  ...[
    "gaussianBlur.sigma",
    "unsharp.amount",
    "hueRotate.degrees",
    "posterize.enabled",
    "posterize.levels",
    "threshold.enabled",
    "threshold.threshold",
    "invert.enabled",
  ].map((path) => ({ kind: "adjustment" as const, path, group: "Filters" })),
];

const pathsOf = (group: string) =>
  IMAGE_PANEL_FIELDS.filter((f) => f.group === group).map((f) => f.path);

const L = defineMessages("image.properties", {
  title: "Image properties",
  layers: "Layers",
  mask: "Mask",
  smartObject: "Smart object",
  adjustment: "Adjustment",
  hueSaturation: "Hue/saturation",
  hueSaturationRanges: "Hue/saturation ranges",
  colourBalance: "Colour balance",
  blackWhite: "Black & white",
  channelMixer: "Channel mixer",
  levelsPerChannel: "Levels per channel",
  photoFilter: "Photo filter",
  curves: "Curves",
  filters: "Filters",
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
  hueLower: "hue",
  saturationLower: "saturation",
  lightnessLower: "lightness",
  colorize: "Colorize",
  colorizeOf: "Colorize {component}",
  rangeOf: "{range} {component}",
  shadows: "Shadows",
  midtones: "Midtones",
  highlights: "Highlights",
  cyanRed: "cyan–red",
  magentaGreen: "magenta–green",
  yellowBlue: "yellow–blue",
  toneAxis: "{tone} {axis}",
  red: "Red",
  green: "Green",
  blue: "Blue",
  fromRed: "red",
  fromGreen: "green",
  fromBlue: "blue",
  fromConstant: "constant",
  mixFrom: "{out} from {source}",
  inputBlack: "input black",
  inputWhite: "input white",
  gamma: "gamma",
  channelLevel: "{channel} {level}",
  filterRed: "Filter red",
  filterGreen: "Filter green",
  filterBlue: "Filter blue",
  preserveLuminosity: "Preserve luminosity",
  compositeCurve: "Composite curve (256 levels)",
  channelCurves: "Channel curves (red, green, blue)",
  order: "Stack position",
  pixelSource: "Replace pixels",
  fillOpacity: "Fill opacity",
  knockout: "Knockout",
  colorLabel: "Colour label",
  lockTransparency: "Lock transparent pixels",
  lockPosition: "Lock position",
  lockAll: "Lock all",
});

/** The section titles of the field groups (the group names stay the ids). */
const GROUP_TITLES: Readonly<Record<string, string>> = {
  Layers: L.layers,
  Mask: L.mask,
  "Smart object": L.smartObject,
  Tone: L.adjustment,
  "Hue/saturation": L.hueSaturation,
  "Hue/saturation ranges": L.hueSaturationRanges,
  "Colour balance": L.colourBalance,
  "Black & white": L.blackWhite,
  "Channel mixer": L.channelMixer,
  "Levels per channel": L.levelsPerChannel,
  "Photo filter": L.photoFilter,
  Curves: L.curves,
  Filters: L.filters,
};

/** The row labels in the editor's language, read when the panel is
 *  contributed (rows the map leaves out take the schema's own label). */
function labels(): Readonly<Record<string, string>> {
  const hsl = [L.hue, L.saturation, L.lightness];
  const hslLower = [L.hueLower, L.saturationLower, L.lightnessLower];
  const ranges = ["Reds", "Yellows", "Greens", "Cyans", "Blues", "Magentas"];
  const rgb: Array<[string, string]> = [
    ["r", L.red],
    ["g", L.green],
    ["b", L.blue],
  ];
  const mixSource: Array<[string, string]> = [
    ["r", L.fromRed],
    ["g", L.fromGreen],
    ["b", L.fromBlue],
    ["c", L.fromConstant],
  ];
  const tones: Array<[string, string]> = [
    ["sh", L.shadows],
    ["mid", L.midtones],
    ["hi", L.highlights],
  ];
  const balance: Array<[string, string]> = [
    ["Cr", L.cyanRed],
    ["Mg", L.magentaGreen],
    ["Yb", L.yellowBlue],
  ];
  const levels: Array<[string, string]> = [
    ["InBlack", L.inputBlack],
    ["InWhite", L.inputWhite],
    ["Gamma", L.gamma],
  ];
  return {
    ...Object.fromEntries(
      hsl.map((l, i) => [`hueSaturation.master[${i}]`, t(l)]),
    ),
    "hueSaturation.colorize[0]": t(L.colorize),
    ...Object.fromEntries(
      hslLower.map((l, i) => [
        `hueSaturation.colorize[${i + 1}]`,
        t(L.colorizeOf, { component: t(l) }),
      ]),
    ),
    ...Object.fromEntries(
      ranges.flatMap((r, i) =>
        hslLower.map((l, j) => [
          `hueSaturation.ranges[${i}][${j}]`,
          t(L.rangeOf, { range: hueSatRangeLabel(r), component: t(l) }),
        ]),
      ),
    ),
    ...Object.fromEntries(
      tones.flatMap(([k, tone]) =>
        balance.map(([b, axis]) => [
          `colorBalance.${k}${b}`,
          t(L.toneAxis, { tone: t(tone), axis: t(axis) }),
        ]),
      ),
    ),
    ...Object.fromEntries(
      rgb.flatMap(([o, out]) =>
        mixSource.map(([s, source]) => [
          `channelMixer.${o}${s}`,
          t(L.mixFrom, { out: t(out), source: t(source) }),
        ]),
      ),
    ),
    ...Object.fromEntries(
      rgb.flatMap(([c, channel]) =>
        levels.map(([k, level]) => [
          `levelsRgb.${c}${k}`,
          t(L.channelLevel, { channel: t(channel), level: t(level) }),
        ]),
      ),
    ),
    "photoFilter.fr": t(L.filterRed),
    "photoFilter.fg": t(L.filterGreen),
    "photoFilter.fb": t(L.filterBlue),
    "photoFilter.preserve": t(L.preserveLuminosity),
    "curves.composite": t(L.compositeCurve),
    "curves.channels": t(L.channelCurves),
    order: t(L.order),
    pixelSource: t(L.pixelSource),
    fillOpacity: t(L.fillOpacity),
    knockout: t(L.knockout),
    colorLabel: t(L.colorLabel),
    lockTransparency: t(L.lockTransparency),
    lockPosition: t(L.lockPosition),
    lockAll: t(L.lockAll),
  };
}

/** Per-row presentation. The curves rows keep the typed list field (a
 *  number list; the channel tables as their JSON) rather than an items
 *  editor: both are nullable (null = curves off), and an items editor
 *  cannot start a list from null. */
const ROW_OPTIONS: Readonly<
  Record<string, Omit<PanelSchemaPropertyRow, "field" | "path" | "address">>
> = {
  blendMode: { style: "select" },
};

const layerList: PanelSchemaRow = {
  widget: "paged.list",
  list: {
    items: { kind: "binding", bind: BIND.layers },
    labelField: "name",
    secondaryField: "secondary",
    selectionBinding: BIND.layer,
  },
};

/** The adjustment sections, in panel order. */
const ADJUSTMENT_GROUPS = [
  "Tone",
  "Hue/saturation",
  "Hue/saturation ranges",
  "Colour balance",
  "Black & white",
  "Channel mixer",
  "Levels per channel",
  "Photo filter",
  "Curves",
  "Filters",
] as const;

/**
 * The panel's schema, in the editor's language at the time it is called
 * (the bundle contributes it on activation).
 */
export function imagePropertiesPanel(): PanelSchema {
  const rowLabels = labels();
  const rowsOf = (kind: string, group: string, address: PropertyFieldAddress) =>
    propertyRows(kind, pathsOf(group), address, {
      labels: rowLabels,
      row: (p) => ROW_OPTIONS[p] ?? {},
    });
  const title = (group: string) => t(GROUP_TITLES[group] ?? group);
  return {
    id: PROPERTIES_PANEL_ID,
    title: t(L.title),
    icon: "panel-properties",
    defaultDock: "right",
    sections: [
      {
        title: title("Layers"),
        // The blending options and locks sit with the layer's own rows.
        rows: [
          layerList,
          ...rowsOf(LAYER, "Layers", { bind: BIND.layer }),
          ...rowsOf(LAYER, "Blending", { bind: BIND.layer }),
        ],
      },
      {
        title: title("Mask"),
        visible: { bind: BIND.hasMask },
        rows: rowsOf(MASK, "Mask", { bind: BIND.mask }),
      },
      {
        title: title("Smart object"),
        visible: { bind: BIND.isSmart },
        rows: rowsOf(SMART, "Smart object", { bind: BIND.smartObject }),
      },
      ...ADJUSTMENT_GROUPS.map((group) => ({
        title: title(group),
        collapsible: true,
        visible: { bind: BIND.isAdjustment },
        rows: rowsOf(ADJUSTMENT, group, { bind: BIND.adjustment }),
      })),
    ],
  };
}

/** Keep the layer list and the picked layer's derived addresses live. */
export function publishPropertyLists(host: BundleHost): Disposable {
  const list = publishObjectList(host, {
    rows: BIND.layers,
    select: BIND.layer,
    selector: (sel) => (sel.length === 1 ? `${sel[0]} > ${LAYER}` : null),
    secondaryPath: "kind",
  });
  let generation = 0;
  const derive = async () => {
    const mine = ++generation;
    const chosen = host.bindings.get(BIND.layer);
    const a = typeof chosen === "string" ? parseImageAddress(chosen) : null;
    let kind: unknown = null;
    let hasMask: unknown = false;
    if (a && a.kind === "layer" && a.layerId !== null) {
      const [k, m] = await Promise.all([
        host.objects.get(chosen as string, "kind").catch(() => null),
        host.objects.get(chosen as string, "hasMask").catch(() => null),
      ]);
      kind = k?.kind === "value" ? k.value : null;
      hasMask = m?.kind === "value" ? m.value === true : false;
    }
    if (mine !== generation) return;
    const at = (
      k: "mask" | "adjustment" | "smartObject",
      on: boolean,
      bind: string,
    ) => {
      if (on && a && a.layerId !== null)
        host.bindings.publish(bind, layerAddress(k, a.frameId, a.layerId));
      else host.bindings.delete(bind);
    };
    at("mask", hasMask === true, BIND.mask);
    at("adjustment", kind === "adjustment", BIND.adjustment);
    at("smartObject", kind === "smart", BIND.smartObject);
    host.bindings.publish(BIND.hasMask, hasMask === true);
    host.bindings.publish(BIND.isAdjustment, kind === "adjustment");
    host.bindings.publish(BIND.isSmart, kind === "smart");
  };
  const subs = [
    host.bindings.onDidChange((name) => {
      if (name === BIND.layer) void derive();
    }),
    host.objects.onDidChange(() => void derive()),
  ];
  void derive();
  return {
    dispose() {
      generation++;
      list.dispose();
      for (const s of subs) s.dispose();
    },
  };
}
