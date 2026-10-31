# ADR 365 — Live symbols run on the engine's instance node; the Symbolism tools change what an instance carries

- **Status:** Accepted 2026-10-29.
- **Scope:** `packages/draw-geometry/src/symbolism.ts`, `src/nine-slice.ts`, `fitAffine` in
  `src/affine.ts`; `packages/draw-tools/src/symbolism-machine.ts`; in `packages/draw-bundle/src`
  `commands/{symbolism,symbols-engine,symbols-migrate,symbols}.ts`,
  `handlers/{symbolism,nine-slice}.ts`, `panels/symbols-panel.tsx`, the `symbol` /
  `symbolInstance` object kinds and the `symbolChoice` template field. Engine: the
  `symbolInstanceSymbol` element path, `deleteFrame` on an instance, and the SVG export's
  `<symbol>` / `<use>` (engine ADR 1039's follow-ups, riding protocol 78). Work package WP6.8 of
  the image/draw plan (gap D-48), on top of WP7.3.

## Context

Engine ADR 1039 gave the document a symbol store and `FrameRef::Instance`: an instance draws its
definition under a transform, with opacity, blend, tint and 9-slice guides of its own. draw's
Symbols panel and seven commands already switch to it on a host with `document.symbols@1`. What
WP6.8 still asked for: Illustrator's Symbol Sprayer and Symbolism tools, 9-slice guides edited on
the canvas and a Symbol Options dialog, the template field and the settings list reading the
engine's store, a migration for documents whose symbols are draw's v0 library (draw ADR 355 /
356), and an SVG export that keeps a symbol a symbol.

## Decision

- **The Symbolism tools change only what an instance carries.** Shifter, Scruncher, Sizer and
  Spinner write the instance's `frameTransform`; Stainer writes `symbolInstanceTint` towards the
  tool's colour; Screener writes `frameOpacity`; the Sprayer places instances
  (`placeSymbolInstance`, `at` + `linear`) and, with Alt, deletes the instances it sweeps. Every
  drag is one batch, one undo step — placements first, deletes last. The kernels are pure
  (`symbolism.ts`): a brush disc whose weight falls `1 − (d / r)²` to its rim, Illustrator's
  1–10 intensity as the rate, fixed full rates (`SYMBOLISM_RATES`) and a seeded generator for
  the Sprayer's scatter, so a recorded drag replays exactly. Alt is Illustrator's inverse
  (push, shrink, unstain, unscreen). The tools act on the selected instances, or on every
  instance of the page when none is selected. **Styler is not built:** an instance carries no
  appearance beyond opacity, blend and tint, so a graphic style has nothing to land on.
- **Eight keyless tools in one flyout.** The Sprayer, the six modifiers and a 9-Slice Guides tool
  form a `symbolism` flyout without keys — Illustrator's `shift+s` is draw's already and no
  register is free (CLAUDE.md, the shortcut registers). Each tool's options are Illustrator's
  Symbolism Tools Options (diameter, intensity; the Sprayer's density, size and rotation scatter
  and orientation; the Stainer's colour, since the contract hands a tool no current fill).
- **9-slice is the engine's mapping, checked against Illustrator.** `nineSlicePoint` is the
  renderer's formula (corners keep their size, edges stretch along their axis, the centre in
  both, the matrix's scale read off its column lengths); the Illustrator oracle
  (`scripts/illustrator/probes/nine-slice.jsx`, six cases) expands sliced instances and every
  anchor agrees within 0.05 pt, the shrink case included. The guides are the SYMBOL's
  (`redefineSymbol { nineSlice }`), as in Illustrator: the 9-Slice Guides tool draws the
  selected instance's symbol's guides where the engine cuts and a drag writes them, one undo
  step. The engine has no isolation mode; that tool is the symbol editing mode for the guides.
- **Symbol Options is the Symbols panel's options section.** The contract has no dialog door
  (path-options precedent): the panel's chosen symbol carries a name field, the 9-slice switch
  and four insets, and *Draw ▸ Symbol ▸ Symbol options…* chooses the current symbol and raises the
  panel through a published binding. With values the command applies them (`[]` / `null`
  removes the guides). The chosen row is also what the Sprayer sprays and Replace targets.
- **Replace Symbol is an element path.** `symbolInstanceSymbol` (`Value::Text`) points an
  instance at another definition, keeping its id, transform and overrides — what the
  `symbolChoice` template field needs (its target is an id) and Illustrator's Replace Symbol.
  Additive, so it rides protocol 78.
- **The engine's store is the one list.** On an engine host the `symbol` / `symbolInstance`
  object kinds (and so the Draw settings panel's symbol rows) and the template field read the
  `symbols` collection; name and delete are `redefineSymbol` / `deleteSymbol`, `linked: false`
  is `breakSymbolLink`. The v0 lane stays the fallback without the flag.
- **A v0 library moves once, on open.** When the host keeps symbols, `installSymbolMigration`
  draws each v0 definition as temporary artwork, reads its engine box (the registration point the
  engine will centre on), fits every v0 instance's transform to its live anchors
  (`fitAffine`, a translation when they no longer match), and then — amending the same undo step
  (engine ADR 1004) — creates the symbols with the library's names and ids, places the
  instances, and removes the v0 artwork. The part is kept with a `migrated` map, so a reopen
  does not migrate twice.
- **SVG keeps a symbol a symbol.** paged-svg writes a definition's form once as
  `<symbol overflow="visible">` and each instance as `<use xlink:href transform>`; the copy the
  rasterizers draw is skipped. A 9-sliced instance is nine clipped `<use>`s. draw's exporter
  delegates to paged-svg (WP6.10) and so gets it.

## Consequences

- No protocol bump: one additive element path and a wider `deleteFrame`; plugin-sdk /
  plugin-api 0.74.3-canary.37 vendor the path.
- What a v0 instance changed on its own leaves (a fill) and its stacking order do not survive the
  migration: an engine instance draws its symbol and is placed on top.
- Follow-ups, not built: the Symbol Styler; nested symbols; break link that bakes tint and
  9-slice; per-item overrides inside an instance; instances on master spreads; Illustrator's
  "Average" / user-defined method per Sprayer property.
