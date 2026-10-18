# ADR 321 — The host lends its colour picker as a widget; it never writes the document

- **Status:** Accepted, 2026-10-04.
- **Scope:** `WidgetSurface.ColorPicker`, `ColorPickerProps`, the `<input type="color">`
  fallback in `packages/plugin-sdk/src/widgets-fallback.tsx`, the `widgets` option of
  `createBundleHost`, and the `widgets.colorPicker@1` flag.

## Context

Retouch and paint tools need a foreground colour. The host already has a colour mixer for
swatches and fills, but a plugin could not use it: `host.widgets` offered only a code
editor. The alternatives were for each plugin to ship its own picker, which gives the
product several pickers that behave differently, or to bind the plugin to the host's
Swatches and Color panels, where every pick would create or change a document swatch.

## Decision

- `WidgetSurface` gains `ColorPicker`, a component with `value` (`#rrggbb`), `onChange` for
  every change while the user drags, an optional `onCommit` for the settled value, and
  `disabled` / `ariaLabel`. It edits a value the bundle owns and holds no document state.
- The host injects its own mixer through `createBundleHost({ widgets })`. The option is now
  `Partial<WidgetSurface>` and is merged over the fallbacks member by member, so a host can
  inject one widget and keep the other's fallback.
- Without an injected picker the SDK renders a native `<input type="color">`: `onChange` on
  every pick, `onCommit` on blur. `widgets.colorPicker@1` is true only when the host
  injected one, and `widgets.codeEditor@1` likewise only when it injected a code editor.

## Consequences

- One picker across host and plugins, with no document side effects; a plugin that wants a
  swatch writes one through `document.mutate` as before.
- The fallback is plain but real, so a bundle written against the widget works headlessly
  and on an older host.
- `widgets.codeEditor@1` used to be true whenever any widget catalog was passed; it now
  means the code editor itself was passed.

## Related

- [ADR 305](305-doors-always-present.md) — always present, honest fallback, flag per backend.
- [ADR 313](313-no-react-at-load.md) — the fallback reaches React only at render time.
