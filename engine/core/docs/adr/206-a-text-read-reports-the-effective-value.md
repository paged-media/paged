# ADR 206 — A caret or text range reads the effective value, not the local override

- **Status:** Accepted 2026-10-20.
- **Scope:** `CanvasModel::story_range_properties` (`crates/paged-canvas/src/model.rs`), and
  through it every read of a `storyRange:` address: `RequestGet`, `paged.get`, `paged get`,
  `paged.inspect` and the `RequestElementProperties` snapshot. No wire shape changes.

## Context

With the text caret in a paragraph whose paragraph style sets 30 pt, the editor's control bar and
Properties panel showed 12 pt. The read of a story range collected each run's own attribute
(`CharacterRun::point_size`) and each paragraph's own attribute, which is `None` whenever the
value comes from a style. `Length(None)` reached the editor as `null`, and a `null` number field
shows the schema default, so every style-only size read as 12 pt. The same held for the font
family, leading, tracking, fill and every paragraph attribute (justification, indents, spacing,
keeps, rules, list settings).

The local-only read also got "mixed" wrong in both directions: a local 30 pt next to text that
inherits 30 pt read as mixed, and a range over two paragraphs styled 30 pt and 8.5 pt read as one
inherited `null`.

## Decision

1. **A `storyRange:` read reports the value the text is set with.** For a character path it is
   the cascade the composer uses, `Document::resolved_run_attrs`: the run's own attribute, then
   its character style, then its nested style, then its paragraph style's based-on chain down to
   `[No paragraph style]`. For a paragraph path it is `Document::resolved_paragraph_attrs`: the
   paragraph's own attribute over its style's chain. InDesign's scripting DOM answers the same
   way: `insertionPoint.pointSize` is the size the text is set at.

2. **Mixed means the effective values differ.** The range's values are collapsed after the
   cascade, so a range is mixed exactly when its text is set in more than one way.

3. **The type size falls back to the renderer's default.** When nothing in the cascade names a
   size, the read answers the size the renderer sets the text at
   (`PipelineOptions::default_point_size`, 12 pt) rather than `null`, so an unstyled run and a
   12 pt run do not read as mixed. Other paths keep their unset spelling where unset is a value
   of its own: an unset leading is Auto (`Length(None)`), an unset string attribute reads `""`.

4. **The applied styles stay as named.** `appliedParagraphStyle` and `appliedCharacterStyle` read
   the style the text names, not a cascade.

## Consequences

- A read can no longer tell a local override from an inherited value. Nothing in the engine, the
  SDK or the editor used it for that; an override indicator needs its own path.
- A read followed by a write of the same value turns an inherited value into a local override.
  That is what InDesign does when a value is typed into the control panel.
- The editor's `null` → schema-default fallback stays for paths that are still unset after the
  cascade.
