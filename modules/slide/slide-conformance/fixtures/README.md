# Feature fixtures

Each deck here was **written by PowerPoint**: `scripts/fixtures/<name>.applescript` builds it
through PowerPoint's scripting dictionary and saves it (ADR 705). Recorded with it:

| File | What |
|---|---|
| `<name>.pptx` | the deck PowerPoint saved |
| `<name>.ppt.pdf` | PowerPoint's PDF of it |
| `<name>.ppt.json` | every top-level shape's position, size, rotation, type, autofit mode and effective first-run size |
| `<name>.baselines.json` | (where recorded) each text box's first baseline below its top inset and its line pitch, read from the PDF by `scripts/ppt-baseline-probe.py`; positions carry the PDF's 0.96 pt quantum |
| `<name>.frames.json` | (where recorded) each chart or SmartArt frame's box, the filled rectangles PowerPoint drew in it and its text colours, by `scripts/ppt-chart-probe.py` |
| `<name>.tables.json` | (where recorded) every table cell's colour on PowerPoint's page and its text's weight and colour, and every border segment, by `scripts/ppt-table-probe.py` |
| `<name>.provenance.json` | PowerPoint version, date, the authoring script, the fonts that reached the PDF |

| Fixture | Exercises |
|---|---|
| `geometry` | all 182 preset geometries in PowerPoint's dictionary, 32 per slide, each labelled |
| `text` | list levels 1–5 and speaker notes; alignment; line spacing 150 % / 80 %, space before/after; a body placeholder PowerPoint shrinks on overflow; vertical anchors; margins; shape-to-fit |
| `placeholders` | one slide per built-in layout with every placeholder filled; a moved and resized title |
| `baselines` | one slide per font (Calibri, Aptos, Arial, Georgia, Space Grotesk): sizes 12 / 36 / 72 pt × line spacing 80 / 100 / 120 / 150 %, two lines per top-anchored box |
| `tables` | twelve tables with built-in styles and style options; one names an unknown style id, which PowerPoint drops on save and draws as a black grid |
| `tablestyles` | all 74 built-in table styles, each twice: header, total, first/last column and banded rows; and banded columns only |
| `smartart` | eight diagrams with different data (flat lists, a hierarchy); PowerPoint lays every seeded diagram out with its default block-list layout, since only the layout's id is given |
| `motion` | fade, push, wipe and cut transitions with durations; appear / fade builds on click, with previous and after previous |

Re-record (a Mac with PowerPoint): `bash scripts/ppt-author-fixtures.sh [name ...]`; then, for
`baselines`, `python3 scripts/ppt-baseline-probe.py baselines.pptx baselines.ppt.pdf > baselines.baselines.json`
(needs pdfplumber).

PowerPoint's dictionary cannot create a table, set a table style or create SmartArt, so `tables`,
`tablestyles` and `smartart` are seeded: `<name>.seed.py` writes the tables into the blank deck PowerPoint made,
and PowerPoint opens and re-saves it (`resave.applescript`), so the recorded deck and PDF are
PowerPoint's. For the table fixtures, also run `python3 scripts/ppt-table-probe.py <name>.pptx <name>.ppt.pdf >
<name>.tables.json`.

For `smartart`, `python3 scripts/ppt-chart-probe.py smartart.pptx smartart.ppt.pdf >
smartart.frames.json`.

Covered by the corpus decks instead: charts, embedded fonts (not authorable).
