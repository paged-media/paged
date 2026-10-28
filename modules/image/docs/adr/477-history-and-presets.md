# ADR 477 — Snapshots, a configurable journal and one Preset Manager in the image context

- **Status:** Accepted, 2026-10-28 (WP5.9; amends 463).
- **Scope:** `image-graph/src/journal.rs` (bounds and read-only peeks), `image-js/src/layers/history.rs`
  (snapshots, past states, the budget), `image-js/src/preset_files.rs` and the `presets_*` /
  `layers_snapshot_*` / `layers_set_history_budget` wasm doors, `paged-psd/src/presets.rs` (`.grd`,
  `.pat`, `.asl`), and the bundle's `session-presets.ts`, `preset-library.ts`, `preset-store.ts`,
  `context-history.ts` and the Preset Manager, History Options and snapshot UI.

## Context

The image's undo list (ADR 463) had a fixed 32-entry journal depth, no snapshots, and History
brush sources limited to "as opened" and "before the last edit". Presets lived in four places:
brush presets (ADR 471) and layer-style presets (ADR 472) only for the session, gradients and
patterns as a single foreground-to-background pair and one defined pattern, and no tool or
adjustment presets at all. Photoshop keeps all of these across sessions and manages them in one
dialog, with its own file formats.

## Decision

1. **A snapshot is a structure snapshot with a name.** `LayerStack` keeps named copies of the
   record a structure step already holds (layers, groups, comps, channels, selection, styles).
   Layer pixels are shared `Arc`s and an edit replaces a layer's buffer, so taking one copies
   pointers. Taking a snapshot is not an undo step (Photoshop's rule). Restoring one is ONE
   structure step labelled "Restore <name>", so it is undoable and the steps it went back over
   stay on the list. Snapshots are session state: not persisted, not undone, and a crop that
   replaces the stack drops them with its history.
2. **Memory is accounted, not hidden.** `snapshot_bytes` counts each stored layer buffer once,
   leaving out the ones the current stack still uses; the panel and History Options show it beside
   the journal's own bytes.
3. **The journal's bounds are a preference.** `TileJournal::set_budget` applies a depth and a byte
   budget at once (a tighter one evicts oldest first, as a record over the bound would). The
   default stays 32 steps and 256 MiB until the user sets History Options (1–1000 steps,
   16 MiB–2 GiB); the structure list's bound rises to the depth when that is above 200. The
   preference is stored in the bundle's key-value storage and applied when the engine boots.
4. **Every step has an id.** Pixel and structure steps carry an id for their life (undo and redo
   keep it). The History brush's source is `open`, `previous`, `step:<id>` or `snapshot:<id>`.
   A step's state is computed on a copy of the active layer: walking back from the newest step,
   a pixel step's journal entry is written into the copy without moving the journal
   (`peek_undo_into`), a structure step's snapshot supplies the layer as it was; redo steps walk
   forward the same way. A state of another canvas size, a step no longer held, or a layer that
   did not exist then is refused, never stretched.
5. **Snapshots appear in the host's History panel without a contract change.** The edit
   context's `historySteps` (editor ADR 285) lists the snapshots first, then a row for the oldest
   kept state, then the steps, which is Photoshop's History panel. The panel's walk-by-delta
   reaches every row: a snapshot row restores it, the state row undoes every kept step, a step row
   walks as before. The state row keeps the newest snapshot from ever being the list's last row,
   which the panel marks as current. Without snapshots the list is exactly the steps.
6. **One Preset Manager over six libraries.** Brushes (ADR 471's library), tool presets (brush
   parameters, dynamics and the paint tools' options), adjustment presets (the panel's chain),
   gradients (stop lists), patterns (RGBA8) and layer styles (ADR 472). One dialog lists, renames,
   reorders, deletes (never a built-in), applies, saves the current settings, imports and exports
   each. Applying a gradient sets foreground and background to its ends, because the gradient tool
   draws two colours; applying a pattern makes it the defined pattern; applying a style defines
   the patterns it draws first (by Photoshop id, else name).
7. **Photoshop's formats through paged-psd.** `.abr` stays ADR 471's. `.grd` (version 5, the
   descriptor list `GrdL`; noise gradients are counted, not guessed), `.pat` (Grayscale, Indexed,
   RGB, CMYK, Multichannel and Duotone at 8 bits; transparency in the list's user-mask slot) and
   `.asl` (its pattern run and each style's `Lefx` effects, read by the `lfx2` reader) are read and
   written by `paged_psd::presets`. Tool and adjustment presets use the bundle's own JSON
   (`paged-presets`, version 1), because Photoshop's `.tpl` and per-adjustment files are not read.
8. **Presets persist per user.** The bundle's namespaced key-value storage (`host.storage`) holds
   the small libraries; brushes and patterns, which carry pixels, go to the bundle's binary store
   (`host.blob`, declared as `storage.blob` with a 64 MiB quota) when the host has one, and fall
   back to the key-value store up to a bound; past it they are kept for the session and the
   status line says so.

## Evidence

- `image-graph/src/journal.rs` — `set_budget`, `peek_undo_into`, `peek_redo_into` and their tests
- `image-js/src/layers/history.rs` — snapshots, `layer_after_step`, the budget, and five tests
- `paged-psd/src/presets.rs` — the three formats and their tests;
  `paged-psd/tests/it/presets_photoshop.rs` reads and round-trips every preset file a Photoshop
  installation ships (`PAGED_PHOTOSHOP_PRESETS`; 318 gradients, 312 patterns and 370 styles in 12 files
  read whole and written back equal, locally against Photoshop 2026)
- `glue/test/history-presets.spec.ts` and `glue/test/history-presets.dom.test.tsx`

## Alternatives considered

A contract change (`EditContextHistory.snapshots`) would have let the host panel draw snapshots
in a section of their own; the list encoding gives the same rows and clicks with no new contract
and degrades to the old list when there are none. Keeping snapshots as full pixel copies would
have made each one cost the whole stack; sharing buffers costs only what changes after.

## Consequences

- The History brush's source survives undo and redo (ids are stable) but not a step's eviction:
  a source that no longer names a held step falls back to "as opened" in the UI and is refused
  by the engine.
- Multi-stop gradients are kept and exchanged but the gradient tool still draws two colours.
- `.tpl` tool presets and Photoshop's per-adjustment files (`.acv`, `.alv`, …) are not read.

## Related

- [ADR 463](463-one-undo-list.md) — the one undo list (amended: steps have ids; the bounds are a preference)
- [ADR 471](471-brush-engine.md) — the brush library and the History brushes
- [ADR 472](472-layer-styles.md) — layer styles and their presets
