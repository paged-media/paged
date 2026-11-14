# ADR 1216 — One numeric field

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/ui/src/inputs/expression.ts` (new: the one parser),
  `inputs/NumericField.tsx` (new: the one field), `NumberInput`, `LengthInput`, `BoundsInput`
  and `SmartDialMicro` (thin wrappers over it), `inputs/document-unit.ts` (`parseLengthText`
  reads through the parser), `packages/shell/src/gestures/use-scrub-gesture.ts` (`onEnd`, the
  `revert` phase), `catalog/scrub-preview.ts` (new: a scrub as one undo step), `catalog/leaves.tsx`
  (`LengthLeaf`, `NumericScrubLeaf`), `catalog/render.tsx` and `catalog/binding-hook.ts`
  (`mixed`, `previewable`, `commitEach`, the coalesce key), `catalog/property-field.tsx` and
  `catalog/object-model.tsx`, the catalogue's `LeafProps.onCommit` options, the control bar's
  `NumField` (`apps/canvas/src/cockpit/control-bar.tsx`), the host panels that typed numbers
  into a raw `<input type="number">`, the contract's `host.widgets.NumericField`
  (`plugin-api` `widgets.ts`, `plugin-sdk` `widgets-fallback.tsx`, `widgets.numericField@1`) and
  its object writes' `coalesce` option (`ObjectWriteOptions`, `PagedClient.mutate`),
  and the single-owner rule `raw-number-input` (`tooling/single-owner.json`). `UXI-PNL-002`,
  `UXI-PNL-005`, `UXI-PNL-008` to `UXI-PNL-011` and `UXI-SEL-016` of the interaction
  specification ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); the UX strategy's §5.2
  and §11.2; task FI1 of [`interaction-plan.md`](../interaction-plan.md). Amends
  [ADR 233](233-panel-controls-share-one-kit.md) and [ADR 245](245-one-document-unit.md). Closes
  the panel audit's open item "Shared primitives" (`design/panel-audit-2026-10.md`).

## Context

Numbers were typed into six components (NumberInput, LengthInput, BoundsInput, SmartDialMicro,
the catalogue's leaves, the control bar's NumField) and 41 raw `<input type="number">` fields,
each with its own reading of the text. ADR 245 gave lengths one unit parser for single values;
nothing read an expression, a relative change or a mixed unit. A mixed selection showed an
em-dash in some fields and the first object's value in others. A scrub sent nothing until the
release (no preview) or, where a panel listened to every change, one undo step per pixel. Out of
range values were clamped without a word. Plugins typed numbers into their own inputs, so a
plugin panel's numbers behaved unlike the host's (the panel audit's open "shared primitives").

## Decision

1. **One parser** (`expression.ts`) reads every typed number: units (pt, pc and `p`, px, mm,
   cm, in and `"`, and InDesign's `6p3`), + − × ÷ (and `*` `/`), brackets, and relative entries
   (`+=5 mm`, `-=2`, `*=1.1`, a leading factor `*110%`). Values carry a dimension, so mixed
   units resolve to the field's unit the same way every time: in a length field a bare number
   beside a length is in the field's unit, a length times a number is a length, a length over a
   length a ratio, and a length times a length is refused. The UI locale's decimal comma is
   read (German `12,5`, `1.000,5`); in English a comma groups thousands (`1,000`) and any other
   comma is still a decimal (ADR 245). Errors are typed: `syntax`, `range` (outside the field's
   bounds, or not finite) and `unit` (a unit the field cannot take).
2. **One field** (`NumericField`) is the only numeric input. Enter or blur commits once;
   Escape restores; a refused value keeps the text, sets `aria-invalid` and shows an inline
   message in words (`role="alert"`), and leaving the field puts the value back. A mixed
   selection reads "Mixed" (never 0 or a first value; no value reads the em-dash, an unset
   value its name). ↑/↓ step by the field's step (Shift ×10, Alt ×0.1). A data-bound value
   shows the bound badge in the field.
3. **A scrub is one undo step with a live preview.** The label or glyph chip scrubs (Shift
   fine, Alt coarse). Each value goes to `onPreview` and the release to one `onCommit`, all
   carrying one `coalesceKey`; a scrub cancelled (Escape through the Escape arbiter, ADR 1207,
   or a lost pointer) or released where it began calls `onCancelPreview`. The catalogue's
   leaves preview a write that goes through core: every preview and the release carry the
   scrub's key to the engine (`mutate(op, { coalesce })`, [engine ADR
   1304](../../../../engine/core/docs/adr/1304-writes-with-one-coalesce-key-are-one-undo-step.md),
   protocol 80), so the run is one step; the release ends it (`endCoalesce`), and a cancel ends it
   and undoes its one step (`scrub-preview.ts`). The binding lane passes the key to the client;
   the object model's writes take it as `coalesce` (`objects.set` / `objects.batch`, through
   plugin-sdk's object registry). A write from an edit context commits on release only.
4. **A relative entry over a mixed selection applies to each object** (`onCommitRelative`):
   the binding's `commitEach` gives every selected object its own value in one batch, one undo
   step ("+=5 mm" makes each wider by 5 mm, "*110%" scales each). Without a per-object write
   the field refuses the entry and says why.
5. **Every numeric surface is the field.** NumberInput, LengthInput, BoundsInput and
   SmartDialMicro keep their props as thin wrappers; `LengthLeaf` and `NumericScrubLeaf` gain
   the preview, Mixed, the badge and relative writes; the control bar's fields are the field's
   `bar` variant (and now scrub on their label); the host panels' raw number inputs (data asset
   parameters, gradient stops, picture adjustments, table insets and strokes, the template
   form's numbers, the view preferences, the tool options) are the field. A new raw
   `<input type="number">` fails the single-owner rule `raw-number-input`; its baseline is the
   modules' copies (moved by track CM5) and the standalone devtools inspector.
6. **Plugins get the field** as `host.widgets.NumericField`
   (`widgets.numericField@1`, plugin-sdk and plugin-api 0.74.3-canary.100): the same props and
   commit meta, the plugin writing through its own door; `objects.set` and `objects.batch`
   take the scrub's `coalesceKey` as `{ coalesce }`, so a plugin's scrub is one undo step too.
   Without the host's field the SDK's fallback is a plain decimal text field.

## Consequences

- ADR 233's kit gains its numeric member; ADR 245's parser becomes the length door of the one
  parser (`parseLengthText` keeps its signature and results).
- An out-of-range value typed into a field is now refused with a message instead of clamped
  (a scrub still clamps). A typed value is committed at the field's shown precision.
- A cancelled scrub leaves its step in the redo history (the undo that put the document back).
- Tests: `apps/canvas/test/unit/fields/expression.test.ts` (property-style: hundreds of
  generated expressions in every unit pair, precedence, relative identities, both locales,
  every error kind), `numeric-field.dom.test.tsx` (one commit per scrub under one key,
  cancel, Escape, Enter's blur, steps, Mixed, relative entries, messages, the badge, German),
  `packages/shell/test/catalog/scrub-preview.test.ts`, plugin-sdk
  `test/numeric-field-widget.spec.ts`, and `tests/e2e/uxi-fields.spec.ts` (`UXI-PNL-005`,
  `-008`, `-009`, `-010` in the running editor, each asserting the document and the undo log).
