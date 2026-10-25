# ADR 1018 — Word's paragraph, character and list model

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (the new operations ride v76, which is unreleased: governance rule 4;
  the property paths, spec fields and model fields are additive). `paged-model`
  (`CharacterDecorations`, `UnderlineKind`, `NO_HIGHLIGHT`, `Paragraph::shading` / `border`,
  `NumberingListDef::levels`, `NumberingLevelDef`, `ListSuffix`,
  `word_level_text_to_expression`, `DocumentPreference::show_hidden_text`); `paged-scene`
  (the decorations cascade, `ResolvedRunAttrs::drawn_underline`, direct shading and border,
  `ResolvedParagraphAttrs::apply_list_level`, `list_marker_font`); `paged-renderer`
  (`pipeline/decorations.rs`, `color_paint::RunDecorPicker`, `pipeline/conditions.rs`,
  `pipeline/numbering.rs`); `paged-mutate` (`apply/word.rs`, `apply/list_ops.rs`,
  `SetStyleBasedOn`, `SetListLevel`, `RestartNumbering`, `SetParagraphListState`,
  `NumberingLevelSpec`, twelve property paths); `paged-canvas` (`mutate.rs`, Next Style on
  Enter); `paged-wire` (`setStyleBasedOn`, `setListLevel`, `restartNumbering`); `idml-import`
  and `idml-export` (the IDML spelling of what has one). Amends
  [ADR 158](158-how-indesign-numbers-a-multi-level-list.md)'s list model with a second source of levels.
  Part of engine wave E1 of the paged.doc Word-parity program.

## Context

paged.doc imports Word documents onto the IDML model. Several things a Word user edits every
day had no slot there, so the importer dropped them or faked them: highlight, hidden text
(`w:vanish`, which then rendered visible), the underline's kind and colour, double
strikethrough, paragraph shading and borders set on a paragraph (the model had them on styles
only), and Word's list definitions (`w:abstractNum/w:lvl`: per-level format, `%1.%2.` text,
start, restart, indents, bullet and its font). No operation re-parented a style, and Enter
never applied a style's Next Style.

## Decision

**Character additions.** One struct, `CharacterDecorations`, sits on `CharacterRun`,
`CharacterStyleDef` and `ParagraphStyleDef` (Word's paragraph-style `rPr`), and on the resolved
forms; every field is `Option` and cascades run > character style > paragraph style like the
rest (`fill_from`). It is skipped when unset, so a document without it serialises and hashes
exactly as before. Fields:

- `highlight_color` — a swatch, painted as a band from ascent to descent behind the glyphs of
  each highlighted segment of a line (`decorations::emit_highlight_for_line`, before the glyph
  fills). `"Swatch/None"` (`NO_HIGHLIGHT`) switches a style's highlight off.
- `hidden` — hidden text takes no room and draws nothing unless the document shows hidden text.
  It leaves through the conditional-text pass (`conditions::without_hidden_runs_by` with a
  `HideRule`), so a hidden run's anchored objects and footnote references go with it exactly
  as a hidden condition's do. `DocumentPreference::show_hidden_text` (default off) is Word's
  view option; it lives in the `.paged` model part, not in IDML.
- `underline_kind` — Word's names (`UnderlineKind`: none, single, words, double, thick,
  dotted, dashed, dotDash, dotDotDash, wave, doubleWave; the heavy and long variants map onto
  their plain kind). `Underline` stays the switch and the kind is its look
  (`ResolvedRunAttrs::drawn_underline`): an explicit `Underline="false"` draws nothing, an
  unset switch with a kind other than `none` draws. `words` leaves the spaces bare.
- `underline_color` — the underline's own swatch; unset draws in the text's colour.
- `double_strikethrough` — two thinner lines instead of the single strike.

The glyph flags the layout carries (`underline`, `strikethru`) come from `draws_underline` /
`draws_strike`; the kind, colours and highlight come from a per-cluster `RunDecorPicker` built
beside the paint picker, so the text crate is untouched.

**Paragraph shading and border on the paragraph.** `Paragraph::shading` and `border` (the
style structs, all-`None` inherit) win per field over the style cascade in
`ResolvedParagraphAttrs::from_paragraph`; the renderer already drew both from the resolved
attributes.

**Property paths** (on a `StoryRange`, and on character / paragraph styles through
`SetStyleProperty`): `characterHighlightColor`, `characterHidden`, `characterUnderlineType`,
`characterUnderlineColor`, `characterDoubleStrikethrough`; `paragraphShadingOn`,
`paragraphShadingColor`, `paragraphShadingTint`, `paragraphBorderOn`, `paragraphBorderColor`,
`paragraphBorderWeight`; and `documentShowHiddenText` on the document. Setting an underline
kind turns the switch on (`none` off). Its value may carry the switch explicitly
(`double@on`, `@inherit`), which is what its inverse carries, so the undo restores both fields
exactly. Highlight, underline kind / colour and double strike are paint-only.

**List levels.** `NumberingListDef::levels` holds Word's level definitions (`NumberingLevelDef`:
list type, format, expression, suffix, start, `restart_after`, left and first-line indent, tab
position, bullet character and font, marker character style). When a paragraph applies a list
with levels, `resolved_paragraph_attrs` lays the definition of the paragraph's level over the
cascaded list attributes (`apply_list_level`) with Word's precedence: what the paragraph sets
itself wins, then the level, then the paragraph style. ADR 158's numbering then runs
unchanged: a Word format name becomes the IDML sample string (`decimal` → `1, 2, 3, 4...`),
Word's level text becomes the IDML expression (`%1.%2.` → `^1.^2.`, a literal `^` escaped,
the suffix appended: tab → `^t`), `restart_after = k` becomes `RangeOfPreviousLevels 1..k`
(`0`: never), and a Word list goes on counting across paragraphs outside it
(`NumberingContinue` defaults to true). The level's bullet font sets the marker's face
(`list_marker_font`). An InDesign list (no levels) is untouched: paragraph-style list
properties stay the IDML path. `NumberingListSpec::levels` (additive, `NumberingLevelSpec`)
carries the levels through `createNumberingList` / `editNumberingList`.

`SetListLevel { storyId, start, end, level | delta }` moves the paragraphs touching the range
to a level or by a delta (Tab / Shift+Tab), clamped to 1–9. `RestartNumbering { …, startAt?,
continueNumbering }` writes `NumberingContinue` false (true for Continue Numbering) and the
start. Both undo through the inverse-only `SetParagraphListState`, which puts each paragraph's
level, continue flag and start back exactly. A level above 1 now honours a paragraph's own
`NumberingContinue="false"` (it restarted only through the policy before).

**Styles.** `SetStyleBasedOn { collection, styleId, basedOn }` re-parents a style of any
collection; it is refused when the parent is missing, is the style, or already inherits from
it (`based_on_makes_cycle`; a chain that already loops stops at the first repeat).

**Next Style on Enter.** A lone paragraph break inserted at a paragraph's end (the Return key:
`insertText "\n"`) gives the new paragraph the current paragraph style's `next_style`, when it
names a style the document has, as InDesign and Word do. It lives in the text kernel, so every
host gets it. Enter in the middle of a paragraph, and pasted text, keep the style. The undo
needs nothing: the inverse delete joins the paragraphs and the joined one keeps the first's
attributes.

**IDML.** The importer reads `UnderlineType` (the stroke styles with a Word counterpart:
Solid, ThinThin, Canned Dotted, the canned dashes, Wavy), `UnderlineColor`,
`StrikeThroughType="…/ThinThin"` as double strike, and a range's own `ParagraphShading*` /
`ParagraphBorder*`. The writer spells the same back on ranges and styles, patching only what
changed (a source spelling that reads as the model's value keeps its bytes). Thick is a
doubled `UnderlineWeight`. **Highlight has no IDML attribute**: the writer draws it the way
InDesign users do — a coloured underline as tall as the text, offset up behind it — but only
on a run that has no underline of its own (a run with both keeps its underline and loses the
highlight in IDML). A re-imported IDML therefore reads a highlight back as an underline.
**Hidden text has no IDML attribute either** and is written as ordinary text; Word's
per-level list definitions are not written to IDML (an IDML consumer sees the levels the
paragraphs resolved to only through the `.paged` model). The `.paged` model part carries all
of it exactly.

## Evidence

- `crates/paged-model/src/lib.rs` tests: the kinds' names and IDML stroke types round trip;
  `%1.%2.` → `^1.^2.`.
- `crates/paged-mutate/src/apply/word.rs` test and `crates/paged-mutate/tests/it/word_model.rs`:
  every path on a run and on both style kinds, exact undo, the underline switch grammar,
  `SetStyleBasedOn` and its cycle refusal (proptest over random chains), `SetListLevel` /
  `RestartNumbering` and their exact undo.
- `crates/paged-renderer/tests/it/word_decorations.rs`: highlight draws a rect behind the
  glyphs; each underline kind and double strike draws its strokes; a hidden run takes no room
  and returns when the document shows hidden text; list levels number `1.`, `1.1.`, `1.2.`,
  `2.`, `2.1.` with a multi-level restart, `RestartNumbering` and a bullet level.
- `crates/paged-canvas/tests/it/word_editing.rs`: Enter at a paragraph's end applies the Next
  Style, in the middle it does not, undo restores the model hash; the wire mutations.
- `crates/idml-export/tests/it/word_attrs.rs`: underline kind / colour, double strike, highlight
  as the underline band, direct shading and border written and read back; an unmutated
  document stays byte-identical.

## Consequences

- paged.doc can import highlight, vanish, `w:u`, `w:dstrike`, direct `w:shd` / `w:pBdr` and
  `numbering.xml` onto native slots (docx-import / docx-lower work, not engine work).
- The editor's Word control bar sets all of it through ordinary property paths; Tab /
  Shift+Tab in a list is one `setListLevel`.
- Residuals: level-above-1 counts do not continue across stories (the cross-story ledger is
  per list, level 1 only); a changed `BasedOn` of a style that came from the source package is
  kept in the model and `.paged` but not yet re-spelt into its IDML `<Properties><BasedOn>`
  child; tables and footnotes draw no underline kinds or highlight (their emitters never drew
  decorations); highlight and hidden text are lossy in IDML as described.
