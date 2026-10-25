# ADR 348 — The editing doors: control-bar groups, scoped keys, status items, the text selection

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/plugin-api/src/{editor,host,contributions,index}.ts`,
  `packages/plugin-sdk/src/{host-impl,text-selection,harness,fake-editor}.ts`. Editor side:
  editor ADRs 298 and 299. First consumer: paged.doc (doc ADR 608). DESIGN.md §26.

## Context

paged.doc lowers a Word document to native engine text, so the editor's own caret, selection
and text input edit it (editor ADRs 234, 268). What a Word user still lacked was Word: the Home
group's controls, Cmd+B/I/U and the paragraph and style keys, page and word counts. The host had
no slot for a bundle in its control bar or a status bar, a bundle's keybinding lost to the text
input and to host bindings on the same key, and a bundle could read the caret's start
(`text.caret`) but not the selection, its effective format, or write format to it. A Word
document opened as the whole document (Open mode) also has no frame to enter, so a frame-level
edit context never becomes active there.

## Decision

- **C1 `contribute.controlBarGroup`** and **C3 `contribute.statusItem`**, each with
  `scope: { editContext }`, rendered by the host while that context is active.
- **C2 keybinding `scope: { editContext }`**: present only while its context is active, then
  ranked above every host binding and the canvas text input; host-reserved keys (Cmd+S, Cmd+P,
  Cmd+\, Cmd+Shift+P) refuse a scoped binding.
- **C4 `host.text`**: `selection`, `onDidChangeSelection`, `properties`, `format`,
  `applyStyle`, built in the SDK on the existing doors (`RequestGet` and `setElementProperty` on
  a story range) with the content-to-character offset conversion; `format` writes are one undo
  step; `extent: "paragraphs"` covers whole paragraphs for a character path. Find and replace is
  left out until the engine's operation is on main.
- **`shell.setDocumentContext`**: the open document as one of the bundle's context types, for
  the scoped contributions only, dropped on every load and on disposal.
- **Gates** borrow the edit context's declaration (it must be declared and registered by the same
  bundle); no new manifest field. Probes as in DESIGN.md §26.
- The plugin-sdk / plugin-api versions move in lockstep at integration (one bump for C1–C4).

## Consequences

- A content type gets an application's chrome and keys without a host change per plugin; the
  host keeps one vocabulary (edit contexts) for "where you are".
- The isolate migration carries the groups and items like panels: React in the host realm.
- Find and replace (`host.text.findReplace`) and the review and spelling doors (ADR 349) are
  later, additive members.

## Amendment 1 (2026-10-25): find and replace, the character range, a panel's target

Engine ADR 1021's find landed on main, so `host.text` gains its additive members (no change to
the existing ones):

- **`host.text.find(spec)`** → `{ hits, error? }`: the engine's `RequestFindText` → `FoundText`.
  `TextFindSpec { find, storyId?, mode? ("literal" | "wildcards" | "regex"), matchCase?,
  wholeWord?, paragraphStyle?, characterStyle?, limit? }`; each `TextFindHit` carries the caret
  range (`start`, `end`: what `selection` and `viewport.revealText` take), the character range
  (`charStart`, `charEnd`), the paragraph, the text and up to 30 characters of context
  (`context`, `contextOffset` in UTF-8 bytes). Word's specials work in every mode. Gated on
  `capabilities.document.read`.
- **`host.text.replace(spec)`** → `{ applied, replaced, error? }`: `TextReplaceSpec` adds
  `replace`, `all?`, `replaceParagraphStyle?`, `replaceCharacterStyle?`; one `findReplace`
  through `document.mutate` (so the write gate applies), ONE undo step for Replace All. The SDK
  finds first to count the hits and to refuse "nothing matches" without sending a mutation.
- **`host.text.characterRange()`**: the selection in story characters, for the operations that
  count characters (`setListLevel`, `restartNumbering`); the content-to-character conversion
  stays in the SDK.
- **`host.shell.openPanel(id, { target })`**: an ADR 131 address the panel should edit first
  (the host's Style Options takes a style address). `OpenPanelOptions` is additive; a panel
  without a target ignores it.
- **Probe** `text.find@1` (static: every host of this contract runs an engine that answers).
- **Harness**: `createHeadlessHost({ shell })` passes a shell backend through, so a test can
  record `openPanel` and its target.
- The dialog and results list are the host's (editor ADR 303); a content type binds its keys to
  the host's command ids (`paged.edit.find`, `paged.edit.replace`, `paged.edit.goTo`).
- Versions: the lockstep plugin-sdk / plugin-api bump happens at integration.

