# Feature fixtures

Each deck here was **written by PowerPoint**: `scripts/fixtures/<name>.applescript` builds it
through PowerPoint's scripting dictionary and saves it (ADR 705). Recorded with it:

| File | What |
|---|---|
| `<name>.pptx` | the deck PowerPoint saved |
| `<name>.ppt.pdf` | PowerPoint's PDF of it |
| `<name>.ppt.json` | every top-level shape's position, size, rotation, type, autofit mode and effective first-run size |
| `<name>.baselines.json` | (where recorded) each text box's first baseline below its top inset and its line pitch, read from the PDF by `scripts/ppt-baseline-probe.py`; positions carry the PDF's 0.96 pt quantum |
| `<name>.provenance.json` | PowerPoint version, date, the authoring script, the fonts that reached the PDF |

| Fixture | Exercises |
|---|---|
| `geometry` | all 182 preset geometries in PowerPoint's dictionary, 32 per slide, each labelled |
| `text` | list levels 1–5 and speaker notes; alignment; line spacing 150 % / 80 %, space before/after; a body placeholder PowerPoint shrinks on overflow; vertical anchors; margins; shape-to-fit |
| `placeholders` | one slide per built-in layout with every placeholder filled; a moved and resized title |
| `baselines` | one slide per font (Calibri, Aptos, Arial, Georgia, Space Grotesk): sizes 12 / 36 / 72 pt × line spacing 80 / 100 / 120 / 150 %, two lines per top-anchored box |
| `motion` | fade, push, wipe and cut transitions with durations; appear / fade builds on click, with previous and after previous |

Re-record (a Mac with PowerPoint): `bash scripts/ppt-author-fixtures.sh [name ...]`; then, for
`baselines`, `python3 scripts/ppt-baseline-probe.py baselines.pptx baselines.ppt.pdf > baselines.baselines.json`
(needs pdfplumber).

Not authorable through PowerPoint's dictionary, so covered by the corpus decks instead:
tables (PowerPoint cannot create one from AppleScript), charts, embedded fonts.
