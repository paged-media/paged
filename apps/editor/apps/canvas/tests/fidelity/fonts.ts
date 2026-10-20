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

// Read a per-pack `corpus/config/overrides/<pack>/fonts.sh` and
// resolve every declared `--font-family "Family=path"` entry to an
// absolute TTF on disk plus its IDML family / style key.
//
// This is the substitution path: it mirrors what `corpus/harness/test.sh`
// and the engine's pack lane (`engine/core/scripts/pack-fidelity.py`)
// hand to `paged-inspect --font-family ...` — by SOURCING the file with
// bash, as they do, so a fonts.sh that picks a face by what the machine
// has (Myriad Pro from an installed InDesign, the face a baked reference
// PDF was exported in) means the same thing in every lane. The Playwright suite
// loads these bytes via the wasm `registerFont` method so the canvas
// renders against the exact same fonts the reference PDF was exported
// with. Without this step the renderer's default-font fallback would
// dominate ΔE for every pack whose declared fonts differ from Inter.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OVERRIDES_DIR, corpusFontsDir } from "./fixtures";

export interface FontMapping {
  /** IDML `AppliedFont` family name (e.g. "Poppins"). */
  family: string;
  /** Optional style string (e.g. "Bold", "Italic"). Null = bare family. */
  style: string | null;
  /** Absolute path to the TTF/OTF on disk. */
  ttfPath: string;
}

export interface PackFonts {
  /** Absolute path to the default-font TTF (used as the fallback). */
  defaultFontPath: string;
  /** Per-(family, style) substitutions, in fonts.sh declaration order. */
  mappings: FontMapping[];
}

/**
 * Read the per-pack fonts.sh; fall back to overrides/_default/fonts.sh
 * when the pack has no sidecar. Mirrors the dispatch in test.sh.
 */
export function loadPackFonts(packName: string): PackFonts {
  const candidate = resolve(OVERRIDES_DIR, packName, "fonts.sh");
  const fallback = resolve(OVERRIDES_DIR, "_default", "fonts.sh");
  const path = existsSync(candidate) ? candidate : fallback;
  return sourceFontsSh(path) ?? parseFontsSh(readFileSync(path, "utf8"));
}

/**
 * Source fonts.sh with bash, the way pack-fidelity.py does, and read
 * back `DEFAULT_FONT` and `FONT_FLAGS` (NUL-separated). `null` when bash
 * is not available, so the line parser below stands in.
 */
export function sourceFontsSh(path: string): PackFonts | null {
  const fontsDir = corpusFontsDir();
  let out: string;
  try {
    out = execFileSync(
      "bash",
      [
        "-c",
        'DEFAULT_FONT=""; FONT_FLAGS=(); . "$1"; ' +
          'printf "%s\\0" "${DEFAULT_FONT:-$FONTS/Inter.ttf}" ${FONT_FLAGS[@]+"${FONT_FLAGS[@]}"}',
        "fonts",
        path,
      ],
      { env: { ...process.env, FONTS: fontsDir }, encoding: "utf8" },
    );
  } catch {
    return null;
  }
  const [defaultFontPath, ...flags] = out.split("\0").filter((x) => x !== "");
  const mappings: FontMapping[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== "--font-family" || i + 1 >= flags.length) continue;
    const arg = flags[(i += 1)];
    const eq = arg.indexOf("=");
    if (eq < 0) continue;
    const lhs = arg.slice(0, eq).trim();
    const slash = lhs.indexOf("/");
    mappings.push({
      family: (slash >= 0 ? lhs.slice(0, slash) : lhs).trim(),
      style: slash >= 0 ? lhs.slice(slash + 1).trim() : null,
      ttfPath: arg.slice(eq + 1).trim(),
    });
  }
  return {
    defaultFontPath: defaultFontPath || resolve(fontsDir, "Inter.ttf"),
    mappings,
  };
}

/**
 * Parse fonts.sh source without a shell (the fallback when bash is not
 * there to source it). The format is constrained by hand-edit
 * conventions: one `--font-family "Family[/Style]=...path"` argument
 * per line inside `FONT_FLAGS=(…)`, plus a leading `DEFAULT_FONT="…"`
 * assignment. We use line-by-line regex; full bash semantics would be
 * massive overkill (no variable expansion, no quotes-in-quotes
 * survival).
 */
export function parseFontsSh(src: string): PackFonts {
  const fontsDir = corpusFontsDir();
  // $FONTS expands to corpus/fonts/. $ROOT/corpus/fonts/... is also
  // valid in test.sh; expand it the same way here.
  const expandPath = (p: string): string => {
    let s = p;
    s = s.replace(/^\$FONTS/, fontsDir);
    s = s.replace(/^\$\{FONTS\}/, fontsDir);
    s = s.replace(/^\$ROOT\/corpus\/fonts/, fontsDir);
    return s;
  };

  let defaultFontPath = "";
  const mappings: FontMapping[] = [];

  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const def = /^DEFAULT_FONT=(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(line);
    if (def) {
      defaultFontPath = expandPath(def[1] ?? def[2] ?? def[3]);
      continue;
    }
    // Match: --font-family "Family[/Style]=PATH"
    const ff = /--font-family\s+"([^"=]+)=([^"]+)"/.exec(line);
    if (ff) {
      const lhs = ff[1].trim();
      const ttf = expandPath(ff[2].trim());
      let family = lhs;
      let style: string | null = null;
      const slash = lhs.indexOf("/");
      if (slash >= 0) {
        family = lhs.slice(0, slash).trim();
        style = lhs.slice(slash + 1).trim();
      }
      mappings.push({ family, style, ttfPath: ttf });
    }
  }

  if (!defaultFontPath) {
    defaultFontPath = resolve(fontsDir, "Inter.ttf");
  }
  return { defaultFontPath, mappings };
}
