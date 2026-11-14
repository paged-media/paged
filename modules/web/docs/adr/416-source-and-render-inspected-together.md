# ADR 416 — Source and render inspected together: an element's place, rules, size and notes; the browser preview named as such; sample data beside the source

- **Status:** Accepted, 2026-11-14.
- **Scope:** `packages/web-model/src/element-inspect.ts` (`elementInfo`, `cssRules`, `rulesFor`,
  `selectorMatches`, `printNotes`, `placeholderNames`),
  `packages/web-bundle/src/outline-highlight.ts` (`inspectOutlineEntry`: the boxes behind a
  highlight), `packages/web-bundle/src/panels/element-inspector.tsx` (the Inspect section, the
  publication notes, the sample data row) and `panels/web-source-panel.tsx` (where they sit; the
  preview's and the canvas's names). Task CM5 (web) of the editor's interaction plan; the UX
  strategy's §7.6. Builds on the tag outline and the inspected render that already map a canvas
  press to a source tag and a source tag to its painted box (tag and occurrence). No contract
  change; no engine change.

## Context

The panel already joined the two sides by tag and occurrence: a press on the canvas inside the
frame marked a tag in the outline, and a click on a tag outlined its box on the canvas. What it
did not say was what a template author asks next: which line that element is on and where it
sits in the markup, how large it renders, which CSS rules reach it, and what in the frame's CSS a
printed page cannot show. The sandboxed iframe under "Preview" read as what the page would show,
though the page is drawn by the native renderer; the blocked script and the sandbox were stated
only as diagnostics in the linter's words. Template values were edited in a list below the
source with no hint of which placeholders still had none.

## Decision

1. **An Inspect section for the element in focus** — the one picked on the canvas or clicked in
   the outline. It shows its source line and open tag (a button selects it in the editor and
   outlines it on the canvas), a selector path of its ancestors (`div#main.card > p.lead`), its
   rendered size in pt (from the inspected render's boxes, the same boxes the outline highlight
   draws), the stylesheet rules that apply to it with their lines, and the diagnostics of its
   line. Rule matching is a scanner over the frame's own CSS: type, class, id, universal and
   compound selectors joined by descendant or child combinators. A rule that names the element
   but needs more (a pseudo-class, an attribute or sibling selector) is listed as **not
   evaluated**, never claimed to apply. It is the author's stylesheet, not the cascade: what
   wins is the publication rendering's to say.
2. **Publication notes explain what the page cannot show.** The frame's CSS is scanned for what
   has no printed form — animations and `@keyframes`, transitions, `:hover` / `:focus` /
   `:active` / `:visited` states, `position: fixed` and `sticky`, `cursor` and `pointer-events`
   — each listed with its line and a sentence of why. Not errors: the page draws the static
   result. The script and event-handler diagnostics get their explanation inline: the browser
   preview is a sandbox without permissions, and the publication is drawn without a script
   engine (`sandbox=""` and the `<script>` error stay as they are).
3. **The two renderings are named.** The iframe is the **browser preview (sandboxed)** — the
   browser's rendering of the source, scripts blocked, which can differ from the page; the canvas
   and the render report are the **publication rendering**, drawn natively by the engine. Both
   labels say which is which where each is shown.
4. **Sample data beside the source.** Right under the HTML editor, the placeholders the source
   uses are listed with the ones that have no value yet, each with a one-click Add that creates
   the value row; the preview follows the values as they are typed. The values are the frame's
   `vars`, saved with the source as before (Preview ≠ persistence).

## Consequences

- Tests: `packages/web-model/test/element-inspect.spec.ts`, `packages/web-bundle/test/panels/element-inspector.dom.test.tsx`, and in
  the editor `tests/e2e/web-inspect.spec.ts` (a source tag clicked shows its element's place,
  rules and notes; the canvas pick follows; the labels; no document change, no undo step, until
  Save).
- When the engine reports unsupported CSS itself (`LowerReport::unsupported_note` exported to
  JS), its notes join the publication notes; the scanner's list stays for what has no printed
  form at all.
