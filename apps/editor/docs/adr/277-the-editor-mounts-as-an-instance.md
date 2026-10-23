# ADR 277 — The editor mounts as an instance

- **Status:** Accepted 2026-10-23.
- **Scope:** `apps/canvas/src/app/mount.tsx` (`mountEditor`, `createEditorInstance`),
  `apps/canvas/src/app/instance.tsx` (`EditorInstance`: `scope`, `services`),
  `packages/shell/src/state/editor-scope.tsx` (`EditorScope`, `useScoped`),
  `packages/shell/src/state/editor-root.tsx` (`[data-paged-editor]`, the portal container,
  `useEditorKeys`), `packages/shell/src/state/storage.ts` (`StorageAdapter`),
  `apps/canvas/src/boot/trusted-types.ts`, `apps/canvas/src/entry.tsx` (the page entry), and the
  gate `apps/editor/scripts/instance-guard.mjs`. Task E1 of
  [the composable editor's plan](../composable-editor-plan.md).

## Context

The editor was written as the page: module-level singletons held the current editor, the
document's file handle, the dialogs' state; keyboard listeners sat on `window`; the theme's
`.dark` class and the global styles went on `<html>` and `<body>`; settings went straight to
`localStorage`; debugging handles were published as globals. An embedding host mounts the
editor into an element of its own page, sometimes twice, and disposes it again (ADR 274's
profiles, `createEditor`, the iframe bridge), and none of that held.

## Decision

`mountEditor(element, options)` makes an **instance**: everything that belongs to one editor
is held by it, and nothing is written outside its element.

- **State.** An `EditorScope` holds the shell's and the app's per-editor stores (dialogs,
  palette, page navigator, placement, the object registry, the document source, the boot gate,
  …), created on first use and provided by `PagedShell`; services the app needs per editor
  (consent, documents, secrets, binding providers) live on the instance. What stays
  module-level is listed with a reason in `scripts/instance-guard-allow.json`: caches, what is
  shared by nature (the page-item clipboard, the journal, the live relay), and the
  page-keyboard bookkeeping. The instance guard fails on new module-level mutable state.
- **The root.** The shell renders `[data-paged-editor]` with a portal container inside it:
  popovers, dialogs, menus and tooltips render there, keys are handled for the editor they were
  typed in (`useEditorKeys`), and lookups are scoped to the root.
- **Styles.** Global CSS is scoped under `:where([data-paged-editor])`, Tailwind's preflight
  included; tokens are defined on `:root, [data-paged-editor]` and the theme's `.dark` sits on
  the root. `setTheme` writes tokens on the root.
- **Storage.** A `StorageAdapter` (Web Storage's method names) replaces direct `localStorage`;
  the page entry passes the page's storage under today's keys, an embed defaults to memory
  (`createEditor({ storage })`).
- **The page entry.** `entry.tsx` alone publishes the debugging handles (dev and demo builds),
  asks before unloading a changed document, installs the journal's error net and mirrors the
  theme onto its own page. `mountEditor` does none of it.
- **Trusted Types.** The default policy is installed once per page and kept when a host (or a
  second editor) already has one; the policy names a host must allow are listed in
  `TRUSTED_TYPES_POLICY_NAMES`.

## Consequences

- Two editors on one page work independently (the `two-editors` demo and its journey), an
  editor disposes and remounts cleanly, and a mount leaves `<html>` and `<body>` untouched
  (DOM tests). Radix's modal focus guards and scroll lock still touch `<body>` while a modal is
  open; that is interaction, not mounting.
- The active strings catalogue is still one per page: two editors on one page in two languages
  share it.
- Workers and wasm resolve through `assetBase` / `engineWasm` (E8, PM-0013), not here.
