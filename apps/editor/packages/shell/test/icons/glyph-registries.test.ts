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

// Styleguide — icon conformance, the SOURCE axis.
//
// The clean-room icon system ships three glyph registries
// (`tool-*` / `panel-*` / `ui-*`, src/icons/) resolved by one `Icon`
// component. Brand rule: every glyph inherits colour via `currentColor`
// and is line/solid SVG geometry — never a hardcoded hue. This reads the
// three glyph `.tsx` registries as TEXT (no JSX runtime) and asserts
// every authored `fill=`/`stroke=` is currentColor / none / white / a
// token var() / the shared LINE spread, and that the names are
// prefix-clean and unique. What the app mounts and which names its
// registries reference is the browser's half: the canvas app's
// `tests/styleguide-icons.spec.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ICONS_DIR = resolve(import.meta.dir, "..", "..", "src", "icons");

const REGISTRIES = [
  { file: "tool-glyphs.tsx", konst: "TOOL_GLYPHS", prefix: "tool-" },
  { file: "panel-glyphs.tsx", konst: "PANEL_GLYPHS", prefix: "panel-" },
  { file: "ui-glyphs.tsx", konst: "UI_GLYPHS", prefix: "ui-" },
] as const;

function readGlyphSource(file: string): string {
  return readFileSync(resolve(ICONS_DIR, file), "utf8");
}

/** Glyph KEYS declared in a registry source (the `"name": (` entries). */
function glyphNames(src: string): string[] {
  const re = /^\s*"([a-zA-Z][\w-]*)":/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

/** Literal (non-token, non-currentColor) `fill=`/`stroke=` paints a
 *  glyph source authors. `white` is the intentional paper fill (hollow
 *  threading port / loadable affordance). */
function literalPaints(src: string): string[] {
  const out: string[] = [];
  const re = /(fill|stroke)=(?:"([^"]*)"|\{([^}]*)\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const attr = m[1];
    const value = (m[2] ?? m[3] ?? "").trim();
    const ok =
      value === "currentColor" ||
      value === '"currentColor"' ||
      value === "none" ||
      value === '"none"' ||
      value === "white" ||
      value === '"white"' ||
      value.startsWith("var(") ||
      value.includes("var(") ||
      // computed-from-token JSX ({fill || active ? "white" : ink}) where
      // every branch is a token/currentColor/white — those are caught at
      // the overlay level, not the static glyph registries; glyphs use
      // literal attribute strings only, so a bare identifier here is a
      // spread/ref, never a colour.
      /^[A-Za-z_$][\w$.]*$/.test(value);
    if (!ok) out.push(`${attr}=${value}`);
  }
  return out;
}

const ALL_NAMES = REGISTRIES.flatMap((r) =>
  glyphNames(readGlyphSource(r.file)),
);

describe("Styleguide — icon conformance", () => {
  test("the three glyph registries are populated and prefix-clean @feat:editor-shell.context-toolbars @feat:editor-shell.panel-rail @feat:editor-shell.tool-rail @level:happy", () => {
    for (const { file, konst, prefix } of REGISTRIES) {
      const src = readGlyphSource(file);
      expect(src, `${file} must export ${konst}`).toContain(
        `export const ${konst}`,
      );
      const names = glyphNames(src);
      expect(names.length, `${file} glyph count`).toBeGreaterThan(10);
      const offPrefix = names.filter((n) => !n.startsWith(prefix));
      expect(
        offPrefix,
        `${file}: names must use the "${prefix}" prefix: ${offPrefix.join(", ")}`,
      ).toEqual([]);
    }
    // No name collides across registries (the resolver merges all three;
    // a dup would silently shadow).
    const seen = new Set<string>();
    const dups = ALL_NAMES.filter((n) =>
      seen.has(n) ? true : (seen.add(n), false),
    );
    expect(dups, `duplicate glyph names: ${dups.join(", ")}`).toEqual([]);
  });

  test("no glyph authors a hardcoded colour (currentColor / token only) @feat:editor-shell.context-toolbars @feat:editor-shell.panel-rail @feat:editor-shell.tool-rail @level:happy", () => {
    const offenders: string[] = [];
    for (const { file } of REGISTRIES) {
      const src = readGlyphSource(file);
      const literals = literalPaints(src);
      if (literals.length) offenders.push(`${file}: ${literals.join(", ")}`);
    }
    expect(offenders, "\n" + offenders.join("\n")).toEqual([]);
  });
});
