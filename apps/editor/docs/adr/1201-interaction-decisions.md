# ADR 1201 — Interaction decisions D-01 to D-16

- **Status:** Accepted 2026-11-13. Decided, not implemented: each row is built by the task of
  [`interaction-plan.md`](../interaction-plan.md) named below and proven by the tests the table
  names. Until then the code behaves as the amended records' bodies say.
- **Scope:** the open decisions D-01…D-16 of the interaction specification (§25 of
  [`specs/ideas/paged_interaction_specification.md`](../specs/ideas/paged_interaction_specification.md),
  adopted by [ADR 1200](1200-the-interaction-contract-is-adopted.md)) and the Escape order of its
  §12.1. Amends [ADR 234](234-keyboard-focus-and-text-input.md),
  [ADR 235](235-the-selection-tools-pointer-model.md), [ADR 246](246-one-zoom-range.md),
  [ADR 250](250-escape-climbs-out-of-a-group.md) and
  [ADR 282](282-enter-enters-owned-content.md); each carries a dated note pointing here.

## Context

The spec leaves sixteen decisions open, each with a recommended choice, and says that until they
are decided its defaults are proposals. Several recommendations differ from what the editor does
today and from accepted records:

- Shift-click adds to the selection and Cmd-click toggles (`apps/canvas/src/panels/canvas-panel.tsx`,
  `onHit`). A marquee takes every item it intersects, in either direction, page by page
  (`engine/core/crates/paged-canvas/src/hit.rs`, `marquee_hits`).
- Tab hides the chrome on a canvas the user clicked into (ADR 234, decision 2), through
  `paged.chrome.toggleAll` and `paged.chrome.togglePanels`; Cmd/Ctrl+\\ toggles from anywhere.
- A double-click on an image frame that paged.image owns enters its edit context (ADRs 235 and
  282).
- A press outside a context that takes content pointers commits it
  (`apps/canvas/src/ui/ViewportCanvas.tsx`), Escape cancels it
  (`packages/shell/src/state/edit-context-controller.tsx`), and the breadcrumb pops it.
- About ten listeners answer Escape. One press can cancel a drag and climb a group; at the top
  level Escape changes nothing (ADR 250, decision 3).
- Alt-dragging a group to duplicate it fails at commit, and so does Alt pressed again during a
  drag (GF-2, GF-3 in [`reference/gestures.md`](../reference/gestures.md)).
- The Space spring-load swaps the gesture spine's one handler slot
  (`packages/shell/src/tools/gesture-spine.ts`), which deactivates a drawing tool mid-drag.
- 100 % is a camera scale of 1: one point per CSS pixel, an inch shown as 72 CSS px.

## Decision

| D | Question | Choice | Changes today's behaviour | Amends | Proven by |
|---|---|---|---|---|---|
| D-01 | Selection modifiers and marquee direction | Shift-click toggles membership; Cmd (Ctrl) stays a toggle alias. A marquee drawn left to right takes what it fully contains, right to left what it touches; it is scoped to the active group and starts on, and takes from, the pasteboard | Yes | 235 | `UXI-T03`, `UXI-T04` |
| D-02 | Duplicate-drag modifier timing | Live modifiers drive the preview; release commits exactly what the preview shows | Yes: preview and commit can disagree, and GF-2 and GF-3 fail at commit | — (closes GF-2, GF-3) | `UXI-T06`, `UXI-T11` |
| D-03 | Tab on a pointer-focused canvas | Tab and Shift+Tab move focus everywhere; the chrome toggle is the command `view.toggleChrome`; "Tab hides panels (InDesign)" is an opt-in preference | Yes | 234 | `UXI-T19` |
| D-04 | Click outside a nested context | Clean: the context exits and the click acts on what it landed on. Dirty: the module's declared `exitPolicy` decides, commit if safe, otherwise ask; never a silent discard | Yes: a click outside commits, Escape cancels, the breadcrumb pops | 250 | `UXI-T41`, `UXI-T42`, `UXI-T43` |
| D-05 | Double-click on an image frame | Content position first (the grabber); an explicit "Edit image" enters the image module | Yes | 282 | `UXI-T36`, `UXI-T51` |
| D-06 | Frozen or live transform reference | Live modifiers over the gesture's initial geometry snapshot, recomputed on every update, never accumulated | No: confirms INV-5 of `reference/gestures.md` | — | `UXI-T11` |
| D-07 | Key object for align | An explicit reference (selection, key object, margins, page, spread); the key object is shown, and every align route honours it | No: confirms the Align panel's key object (`packages/shell/src/state/align-scope.ts`) | — | `UXI-SEL-018`, in the align tests (the spec has no `UXI-T` for it) |
| D-08 | Locked objects | Selectable for inspection, not editable until unlocked, shown as locked | No: as ADR 251, decision 2 (the locked indication is new) | — | `UXI-T13`, `UXI-T69` |
| D-09 | Space during a mutating drag | The Hand waits until the drag settles, unless the tool's handler declares a lossless suspension | Yes: the spring-load deactivates the tool mid-drag | — | `UXI-OWN-011` in the adapter tests, `UXI-T10` |
| D-10 | A remote save fails after a local one | "Saved locally · Not synced", with Retry | New: the save state is dirty or saved | — | `UXI-T67` |
| D-11 | Focus after in-context changes | The last meaningful control, else the canvas | No: extends ADR 234, decision 3, to the palette, menus and in-context mutations; fixes issue #32 | — | `UXI-T23`, `UXI-T24`, `UXI-T34` |
| D-12 | Zoom range and actual size | One range, 5 % to 4,000 %. Actual size is 100 %, and 100 % shows an inch as 96 CSS px; a calibrated physical size is a separate, labelled option | Yes: 100 % shows an inch as 72 CSS px | 246 | `UXI-T47`, `UXI-T48` |
| D-13 | The document in the accessibility tree | A virtualized object tree, synchronized with the selection | New | — | `UXI-T69` |
| D-14 | Browser matrix | Chromium in CI; real Chrome with a GPU as local evidence; targeted WebKit and Firefox runs | No | — | gate G4; `UXI-T23` on the GPU lane |
| D-15 | Selection and undo | A selection change is not an undo step | No: confirms (selection is not a mutation in the engine) | — | `UXI-T01`, `UXI-T03`, `UXI-T04`, each asserting an unchanged history |
| D-16 | A command that applies to part of a selection | All or none when destructive; otherwise the stated subset, with a count ("3 of 5") | Yes, where a command acts on part of a selection without saying so | — | `UXI-T05`, `UXI-T13`, `UXI-T45` |
| §12.1 | Escape | One press resolves exactly one thing: the first applicable case of §12.1's order | Yes: one press can do two things; at the top level Escape now clears the selection | 250 | `UXI-T07`, `UXI-T16`, `UXI-T30`, `UXI-T31`, `UXI-T32`, `UXI-T42` |

Details the table cannot hold:

1. **D-01.** Shift-click on an item toggles that item in or out of the selection; Cmd (Ctrl)
   does the same, so ADR 235's Cmd keeps working. A Shift marquee adds what it takes (the spec's
   §6.2). The two marquee directions look different on the canvas. Inside an entered group a
   marquee takes only that group's members. A marquee that starts on the pasteboard is a marquee,
   takes pasteboard items, and crosses the pages of a spread. The engine's marquee query gains
   the mode, the scope and the pasteboard.
2. **D-02.** Pressing or releasing Alt (Option) mid-drag switches between move and duplicate in
   the preview, and the commit does what the preview showed at release, as one undo step. GF-2
   and GF-3 are expected failures today; their markers come off when this lands.
3. **D-03.** With the preference off (the default) Tab and Shift+Tab never toggle the chrome; the
   canvas is one tab stop. The command `view.toggleChrome` (`paged.view.toggleChrome` in the
   registry) keeps the chord Cmd/Ctrl+\\. `paged.chrome.toggleAll` and its keybindings are public feature ids, so the old id stays as a
   deprecated alias for the deprecation window. With the preference on, Tab on a canvas the user
   clicked into behaves as ADR 234's decision 2 describes.
4. **D-04.** A module's edit context declares an `exitPolicy` (a contract addition, recorded in
   the extensions' range when it lands). One exit resolver decides from the reason (a click
   outside, Escape, the breadcrumb, a tool switch, a document switch), whether the context is
   dirty, and the policy. Escape in a dirty context follows §12.1, case 5: the context's cancel
   or resolve, then a pop only if that is safe.
5. **D-05.** The first double-click on an image frame enters content position: the picture moves
   inside its frame and the frame stays. "Edit image" enters paged.image's context, by its
   button on the context toolbar, by Enter on the selected frame (as ADR 282 decides for owned
   content), or by a second double-click. Labels name the module.
6. **§12.1.** The cases, in order: IME composing; a modal, menu or palette; an active gesture; a
   transient mode (a loaded cursor, a path segment, a crop); a dirty context; a clean context,
   including an entered group (ADR 250's climb, one level per press); text editing, back to the
   frame; a selection, which is cleared; otherwise nothing. Each press acts on the first case
   that applies and on no other.
7. **D-12.** The zoom field, the presets and the fit commands show percentages of the CSS inch.
   The range is ADR 246's; the inputs that still carry bounds of their own (the Zoom tool's click,
   the fit computation) drop them.

## Consequences

- Each row lands with the task that builds it; the task adds its tests under the ids above, and
  a row whose behaviour departs from this record on landing is amended here first.
- The five amended records keep their bodies; a reader of 234, 235, 246, 250 or 282 finds the
  note at its end.
- Users who come from InDesign meet four changed habits (Shift, the marquee, Tab, the image
  double-click); the release notes name them, the canvas shows modifier hints, and Tab can be
  set back.
