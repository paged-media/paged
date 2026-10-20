# ADR 201 — A face's ascent is its OS/2 typographic ascender

- **Status:** Accepted 2026-10-20.
- **Scope:** `parse_font_metrics` / `typo_ascent_descent`
  (`crates/paged-renderer/src/pipeline/font_table.rs`): the ascent and descent behind the
  Ascent first baseline, the anchored-object leading split and the missing-glyph marks.

## Context

The renderer took a face's ascent and descent from `hhea` (or from `OS/2` when the face sets
`USE_TYPO_METRICS`), and a CJK face's from its glyphs (`cjk_ascent_descent`). Every Latin face
measured before stated one value in both tables (Minion Pro 727, Open Sans 2189, the corpus
Roboto 2146), so nothing told the two apart.

A vendor-pack reference PDF did: a 127 pt Roboto Bold headline in an Ascent frame sits with its
baseline 95.0 pt below the frame's top. The embedded face (Roboto 2) has `hhea` 1900 and
`OS/2` typographic ascender 1536 of 2048: 117.8 pt against 95.25 pt. Asked directly, InDesign
20.0.1 sets a 30 pt Ascent frame's first baseline and reports the character's ascent and
descent as:

| Face | `hhea` asc/desc | `OS/2` typo asc/desc | InDesign baseline, ascent, descent |
| --- | --- | --- | --- |
| Roboto 2.000980 | 1900 / −500 (2048) | 1536 / −512 | 22.5, 22.5, 7.5 pt (0.75 / 0.25 em) |
| Lato 1.104 | 1974 / −426 (2000) | 1610 / −390 | 24.15, 24.15, 5.85 pt (0.805 / 0.195 em) |
| Minion Pro 2.112 | 727 / −273 (1000) | 727 / −273 | 21.81, 21.81, 8.19 pt |

## Decision

A face's ascent and descent are its `OS/2` `sTypoAscender` / `sTypoDescender`, whatever `hhea`
says and whether or not `USE_TYPO_METRICS` is set. `hhea` serves only a face without a usable
`OS/2` (no table, or a non-positive ascent or extent). CJK faces keep their own rule.

## Consequences

- Faces whose two tables differ (Roboto 2, Lato, many older web faces) set their first
  baseline where InDesign does; the headline above moves up 22.5 pt.
- No face committed to `corpus/fonts` changes: their tables agree, apart from Noto Sans JP,
  which the CJK rule handles.
- `tests/it/cjk_first_baseline.rs::a_latin_face_takes_its_ascent_from_os2_not_hhea` stamps
  Roboto 2's typo values into the corpus Roboto and asserts InDesign's 22.5 pt.
