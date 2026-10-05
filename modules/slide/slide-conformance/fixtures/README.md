# Feature fixtures

Each deck here was **written by PowerPoint**: `scripts/fixtures/<name>.applescript` builds it
through PowerPoint's scripting dictionary and saves it (ADR 705). Recorded with it:

| File | What |
|---|---|
| `<name>.pptx` | the deck PowerPoint saved |
| `<name>.ppt.pdf` | PowerPoint's PDF of it |
| `<name>.ppt.json` | every top-level shape's position, size, rotation, type, autofit mode and effective first-run size |
| `<name>.provenance.json` | PowerPoint version, date, the authoring script, the fonts that reached the PDF |

| Fixture | Exercises |
|---|---|
| `geometry` | all 182 preset geometries in PowerPoint's dictionary, 32 per slide, each labelled |
| `text` | list levels 1–5 and speaker notes; alignment; line spacing 150 % / 80 %, space before/after; a body placeholder PowerPoint shrinks on overflow; vertical anchors; margins; shape-to-fit |
| `placeholders` | one slide per built-in layout with every placeholder filled; a moved and resized title |
| `motion` | fade, push, wipe and cut transitions with durations; appear / fade builds on click, with previous and after previous |

Re-record (a Mac with PowerPoint): `bash scripts/ppt-author-fixtures.sh [name ...]`.

Not authorable through PowerPoint's dictionary, so covered by the corpus decks instead:
tables (PowerPoint cannot create one from AppleScript), charts, embedded fonts.
