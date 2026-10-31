# ADR 305 — The audience gets a window of its own

- **Status:** Accepted 2026-10-25.
- **Scope:** the `window` and `secondary` targets of `packages/shell/src/registries/presentation.ts`.
  The editor half of extensions ADR 345 (C1).

## Context

PowerPoint's presenter view puts the console on the presenter's screen and the slides on the
projector. A browser editor has one window. It can open another (`window.open`), place it on
another screen when the Window Management permission is granted (`getScreenDetails`), and the two
can talk over a `BroadcastChannel`.

## Decision

- **The editor's window keeps the console; the audience gets a new window.** On the `secondary`
  target the presenter opens an empty same-origin window, gives it a minimal black document, and
  mounts the `audience` surface in it, next to the `console` surface in the editor's window. On
  the `window` target the one surface goes into the new window and the editor stays as it was.
- **Placement only when already granted.** When `window-management` is already granted, the
  window opens on another screen at that screen's available size. The permission is never asked
  for here: the prompt would spend the key press the window needs.
- **One channel.** Each surface gets its own end of a `BroadcastChannel` named for the
  presentation, so the console's messages reach the audience and back. The audience window runs
  no editor: the bundle's code in the editor's window draws into it, and the channel keeps the
  surfaces independent of that.
- **Fallback.** A refused window (a popup blocker) shows the console alone on the editor's
  screen, and `present` answers `target: "screen"` with the reason. A refused `window` target is
  not presented.
- **Closing.** Closing the audience window, or leaving the editor, ends the presentation; ending
  it closes the window.
- **Probe.** `shell.present.secondary@1` when the editor can open windows.

## Consequences

- The browser's full screen cannot be entered in the audience window without a gesture made
  there; the presenter maximises it on its screen instead.
- A later standalone audience page (a URL that boots only the renderer) can join the same channel
  without changing the bundle's side.
