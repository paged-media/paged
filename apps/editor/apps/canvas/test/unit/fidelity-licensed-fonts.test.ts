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

// The canvas fidelity gate's licensed-font contract (tests/fidelity/fonts.ts):
// a pack's fonts.sh may declare `LICENSED_FONTS=("Name=path")`, the faces its
// reference PDF was set in that the corpus may not ship. A pack missing one
// reports `unavailable: font: needs licensed font <Name>` and is neither
// passed nor failed; PAGED_REQUIRE_FONTS=1 fails it. The same layout is read
// by engine/core/scripts/pack-fidelity.py (test_pack_fidelity.py).

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  licensedFontsUnavailable,
  missingLicensedFonts,
  parseFontsSh,
  sourceFontsSh,
  type PackFonts,
} from "../../tests/fidelity/fonts";

let dir: string;
let fontsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "licensed-fonts-"));
  fontsDir = join(dir, "fonts");
  mkdirSync(fontsDir);
  writeFileSync(join(fontsDir, "Stand-In.ttf"), "\0\x01\0\0");
});

function fontsSh(facePath: string): string {
  const path = join(dir, "fonts.sh");
  writeFileSync(
    path,
    [
      'DEFAULT_FONT="$FONTS/Stand-In.ttf"',
      `FACE="${facePath}"`,
      'LICENSED_FONTS=("Licensed Sans=$FACE")',
      '[ -n "$FACE" ] || FACE="$FONTS/Stand-In.ttf"',
      'FONT_FLAGS=(--font-family "Body=$FACE" --font-family "Head/Bold=$FONTS/Stand-In.ttf")',
      "",
    ].join("\n"),
  );
  return path;
}

function installedFace(): string {
  const face = join(dir, "with space", "Licensed.otf");
  mkdirSync(join(dir, "with space"));
  writeFileSync(face, "OTTO");
  return face;
}

describe("sourceFontsSh reads LICENSED_FONTS", () => {
  test("a face the machine has: path, flags and default", () => {
    const face = installedFace();
    const fonts = sourceFontsSh(fontsSh(face), fontsDir);
    expect(fonts).not.toBeNull();
    expect(fonts!.defaultFontPath).toBe(join(fontsDir, "Stand-In.ttf"));
    expect(fonts!.licensedFonts).toEqual([
      { name: "Licensed Sans", path: face },
    ]);
    expect(fonts!.mappings).toEqual([
      { family: "Body", style: null, ttfPath: face },
      {
        family: "Head",
        style: "Bold",
        ttfPath: join(fontsDir, "Stand-In.ttf"),
      },
    ]);
  });

  test("a face the machine lacks: empty path, stand-in flags", () => {
    const fonts = sourceFontsSh(fontsSh(""), fontsDir)!;
    expect(fonts.licensedFonts).toEqual([{ name: "Licensed Sans", path: "" }]);
    expect(fonts.mappings[0].ttfPath).toBe(join(fontsDir, "Stand-In.ttf"));
  });

  test("a fonts.sh without the declaration has none", () => {
    const path = join(dir, "plain.sh");
    writeFileSync(path, 'FONT_FLAGS=(--font-family "A=$FONTS/Stand-In.ttf")\n');
    const fonts = sourceFontsSh(path, fontsDir)!;
    expect(fonts.licensedFonts).toEqual([]);
    expect(fonts.mappings).toHaveLength(1);
  });

  test("the shell-less parser counts a declared face as missing", () => {
    const fonts = parseFontsSh(readFileSync(fontsSh(installedFace()), "utf8"));
    expect(fonts.licensedFonts).toEqual([{ name: "Licensed Sans", path: "" }]);
  });
});

describe("licensedFontsUnavailable", () => {
  const withFace = (path: string): PackFonts => ({
    defaultFontPath: join(fontsDir, "Stand-In.ttf"),
    mappings: [],
    licensedFonts: [{ name: "Licensed Sans", path }],
  });

  test("present face: nothing to report", () => {
    expect(
      licensedFontsUnavailable("pack", withFace(installedFace()), {}),
    ).toBeNull();
  });

  test("missing face: the unavailable line, logged to PAGED_SKIP_LOG", () => {
    const log = join(dir, "skips.tsv");
    const line = licensedFontsUnavailable("pack", withFace(""), {
      PAGED_SKIP_LOG: log,
    });
    expect(line).toBe("unavailable: font: needs licensed font Licensed Sans");
    expect(readFileSync(log, "utf8")).toBe(
      "canvas-fidelity\tpack\tFONTS\tunavailable: font: needs licensed font Licensed Sans\n",
    );
  });

  test("a path that no longer exists counts as missing", () => {
    expect(missingLicensedFonts(withFace(join(dir, "gone.otf")), {})).toEqual([
      "Licensed Sans",
    ]);
  });

  test("PAGED_REQUIRE_FONTS=1 fails instead of skipping", () => {
    expect(() =>
      licensedFontsUnavailable("pack", withFace(""), {
        PAGED_REQUIRE_FONTS: "1",
      }),
    ).toThrow(/PAGED_REQUIRE_FONTS=1.*fails/);
  });

  test("PAGED_FORCE_NO_LICENSED_FONTS=1 hides an installed face", () => {
    expect(
      licensedFontsUnavailable("pack", withFace(installedFace()), {
        PAGED_FORCE_NO_LICENSED_FONTS: "1",
      }),
    ).toBe("unavailable: font: needs licensed font Licensed Sans");
  });
});
