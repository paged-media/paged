# ADR 322 — Four host hooks for stateful content plugins: will-save, context entry, tool settings, undo labels

- **Status:** Accepted, 2026-10-04.
- **Scope:** `DocumentSurface.onWillSave` and `WillSaveEvent`; `ShellSurface.enterEditContext`;
  `BundleHost.tools` (`ToolsSurface`, `ToolSettingValue`); `EditContextContribution.undoLabel`
  / `redoLabel`; the `willSave` and `toolSettings` options and the optional
  `ShellBackend.enterEditContext` in `packages/plugin-sdk/src/host-impl.ts`; the flags
  `document.onWillSave@1`, `shell.enterEditContext@1` and `tools.settings@1`.

## Context

A plugin that edits content in a session of its own (a raster layer stack is the first)
holds state the document does not have until the plugin commits it. Four gaps followed:

- Nothing told a plugin that the document was about to be saved, so a save could write the
  file without the session's pending work.
- An edit context could be entered only by double-clicking its frame
  (`EditContextContribution.entry` has one value, by rule). A plugin that had just placed a
  frame, or offered an "edit" button in a panel, could not open its own context.
- A tool could declare option fields (`ToolContribution.options`) that the host renders and
  stores, but the bundle could not read the values back.
- While a context owns undo (`onUndo` / `onRedo`), the host's Edit menu could only show a
  generic label.

## Decision

- `document.onWillSave(listener)` registers a listener the host awaits before it serialises
  the document. The adapter wraps it: a thrown error or rejected promise is logged and does
  not stop the save. Without a host backend the listener is held and never called, and
  `document.onWillSave@1` is false.
- `shell.enterEditContext(type, elementId)` pushes one of the bundle's own registered
  contexts, the same push a double-click performs. A type the bundle did not register
  throws; a host that cannot enter resolves `false`. Double-click stays the only declared
  entry gesture: this is an action a bundle takes, not a second gesture.
- `host.tools.settings(toolId)` returns a copy of the option values the host holds for one
  of the bundle's own tools, and `onDidChangeSettings` reports changes. A tool id outside the
  bundle's namespace throws. Without a backend the values are `{}`.
- `undoLabel()` / `redoLabel()` on an edit context name the step the host's Edit menu would
  undo or redo while the context owns undo; `null` or absent keeps the host's label.

## Consequences

- A plugin can commit its session to the document (and its container parts) as part of
  every save, which makes the save path the one place the commit is guaranteed.
- Panels and importers can open the plugin's own editing context without simulating input.
- Tool options stay owned by the host's UI; a plugin reads them and does not keep a second
  copy that can disagree.
- Every hook degrades to an honest answer on a host that has not wired it, so a bundle
  probes the flags instead of the host version.

## Related

- [ADR 012](012-k1-modal-session-undo-coalescing.md) — the context-owned undo these labels describe.
- [ADR 305](305-doors-always-present.md) — always present, honest fallback, flag per backend.
- [ADR 320](320-binary-lanes-for-scene-images-and-parts.md) — the part writes a will-save commit uses.
