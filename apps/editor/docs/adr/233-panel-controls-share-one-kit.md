# ADR 233 — Panel controls share one kit: named by their row, refusals in words

- **Status:** Accepted 2026-10-19.
- **Scope:** `platform/shared/panel-kit` (`@paged-media/panel-kit`, internal, docs/adr/PM-0002),
  the shell's label rows (`catalog/leaves.tsx`, `catalog/property-field.tsx`,
  `components/cockpit/kit.tsx`), the input primitives of `packages/ui`, and every editor and
  module panel that shows a confirm, a disclosure, a toggle segment, a glyph button, a refusal
  or a themed colour. The record, with the numbers:
  [`docs/migration/shared-foundations.md`](../../../../docs/migration/shared-foundations.md) (C10).

## Context

The editor's panels and the built-in modules' panels each carried their own small controls:
two second-click confirms (draw's button, sheet's keyed hook), eleven hand-written `<details>`
disclosures and three self-drawn ones, two debouncers, a refusal line per module, and colours
spelled as `var(--token, fallback)` with up to seven different fallbacks for one token. Several
names had no token behind them at all, so their dark fallback rendered in both themes, and two
were the shadcn HSL channels, which are not colours: five dialogs drew no border.

The surface conformance programme (ADR 227) found the same root under eighteen panel findings:
controls with no accessible name because the row's label was a plain span (PN-5 to PN-16, one
per primitive), toggle segments and tabs with no state (PN-2, PN-162, PN-213), a delete button
named "✕" (PN-155), and refusals shown as wire JSON or a Rust variant name (PN-4, PN-262).

## Decision

1. **One kit.** The shared controls live in `@paged-media/panel-kit`: `ConfirmButton` and the
   keyed `useConfirm`, `Disclosure` (the native `<details>`) and `About`, `useDisclosure` for a
   header a panel draws itself, `createDebouncer` and `useDebouncedValue`, `StatusLine`,
   `Refusal` and `useActionFeedback`, `IconButton`, `Segment`, `Tab`, and the field naming
   below. It is unstyled where the editor styles with Tailwind and carries the look where the
   modules style inline. Built-ins and the editor import it; `platform/extensions` cannot
   (`bun lint`).
2. **A row's label names the controls of the row.** A row gives its label an id and wraps its
   controls in `LabelledBy`; a control without a name of its own takes `aria-labelledby` from
   the nearest one (`useFieldName`). A field with no visible label is named after its row's
   title (`NamedAs`, as a fallback that yields to an enclosing row); a cluster cell adds its
   sublabel. `NumberInput`, `KitSelect`, the shell's `Input`, the toggle pill and the kit's
   `FieldSelect` / `FieldInput` / `FieldTextarea` read it, so one row fixes every control in
   it and one control fixes every row it is used in.
3. **State is in the markup.** A toggle segment is a `Segment` (`aria-pressed` beside
   `data-active`), a tab is a `Tab` (`role="tab"`, `aria-selected`), and a glyph button is an
   `IconButton` named in words (the glyph is hidden from the name).
4. **A refusal is a sentence.** Whatever reaches a panel (a log line with the command id in
   front, an Error, an engine error or its JSON inside a write result, a variant name like
   `Mutation::PathfinderBoolean`, a result code) goes through `refusalText` before it is shown.
   The command logs keep their detail; only what a user reads is worded.
5. **One fallback per token: the light theme's value.** The kit's `color`, `status`, `font`,
   `space`, `radius` and `chrome` constants name theme tokens with the `:root` value of
   `theme.css` as the fallback; a shell test holds the two equal and fails when the kit names a
   token the theme lacks. The editor always defines the tokens; the fallback is what another
   host, or a test, sees.

## Consequences

- Every built-in panel passes the reach basics (`registry.dom.test.tsx`), and the reach table
  is empty: a new unnamed control fails its panel's ratchet test instead of joining a list.
- The 42 generated reach expected-failures went with the table; each panel's ratchet test
  asserts no problem at all, so the lane asserts more with fewer tests (1,094 → 1,052).
- Module session debounces (data's persist, sheet's persist and refresh, web's auto-render and
  in-frame edit, sheet's chain reflow) keep their own timers: they flush on save and dispose
  and take the host's timers, which a panel helper does not need to model.
- A visible change: the About notes of draw, image, sheet and web share one look, and the
  dialogs that named non-existent tokens follow the theme.
