# ADR 267 — The demo guide floats over the editor, and the script waits behind a disclosure

- **Status:** Accepted 2026-10-20.
- **Scope:** `apps/canvas/src/playground/PlaygroundController.tsx`, `guide-prefs.ts`,
  `packages/shell/src/demo/overlay.tsx` (the narration box's corner), `packages/ui/src/code/highlight.ts`
  (a JavaScript tokenizer).

## Context

The playground (`?script=<id>`, [ADR 212](212-one-automation-surface.md)) opened every live
demo with a 400 px column pinned under a `× script` chip at the top-left, from the header to
the bottom of the window. It covered the tool rail and the Document Map, used the editor's own
panel surface, and led with the script's source in plain monospace. A visitor saw a technical
panel that looked like part of the editor, not a guide to what the demo was showing.

## Decision

- **A guide over the editor.** The playground renders a card that floats in a bottom corner, on
  the raised surface (`--elevated`) with a violet edge, a 12 px radius and a deep shadow, so it
  reads as something laid over the editor. It stays clear of the tool rail and the panel rail
  (`clamp(12px, 5vw, 76px)` from the edge) and of the mode bar (60 px from the bottom).
- **Friendly first.** The card's first view is the demo's title, one plain line (the manifest's
  description), one progress segment per step (each a button that seeks to it) over a line
  naming where the run is ("Step 2 of 5 · A curve, by its anchors", one text, so the label never
  reads as a second copy of the narration box), Play / Pause and Restart, and the run status in
  words.
- **The script on request.** "Show the script" (`aria-expanded`, closed by default) opens the
  source with the running statement marked and kept in view, highlighted by a small tokenizer
  in the editor's existing highlighter (no new dependency), with Step, speed, Copy, Edit & run
  and a link to the scripting documentation.
- **Collapsible and docked.** The card folds to a pill, "Demo · <title> · 2/5", with Play /
  Pause at hand; Escape inside the card folds it, the pill opens it, and focus follows. The
  card docks to the bottom-left (default) or bottom-right corner; the shell's narration box
  (`demo.showInfo`) keeps to the other corner.
- **Remembered per viewer.** Folded or open, the corner and the script disclosure are stored
  under `paged.demoGuide.v1` (wrapped in try/catch; a refusing storage leaves the defaults).
  An embed (`&embed`, the website's hands-free demo) always starts folded; a screen narrower
  than 640 px starts folded unless the viewer chose otherwise.
- **Hooks kept.** `data-playground-status` / `-error` moved to the guide's root
  (`[data-playground]`), so the status reads in either state; `data-playground-toggle`,
  `-source`, `-play`, `-restart`, `-step`, `-chapter`, `-copy`, `-edit-toggle` and `-runedit`
  keep their meaning.

## Consequences

- `test/unit/settings/demo-guide.dom.test.tsx` (collapse, expand, focus, Escape, the
  disclosure, copy, docking, persistence, refused storage) and `tests/demo-guide.spec.ts`.
- The developers film opens the script disclosure in its setup, since that film is about the
  script.
- The global transport keys (Space, ←, →, R) no longer act when focus is on a button or a link,
  where Space is the control's own.
