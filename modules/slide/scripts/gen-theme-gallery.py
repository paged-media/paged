#!/usr/bin/env python3
# This file is part of paged (https://paged.media).
#
# paged is free software: you may redistribute it and/or modify it under the
# terms of the GNU Affero General Public License, version 3, as published by
# the Free Software Foundation, OR under the Paged Media Enterprise License
# (PMEL), a commercial license available from And The Next GmbH. Full
# copyright and license information is available in LICENSE.md, distributed
# with this source code.
#
#  @copyright  Copyright (c) And The Next GmbH
#  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
"""Write the Design gallery's themes (slide ADR 713) to
slide-resolve/themes/gallery.json.

  python3 scripts/gen-theme-gallery.py && ../../tooling/js/fmt.sh slide-resolve/themes/gallery.json

No Office theme file is vendored. Two gallery themes are read from the theme
part of OOXML packages already in this repository (their colour scheme and
their major and minor Latin fonts); the others are paged's own colour and
font schemes, written below, on the same twelve slots. The variants of every
theme are derived from it by slide-resolve (`theme::variants`), so they are
not listed here. Run from modules/slide.
"""
import json
import pathlib
import re
import zipfile

HERE = pathlib.Path(__file__).resolve().parent.parent
REPO = HERE.parent.parent
OUT = HERE / "slide-resolve" / "themes" / "gallery.json"

SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3",
         "accent4", "accent5", "accent6", "hlink", "folHlink"]

# (gallery id, package in the repository, the name the gallery shows)
FROM_PACKAGES = [
    ("office", "modules/slide/slide-conformance/fixtures/text.pptx", "Office"),
    ("office-2007", "modules/sheet/corpus/xlsx-recalc/54686_fraction_formats.xls.xlsx",
     "Office 2007 – 2010"),
]

# paged's own schemes: dk1 lt1 dk2 lt2, accents 1–6, hyperlink, followed.
OWN = [
    ("paper", "Paper", "Georgia", "Verdana",
     "1B1B1B FFFFFF 3A3226 F3EEE4 B5523B D99A2B 5B7F4A 3F6E8C 8A5A83 7A6F5D 2F5D86 7D5A7A"),
    ("slate", "Slate", "Trebuchet MS", "Trebuchet MS",
     "000000 FFFFFF 1F2A36 DDE3EA 2E86AB F18F01 C73E1D 3B1F2B 6A994E A23B72 1D70A2 6C4F70"),
    ("harbour", "Harbour", "Palatino Linotype", "Segoe UI",
     "0A0A0A FFFFFF 12355B E4EEF5 1B9AAA 06D6A0 FFC43D EF476F 26547C 8D99AE 1B6CA8 5E548E"),
    ("meadow", "Meadow", "Gill Sans MT", "Gill Sans MT",
     "141414 FFFFFF 2D4030 EEF2E6 6A8D3A C9A227 A4573A 4F7CAC 8C6E9E 3E8E7E 3F7D3A 7F6A8C"),
]


def theme_part(path: pathlib.Path) -> str:
    with zipfile.ZipFile(path) as z:
        name = sorted(n for n in z.namelist() if re.search(r"theme/theme\d*\.xml$", n))[0]
        return z.read(name).decode("utf-8")


def read(xml: str) -> dict:
    scheme = re.search(r"<a:clrScheme [^>]*>(.*?)</a:clrScheme>", xml, re.S).group(1)
    colors = []
    for slot in SLOTS:
        body = re.search(rf"<a:{slot}>(.*?)</a:{slot}>", scheme, re.S).group(1)
        m = re.search(r'lastClr="([0-9A-Fa-f]{6})"', body) or re.search(
            r'val="([0-9A-Fa-f]{6})"', body)
        colors.append([slot, m.group(1).upper()])
    font = lambda which: re.search(
        rf"<a:{which}>\s*<a:latin typeface=\"([^\"]*)\"", xml, re.S).group(1)
    return {"colors": colors, "major": font("majorFont"), "minor": font("minorFont")}


def main() -> None:
    themes = []
    for gid, rel, name in FROM_PACKAGES:
        t = read(theme_part(REPO / rel))
        themes.append({"id": gid, "name": name, **t, "source": rel})
    for gid, name, major, minor, hexes in OWN:
        themes.append({
            "id": gid,
            "name": name,
            "colors": [[s, h] for s, h in zip(SLOTS, hexes.split())],
            "major": major,
            "minor": minor,
            "source": "paged",
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    lines = ",\n".join("  " + json.dumps(t, ensure_ascii=True) for t in themes)
    OUT.write_text('{"themes": [\n' + lines + "\n]}\n")
    print(f"{OUT.relative_to(HERE)}: {len(themes)} themes")


if __name__ == "__main__":
    main()
