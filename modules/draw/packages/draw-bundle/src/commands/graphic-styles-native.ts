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

// GRAPHIC STYLE LIBRARIES — import, export and merge (draw ADR 367, plan
// WP6.3), over the native-appearance styles of `graphic-styles.ts`.
//
// A LIBRARY FILE is the library part's own JSON with a marker:
//
//   { "paged": "graphicStyles", "v": 2, "styles": [ … ] }
//
// so a file another document exported, and a bare library part, both
// import. IMPORT adds every style of the file under a fresh id (a name
// already in the library gets " 2", " 3", …) — nothing in the document
// is linked or changed, so it is a library write only (outside the undo
// stack, like every library write). EXPORT writes the whole library, or
// the styles named, through the host's save door (and answers the JSON,
// so a typed caller and a test need no file system).
//
// MERGE is Illustrator's Merge Graphic Styles: a NEW style whose
// appearance is the named styles' in order — the first one's base and
// layers, then each following style's fills and strokes on top (its own
// fill and stroke, which the first one's placeholders hold, become real
// layers), and every style's effects in order. The merged styles stay.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import { explicitLayers, type NativePaintLayer } from "./appearance-native";
import {
  graphicStyleRefOf,
  mintGraphicStyleId,
  nativeStyleOf,
  parseGraphicStyleLibrary,
  readGraphicStyleLibrary,
  upsertGraphicStyle,
  writeGraphicStyleLibrary,
  GRAPHIC_STYLES_COMMAND_CATEGORY,
  GRAPHIC_STYLES_LIBRARY_VERSION_NATIVE,
  type GraphicStyle,
  type GraphicStyleLibrary,
} from "./graphic-styles";

const M = defineMessages("draw.graphicStyleLibrary", {
  import: "Graphic Styles: Import library…",
  export: "Graphic Styles: Export library…",
  merge: "Graphic Styles: Merge styles",
});

const C = "media.paged.draw.command";
export const IMPORT_GRAPHIC_STYLES_COMMAND_ID = `${C}.importGraphicStyles`;
export const EXPORT_GRAPHIC_STYLES_COMMAND_ID = `${C}.exportGraphicStyles`;
export const MERGE_GRAPHIC_STYLES_COMMAND_ID = `${C}.mergeGraphicStyles`;
export const GRAPHIC_STYLE_LIBRARY_COMMAND_IDS = [
  IMPORT_GRAPHIC_STYLES_COMMAND_ID,
  EXPORT_GRAPHIC_STYLES_COMMAND_ID,
  MERGE_GRAPHIC_STYLES_COMMAND_ID,
] as const;

/** The marker a library file carries. */
export const GRAPHIC_STYLE_FILE_MARKER = "graphicStyles";
/** The file name an export suggests. */
export const GRAPHIC_STYLE_FILE_NAME = "graphic-styles.json";

/** A library file's text for `styles`. Pure. */
export function graphicStyleFileOf(styles: readonly GraphicStyle[]): string {
  return `${JSON.stringify(
    {
      paged: GRAPHIC_STYLE_FILE_MARKER,
      v: GRAPHIC_STYLES_LIBRARY_VERSION_NATIVE,
      styles: styles.map(nativeStyleOf),
    },
    null,
    2,
  )}\n`;
}

/** The styles of a library file (or a bare library part), every one on
 *  native appearance; null when the text is no library. Pure. */
export function parseGraphicStyleFile(text: string): GraphicStyle[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const marker = (raw as { paged?: unknown }).paged;
  if (marker !== undefined && marker !== GRAPHIC_STYLE_FILE_MARKER) return null;
  if (!Array.isArray((raw as { styles?: unknown }).styles)) return null;
  const lib = parseGraphicStyleLibrary(new TextEncoder().encode(text));
  return lib.styles.map(nativeStyleOf);
}

/** `library` with `styles` added under fresh ids, a taken name numbered.
 *  Pure. */
export function importStylesInto(
  library: GraphicStyleLibrary,
  styles: readonly GraphicStyle[],
): { library: GraphicStyleLibrary; added: GraphicStyle[] } {
  let lib = library;
  const added: GraphicStyle[] = [];
  for (const st of styles) {
    const names = new Set(lib.styles.map((x) => x.name));
    let name = st.name;
    for (let n = 2; names.has(name); n++) name = `${st.name} ${n}`;
    const copy: GraphicStyle = { ...st, id: mintGraphicStyleId(lib), name };
    lib = upsertGraphicStyle(lib, copy);
    added.push(copy);
  }
  return { library: lib, added };
}

/** A placeholder of `style` as the real layer its base paint is. */
function realLayer(
  l: NativePaintLayer,
  style: GraphicStyle,
): NativePaintLayer | null {
  const b = style.appearance.base;
  const t = style.appearance.targets;
  if (l.kind === "frameFill") {
    if (!b.fill) return null;
    return {
      kind: "fill",
      ...(l.enabled === false ? { enabled: false } : {}),
      color: b.fill,
      ...(b.fillTint != null ? { tint: b.fillTint } : {}),
      ...(t?.fillOpacity != null ? { opacityPct: t.fillOpacity } : {}),
      ...(t?.fillBlendMode ? { blendMode: t.fillBlendMode } : {}),
    };
  }
  if (l.kind === "frameStroke") {
    if (!b.stroke) return null;
    return {
      kind: "stroke",
      ...(l.enabled === false ? { enabled: false } : {}),
      color: b.stroke,
      weight: b.strokeWeight ?? 1,
      ...(t?.strokeOpacity != null ? { opacityPct: t.strokeOpacity } : {}),
      ...(t?.strokeBlendMode ? { blendMode: t.strokeBlendMode } : {}),
    };
  }
  return { ...l };
}

/** Illustrator's Merge Graphic Styles (see the header). Pure. */
export function mergeGraphicStyles(
  styles: readonly GraphicStyle[],
  id: string,
  name: string,
): GraphicStyle {
  const all = styles.map(nativeStyleOf);
  const first = all[0]!;
  const layers: NativePaintLayer[] = explicitLayers(
    first.appearance.layers ?? [],
  );
  const effects = [...(first.appearance.effects ?? [])];
  for (const st of all.slice(1)) {
    for (const l of explicitLayers(st.appearance.layers ?? [])) {
      const real = realLayer(l, st);
      if (real) layers.push(real);
    }
    effects.push(...(st.appearance.effects ?? []));
  }
  return {
    id,
    name,
    appearance: {
      stack: { fills: [], strokes: [] },
      base: { ...first.appearance.base },
      layers,
      effects,
      ...(first.appearance.targets
        ? { targets: { ...first.appearance.targets } }
        : {}),
    },
  };
}

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** IMPORT: the styles of `json` (or of the file the user picks). */
export async function importGraphicStyles(
  host: BundleHost,
  json?: string,
): Promise<GraphicStyle[]> {
  const label = IMPORT_GRAPHIC_STYLES_COMMAND_ID;
  let text = json;
  if (text === undefined) {
    const files = await host.shell
      .pickFile({ accept: [".json"] })
      .catch(() => []);
    if (files.length === 0) return [];
    text = textOf(files[0]!.bytes);
  }
  const styles = parseGraphicStyleFile(text);
  if (!styles) {
    host.log.warn(`${label}: the file is not a graphic style library`);
    throw new Error(`${label}: the file is not a graphic style library`);
  }
  const { library, added } = importStylesInto(
    await readGraphicStyleLibrary(host),
    styles,
  );
  if (added.length > 0 && !(await writeGraphicStyleLibrary(host, library)))
    return [];
  host.log.info(`${label}: ${added.length} style(s) added to the library`);
  return added;
}

/** EXPORT: the library (or the styles named) as a file; answers its text. */
export async function exportGraphicStyles(
  host: BundleHost,
  ids?: readonly string[],
  save = true,
): Promise<string> {
  const library = await readGraphicStyleLibrary(host);
  const styles =
    ids && ids.length > 0
      ? library.styles.filter((st) => ids.includes(st.id))
      : library.styles;
  const text = graphicStyleFileOf(styles);
  if (save)
    await host.shell
      .saveFile({
        suggestedName: GRAPHIC_STYLE_FILE_NAME,
        bytes: new TextEncoder().encode(text),
        mimeType: "application/json",
      })
      .catch(() => false);
  return text;
}

/** MERGE: a new style from the named ones, in their order. */
export async function mergeGraphicStylesIn(
  host: BundleHost,
  ids: readonly string[],
  name?: string,
): Promise<GraphicStyle | null> {
  const label = MERGE_GRAPHIC_STYLES_COMMAND_ID;
  const library = await readGraphicStyleLibrary(host);
  const picked = ids
    .map((id) => library.styles.find((st) => st.id === id))
    .filter((st): st is GraphicStyle => !!st);
  if (picked.length < 2) {
    host.log.warn(`${label}: name two styles or more to merge`);
    throw new Error(`${label}: name two styles or more to merge`);
  }
  const merged = mergeGraphicStyles(
    picked,
    mintGraphicStyleId(library),
    name && name.trim() ? name.trim() : picked.map((st) => st.name).join(" + "),
  );
  if (
    !(await writeGraphicStyleLibrary(host, upsertGraphicStyle(library, merged)))
  )
    return null;
  return merged;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function contributeGraphicStyleLibraryCommands(
  host: BundleHost,
): Disposable {
  const payloadOf = (p: unknown) =>
    (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const subs = [
    registerCommand(host, {
      id: IMPORT_GRAPHIC_STYLES_COMMAND_ID,
      title: M.import,
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        const json = payloadOf(payload).json;
        const added = await importGraphicStyles(
          host,
          typeof json === "string" && json.length > 0 ? json : undefined,
        );
        return added.map((st) => st.id);
      },
    }),
    registerCommand(host, {
      id: EXPORT_GRAPHIC_STYLES_COMMAND_ID,
      title: M.export,
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        const p = payloadOf(payload);
        return exportGraphicStyles(host, strings(p.styles), p.save !== false);
      },
    }),
    registerCommand(host, {
      id: MERGE_GRAPHIC_STYLES_COMMAND_ID,
      title: M.merge,
      category: GRAPHIC_STYLES_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        const p = payloadOf(payload);
        let ids = strings(p.styles);
        // From the palette (no styles named): the styles the selected
        // objects follow, in selection order.
        if (ids.length === 0) {
          for (const id of host.selection.get()) {
            const ref = graphicStyleRefOf(
              await host.document.getMetadata(id).catch(() => null),
            );
            if (ref && !ids.includes(ref.id)) ids = [...ids, ref.id];
          }
          if (ids.length < 2) {
            host.log.info(
              `${MERGE_GRAPHIC_STYLES_COMMAND_ID}: select objects that follow two styles or more, or check them in the Graphic Styles panel`,
            );
            return null;
          }
        }
        const merged = await mergeGraphicStylesIn(
          host,
          ids,
          typeof p.name === "string" ? p.name : undefined,
        );
        return merged?.id ?? null;
      },
    }),
  ];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
