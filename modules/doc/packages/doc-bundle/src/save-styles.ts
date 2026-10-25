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

// Save-back of the document's styles (doc ADR 610). The engine compares
// each Word style's own properties as the host reads them
// (`document.styleProperties`) with what the import gave it and splices
// the changes into `styles.xml`; a style made in paged is appended there.
// This file only reads: which styles to read comes from the engine.

import type { BundleHost } from "@paged-media/plugin-api";

/** One style as the host reads it, the shape docx-js takes (`styles`). */
export interface StyleRead {
  collection: "paragraph" | "character";
  styleId: string;
  name?: string | null;
  basedOn?: string | null;
  entries: Array<{ path: string; value?: unknown }>;
}

/** Whether a style id is the engine's own (`[No paragraph style]`, …). */
function engineBuiltin(id: string): boolean {
  const name = id.slice(id.lastIndexOf("/") + 1);
  return name.startsWith("[") || id.includes("$ID/");
}

/**
 * Read the document's styles for save-back: the Word styles (`tokens`,
 * from the engine) and every paragraph or character style made in paged
 * (not one of the import's `…/docx-…` styles, not the engine's own).
 * Empty on a host without the style read.
 */
export async function readStyles(
  host: BundleHost,
  tokens: readonly string[],
): Promise<StyleRead[]> {
  if (!host.supports("document.styleProperties@1")) return [];
  const wanted: Array<["paragraph" | "character", string]> = [];
  for (const t of tokens)
    wanted.push([
      t.startsWith("CharacterStyle/") ? "character" : "paragraph",
      t,
    ]);
  for (const [collection, name] of [
    ["paragraph", "paragraphStyles"],
    ["character", "characterStyles"],
  ] as const) {
    try {
      const all = await host.document.collection<{ selfId: string }>(name);
      for (const s of all)
        if (!s.selfId.includes("/docx-") && !engineBuiltin(s.selfId))
          wanted.push([collection, s.selfId]);
    } catch {
      // no collection read: the Word styles alone
    }
  }
  const out: StyleRead[] = [];
  for (const [collection, id] of wanted) {
    try {
      const p = await host.document.styleProperties(collection, id);
      if (!p) continue;
      out.push({
        collection,
        styleId: p.styleId,
        name: p.name ?? null,
        basedOn: p.basedOn ?? null,
        entries: p.entries.map((e) => ({ path: e.path, value: e.value })),
      });
    } catch {
      // an unreadable style keeps its Word definition
    }
  }
  return out;
}

/** The swatch ids the styles fill their text with (`characterFillColor`). */
export function styleColors(styles: readonly StyleRead[]): string[] {
  const ids = new Set<string>();
  for (const s of styles)
    for (const e of s.entries) {
      const v = e.value as
        { type?: string; value?: unknown } | null | undefined;
      if (
        e.path === "characterFillColor" &&
        v?.type === "colorRef" &&
        typeof v.value === "string" &&
        v.value.length > 0
      )
        ids.add(v.value);
    }
  return [...ids];
}
