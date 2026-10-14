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
| `fonts.faces.json` | what the source fonts of the `fonts` fixtures say, per face: a hash of each glyph's outline and program, the advance widths, a hash of every other table (recorded from the original TrueType files by `pptx-fonts/tests/fixtures.rs`) |

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
| `fonts` | text in Lato (regular, bold, italic, bold italic), Gloria Hallelujah and Caveat, embedded by PowerPoint as subsets (its default); PowerPoint adds Caveat's bold face |
| `fonts-full` | the same text without Caveat, every face embedded whole |

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

`fonts` and `fonts-full` are seeded too: `fonts.seed.py` turns on "embed fonts in the file"
(`embedTrueTypeFonts`, and `saveSubsetFonts` unless whole faces are asked for) and
`embed-resave.applescript` has PowerPoint save the deck in place, which writes the faces (a save
under a new name drops the setting). The faces are fonts under the SIL Open Font License 1.1
installed on the recording Mac:

| File | Version | Author | SHA-256 |
|---|---|---|---|
| `Lato-Regular.ttf` | 1.104 | Łukasz Dziedzic (tyPoland) | `e82542aed8293f49fc83c4aaea566b1f6b4fc7a9ab5da11e6fb9bc0973b5324b` |
| `Lato-Bold.ttf` | 1.104 | Łukasz Dziedzic (tyPoland) | `d7f0b7f2570f2f28b504da1181b4d71b1420b10be2c4fd690927f1c8ee3b19c3` |
| `Lato-Italic.ttf` | 1.104 | Łukasz Dziedzic (tyPoland) | `3be26bf6973f49df6a7dfd130041017354342bfbb023e6b9610b42daeba6de34` |
| `Lato-BoldItalic.ttf` | 1.104 | Łukasz Dziedzic (tyPoland) | `e38611f4c0ff3251a58fe751991c39784d8f9be420b004891e0b9277228ec32f` |
| `GloriaHallelujah-Regular.ttf` | 1.004 | Kimberly Geswein | `4206cbda828ccde275f6d8b406ad80a29d2f5d9bc1a39a86e56a1c9c7691ed8c` |
| `Caveat-Regular.ttf` | 2.000 | The Caveat Project Authors | `8859ede1e1db982228c90101f914f5651e0000fc68729f121876faaa47ff9232` |
| `Caveat-Bold.ttf` | 2.000 | The Caveat Project Authors | `0c5f0a96ba7fb7963bb007ef9fdf0ecc79e6868590ff5b42d046d507f7c47454` |

To re-record `fonts.faces.json` from those files:
`PAGED_FONT_SOURCES=<dir> cargo test -p pptx-fonts --test fixtures record -- --ignored`.

Covered by the corpus decks instead: charts.
