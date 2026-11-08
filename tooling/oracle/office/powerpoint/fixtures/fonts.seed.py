#!/usr/bin/env python3
"""Turn on "embed fonts in the file" in PowerPoint's deck (fixtures: fonts,
fonts-full).

  python3 fonts.seed.py <deck.pptx> <seed.pptx> [full]

PowerPoint's dictionary has no property for font embedding, but the
presentation part carries it: `embedTrueTypeFonts="1"` makes PowerPoint
embed every font the deck's text uses when it saves, and `saveSubsetFonts`
whether only the characters used go in (PowerPoint's default). With "full"
every glyph is embedded. PowerPoint then saves the deck again
(embed-resave.applescript) and writes the faces itself."""
import re, sys, zipfile

src, dst = sys.argv[1], sys.argv[2]
full = len(sys.argv) > 3 and sys.argv[3] == "full"
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == "ppt/presentation.xml":
        xml = data.decode("utf-8")
        xml = re.sub(r'\s(embedTrueTypeFonts|saveSubsetFonts)="[^"]*"', "", xml)
        flags = ' embedTrueTypeFonts="1"' + ("" if full else ' saveSubsetFonts="1"')
        xml = xml.replace("<p:presentation ", "<p:presentation" + flags + " ", 1)
        data = xml.encode("utf-8")
    zout.writestr(item, data)
zout.close()
