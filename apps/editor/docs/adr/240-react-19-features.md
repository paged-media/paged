# ADR 240 — The editor uses React 19's effect events, Activity, view transitions, Fragment refs and Trusted Types

- **Status:** Accepted 2026-10-19.
- **Scope:** effect events across the shell, the canvas app, `packages/ui` and the web module;
  `packages/shell/src/cockpit/{RightDock,CockpitLayout}.tsx` (Activity);
  `packages/shell/src/view-transitions.ts` and `styles/view-transitions.css`, the dock, the panel
  rail, the filmstrip, the library panel and the slide notes panel (view transitions);
  `platform/shared/react-live` `useNearViewport` (Fragment refs), the Pages panel, the filmstrip
  and the slides panel; `packages/shell/src/state/page-thumbnails.ts` (thumbnails that wait for
  their decode); `platform/shared/helpers` `trustedHtml` / `trustedScript`,
  `apps/canvas/src/boot/trusted-types.ts`, `public/_headers`, `functions/api/csp-report.ts`
  (Trusted Types). The record of the work, with the numbers:
  [`docs/migration/react-19-features.md`](../../../../docs/migration/react-19-features.md).
  Builds on ADR 229 (the React Compiler).

## Context

React 19.3.1 is in the tree (U4a) and every first-party React source ships compiled (ADR 229).
React 19.2 and 19.3 added features the editor had worked around:

- effects that read more values than they depend on were written with an `exhaustive-deps`
  disable or a "latest value" ref, and the compiler skips every function with such a disable
  (18 of R0's 34 bailouts);
- the right dock, the side columns under Tab and the per-mode left panel UNMOUNTED what they
  hid, so a panel lost its state (a typed query, a scroll position) and was built again when it
  came back, and an export mode unmounted the document viewport;
- lists of thumbnails decoded every page of the document, and the slides panel rendered every
  slide's thumbnail, whether or not the user ever scrolled to it;
- the editor sends no script-related CSP, so a string reaching an HTML sink is not checked.

The editor is a client-only Vite SPA: the Server Components and SSR features do not apply.

## Decision

1. **Effect events (`useEffectEvent`) replace the stale-closure workarounds.** An effect runs on
   the values it is about; what it only reads (a callback, the camera, the selection) it reads
   through an effect event. Window listeners, command handlers and engine subscriptions that an
   effect attaches are attached once and call effect events. Effect events are called only from
   effects and from what an effect attached, never during render and never handed to a child.
   A "latest value" ref stays only where the value is read from an event handler (effect events
   are not for handlers); it is written in a layout effect (ADR 229).
2. **What the cockpit hides stays mounted, in `<Activity>`.** The right dock renders every open
   tab's panel and hides the inactive ones; each panel scrolls in its own container. Tab and
   Shift+Tab hide the side columns. The left panel of every mode visited stays mounted beside the
   current one. An export-style mode hides the viewport (its transferred canvas and its camera
   stay). A hidden subtree keeps its state and DOM, and its effects are unmounted: it holds no
   subscription and fetches nothing while hidden. Tests check what is shown, not what is
   mounted.
3. **View transitions animate moves between siblings, and only those.** `transitionWith(direction,
   update)` runs an update as a Transition typed `paged-next` / `paged-prev`; a `<ViewTransition>`
   names classes for those types only and `none` for everything else, so a transition started for
   another reason never moves it. The root does not take part (`:root { view-transition-name:
   none }`), so the live canvas keeps rendering under a transition; the overlay lets the pointer
   through; under `prefers-reduced-motion` nothing animates. Where: a dock tab switch from the
   strip or the panel rail (the panel comes in from the side its tab is on), the filmstrip's
   selection ring (a shared element that moves to the picked spread), a library version that
   appears after a save or a restore (it fades in), and the slide notes panel, which follows the
   active slide in the direction it moved and carries the presenter's previous / next buttons. A
   module ships its own transition CSS through a hoisted `<style href precedence>` (the slide
   bundle); it cannot import the shell.
4. **Thumbnails wait for their decode.** A thumbnail taken again after an edit is set in a
   Transition, and the filmstrip's and the Pages panel's images sit in a `<ViewTransition>`
   boundary that never animates: React 19.3 keeps the old picture on screen until the new one has
   decoded instead of showing a blank frame. The first set of thumbnails after a load is not a
   Transition (tests and the load flag wait for it).
5. **Long lists show what comes near the viewport, from one Fragment ref.** `useNearViewport`
   (react-live) observes every top-level element of a `<Fragment ref>` with one
   IntersectionObserver (`FragmentInstance.observeUsing`, new children included); an item counts
   as near once it intersected and stays near, and the first twelve are near from the start (the
   first paint, a DOM without an observer). The Pages panel and the filmstrip decode only those
   thumbnails; the slides panel asks the engine only for those slides' thumbnails. The hook
   result is destructured where it is used: the compiler takes an object whose member is handed
   to a `ref` prop for a ref. The focus primitives (`focus()`, `focusLast()` on a Fragment ref) are
   the keyboard work's (`packages/shell/src/focus/`, ADR 234), not this record's.
6. **Trusted Types, report-only first.** The deployed site (`_headers`), the dev server and
   `vite preview` send `require-trusted-types-for 'script'` as `Content-Security-Policy-Report-Only`
   with `report-uri /api/csp-report` (a Pages Function that logs each report; the dev server
   appends them to `PAGED_CSP_REPORT_LOG`). The markup and script the editor makes on purpose go
   through named policies, each running the function that makes the input safe
   (`paged-plugin-glyph`: the SVG sanitizer, `paged-code-highlight`: the escaping highlighter,
   `paged-sheet-grid`: the engine's own grid render, `paged-web-preview`: the composed sandboxed
   preview, `paged-demo-script`: a playground script); React 19.3 hands the trusted objects to
   `innerHTML` and to attributes intact. A worker's script URL goes through the `default` policy,
   installed before anything starts a worker, which admits the editor's own origin, its blobs and
   the module host only. Enforcement (the same value as `Content-Security-Policy`) follows once
   the deployed site's reports are as clean as the test suites'.

## Consequences

- The compiler ratchet went from 34 bailouts to 11 (the 18 suppression bailouts are gone; the
  viewport canvas, the canvas panel, the app integration, text editing and the animated camera
  compile). Rules-of-React lint suppressions 136 → 95; inline `exhaustive-deps` disables 19 → 0.
- A hidden dock tab is in the DOM (`display: none`): a test that wants "not on screen" asserts
  visibility, and a selector that would match the same control in two panels must be scoped to
  the panel (`[data-dock-panel="…"]`). A hidden panel re-renders at low priority when its context
  changes, and mounts its effects again when shown.
- New view transitions use `transitionWith` and the classes of `view-transitions.css`; a
  boundary names `none` for every type it does not handle.
- A new HTML, script or worker sink goes through a policy (`trustedHtml`, `trustedScript`, or a
  same-origin URL); the reports name the ones that do not.
