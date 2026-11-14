# ADR 1237 — Document X-Ray answers from the model

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/panels/xray-panel.tsx` (new: the "Why?" inspector),
  `overlays/xray-overlay.tsx` (new: View ▸ X-Ray on the canvas), `panels/built-in-panels.tsx` and
  `panels/window-categories.ts` (the panel `paged.xray`), `app-commands.ts`
  (`paged.view.toggleXray`, View ▸ X-Ray), `app/mount.tsx` (the overlay), `locales/de.json`;
  `packages/shell/src/state/view-toggles.ts` (the `xray` toggle) and `state/editing-aids.ts`
  (hidden in a proof); `packages/client` (`CanvasClient.explain`, protocol 82). The UX strategy's
  Concept A; the interaction specification's §25.1; task PX1 of
  [`interaction-plan.md`](../interaction-plan.md). The engine's side is engine ADR 1309.

## Context

The strategy asks Paged to explain a publication's structure — not only what is rendered but why:
why this colour, which style sets this spacing, where this picture comes from, why the object is
locked, why the frame is overset, which pages change if this style is edited, which field
supplies this value, what replacing this picture does. The specification's §25.1 adds the
condition: engine-backed facts, never speculative explanations. The editor's inspector showed a
style's name and the effective values (ADR 206), never which level of the cascade set them; locks
and hidden items were three mechanisms read in three panels; a style's reach was not shown
anywhere.

## Decision

1. **One read, the engine's.** X-Ray asks `client.explain` (engine ADR 1309) and shows its facts
   as they come. The panel computes nothing about the document: no cascade of its own, no guess.
   What the document does not store (the record a binding shows, a table cell's text) is shown
   as such, from the answer's `unknown`.
2. **The "Why?" inspector** (`paged.xray`, Window ▸ Utilities, docked with the inspector) explains
   the text at the caret (its content selection, in caret units), else the first selected item,
   and re-reads after every change of the document. Its sections, expandable, follow the
   strategy's diagram: the item (kind, page, layer); its lock with each reason; its visibility;
   the text — the paragraph and character style chains (`Body ← Base`), every property with its
   value and the level that wins (a style, a style through based-on, a local override on the
   text or the paragraph, the default) and, for a local override, what it overrides; the object
   style with the fill and stroke it supplies, the opacity and the effects; the picture (its
   link, status, ppi, what replacing it does, the frames sharing it); the data (bindings with
   their field and source, template fields, placeholders, variables); the text flow (frame n of
   m, the overset count); and "If you edit this style": the uses, the pages and the styles based
   on it.
3. **Each fact leads to where it is changed.** A style chain opens Paragraph styles, Character
   styles or Object styles; a picture opens Links; a data binding opens Data; an item's lock has
   Unlock (one `elementLocked` write, one undo step) and a layer's Unlock layer; a hidden item
   has Show; the thread's Previous and Next frames select the frame and fit it, a recorded jump
   that Back returns from (ADR 1211).
4. **View ▸ X-Ray** (`paged.view.toggleXray`, the panel's switch too) outlines every page item in
   the colour of what shapes it — a text frame by its paragraph style, any other item by its
   object style, one with neither grey ("set on the item"); a locked item's outline is dashed.
   Each item has a label with the key; hovering it says the winning source in full (the chain,
   the lock). A legend beside each page lists the keys on it. The colours are a golden-angle hue
   walk over the sorted keys, so they are stable for a document. The overlay reads the engine's
   overview (`aspect: overview`) of at most 600 items; it is diagnostic chrome, off by default,
   hidden in Proof view, never printed, and with the view off it reads nothing.

## Consequences

- The strategy's eight questions are answered from one panel: the colour and the spacing by the
  text properties' sources, the picture by its link facts, the lock and the overset by their
  sections, the pages a style edit changes by the dependents, the field by the bindings, what a
  replacement does by the fitting and the shared file.
- Explaining is a read: the model and the undo history are untouched (tested), and the overlay
  costs nothing while the view is off.
- A table cell's text, a group's members and the record of a data binding are not explained;
  the panel says so instead of inferring.
- Tests: `apps/canvas/test/panels/xray-panel.dom.test.tsx` (the panel's sections from the
  engine's answer, the sources, the empty state); `tests/e2e/xray.spec.ts` (the panel and the
  overlay show the engine's facts for a fixture document; the model and the history stay as they
  were); the overlay rule in `packages/shell/test/settings/view-toggles.test.ts`; the client on
  the real engine in `tests/headless/client-protocol-82.test.ts`.
