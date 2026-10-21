# Wave R — React 19 features in the editor

React 19.3.1 is in the tree and every first-party React source ships compiled (R0,
[react-compiler.md](react-compiler.md)). This page records what the editor took from React 19.2
and 19.3 after that, slice by slice, with the measurements before and after. The decision record
is [apps/editor ADR 240](../../apps/editor/docs/adr/240-react-19-features.md). The editor is a
client-only Vite SPA, so the Server Components and SSR features do not apply.

## How it was measured

- **The latency probe** (`apps/editor/apps/canvas/tests/perf`, the `perf` Playwright project)
  against the production build (`vite build --mode demo`, served by `vite preview`), headless
  Chromium without a WebGPU adapter, as in R0. `panels.perf.spec.ts` is R0's probe;
  `features.perf.spec.ts` drives the shell interactions this wave changes. Both now share
  `probe.ts`, which also counts the listeners an interaction adds to `window` and `document` (an
  effect that re-subscribes because a value it reads changed). Builds alternate in two rounds
  per label and the table pools them (mean of the per-run medians); "→" separates the builds.
  The script that runs them: build each tree with `vite build --mode demo --outDir <dir>`, then

  ```bash
  cd apps/editor/apps/canvas
  node node_modules/vite/bin/vite.js preview --outDir <dir> --port 5195 --strictPort --host 127.0.0.1 &
  IDML_CANVAS_TEST_PORT=5195 node node_modules/@playwright/test/cli.js test --project=perf tests/perf/
  ```

- **Memory**: JS heap after a forced GC and the renderer's DOM node and listener counters
  (CDP `HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`, `Memory.getDOMCounters`).
- **Behaviour**: the bun lanes (plain and compiled), the headless lane, and Playwright locally
  (the CI lane needs a missing secret): `@level:smoke` on the chromium and journeys projects, the
  plugin journeys, and the shell and panel specs each slice touches.

## Effect events (`useEffectEvent`, 19.2)

Every effect that ran on fewer dependencies than it read (an `exhaustive-deps` disable) or read a
"latest value" ref from a listener it attached now reads those values through an effect event.

| Where | Before | Now |
|---|---|---|
| ui: colour compute, number input, dial | suppressed deps; the dial re-attached its wheel listener on every value | an effect event per request / sync / wheel step; the listener is attached once |
| shell: field targets, binding-surface report | suppressed deps keyed on a JSON key | content keys that are honest dependencies; the report reads its arrays through an effect event |
| shell: fill/stroke cluster | three refs written during render for its commands; the gradient chip read a ref in render | effect events for the commands; the last gradient is state |
| shell: panel rail, overlay host, cockpit state | version counters as unread memo dependencies | registry views (R0's `useRegistryView`) |
| shell: threading and guide-drag controllers, the shell's chrome toggles | latest-value refs in layout effects | effect events |
| canvas: the three prompt dialogs, the document map, the playground, the gesture spine, path editing, text editing, the canvas panel, the schema-list demo, the app integration | suppressed deps or latest-value refs (the playground re-attached its key listener on every chapter) | effect events; one listener each |
| canvas: the viewport canvas | its Escape and blur window listeners re-subscribed on every render; the overlay host was sized by a ref read in render (and kept the old size after a resize until something else re-rendered) | effect events attached once; the overlay host is sized from the ResizeObserver; the component compiles |
| web: the source editor | suppressed deps; once it compiled, its render report (module state read during render) would have been computed once | an effect event; the report is read through `useSyncExternalStore` |

The ratchet (`compiler-coverage.json`):

| | Compiled | Bailouts | Not compiled | Coverage |
|---|---:|---:|---:|---:|
| R0 | 542 | 34 | 1 | 93.9% |
| after | 565 | 11 | 1 | 97.9% |

All 18 suppression bailouts are gone, and five Refs, one Todo and one Immutability bailout with
them (the viewport canvas, the canvas panel, the app integration, text editing, the animated
camera, the schema-list demo). Left: the four providers that write a ref during render on purpose
(ADR 229), the plugin-bundle host (a global test handle set during render), two hooks that call a
hook conditionally, data's two `try` value blocks, draw's path options, sheet's grid and web's
source panel factory. Rules-of-React lint suppressions 136 → 95 (refs 54 → 22, exhaustive-deps
26 → 17); inline `exhaustive-deps` disables 19 → 0; hand-written `useMemo`/`useCallback`
214 → 164. A scan of the newly compiled functions for memo blocks computed once that call into
mutable state found the web render report (fixed above) and nothing else.

Measured (before: main at the base of the slice; after: the slice):

| Interaction | Next frame median, ms | Settled median, ms | Commits | Renders | Listeners added |
|---|---|---|---|---|---|
| canvas pan (wheel) | 8.8 → 8.9 | 176.7 → 346.9 (a) | 4.2 → 4.7 | 628.5 → 619.5 | 6.0 → 1.0 |
| dock tab switch | 14.8 → 15.2 | 15.4 → 15.6 | 5.9 → 6.2 | 229.8 → 227.1 | 2.2 → 0.0 |
| chrome toggle (Tab) | 17.8 → 17.1 | 21.3 → 23.2 | 6.8 → 7.3 | 898.9 → 890.7 | 27.0 → 22.5 |
| mode round trip | 16.0 → 16.6 | 18.8 → 18.9 | 5.4 → 5.8 | 916.1 → 915.5 | 7.2 → 4.5 |
| Layers (select) | 9.2 → 9.7 | 4.8 → 4.6 | 6.2 → 6.4 | 509.7 → 498.6 | 6.4 → 1.1 |
| Pages (jump) | 14.5 → 13.7 | 234.1 → 233.8 | 26.9 → 26.9 | 5,931 → 5,908 | 40.8 → 12.8 |
| Properties (select) | 10.0 → 12.1 | 6.7 → 6.4 | 6.6 → 6.4 | 691.6 → 676.6 | 7.1 → 1.5 |
| Swatches (fill) | 11.8 → 8.9 | 440.1 → 432.1 | 14.3 → 14.1 | 2,487 → 2,454 | 28.5 → 0.0 |
| Image adjustments (slider) | 12.1 → 10.1 | 0.6 → 0.5 | 2.3 → 2.2 | 270.8 → 265.4 | 2.5 → 0.0 |

(a) Panning settles when the render worker's frame lands; that time moves by hundreds of
milliseconds between runs on a shared machine, in both builds. Memory after the dock and mode
switches: 13.2 → 13.3 MB heap, 3,718 → 3,718 DOM nodes.

Listener churn is what the slice removes: an interaction no longer re-attaches window and
document listeners (Swatches 28.5 → 0, Pages 40.8 → 12.8, panning the canvas 6.0 → 1.0 per
interaction). Renders and latency are unchanged within the runs' noise (the slice changes when
effects run, not what renders), and so is memory.

## `<Activity>` (19.2)

What the cockpit hides stays mounted, hidden: the right dock's inactive tabs (each in its own
scroll container), the side columns under Tab / Shift+Tab, the left panel of every mode visited,
and the document viewport under the Export mode. A hidden subtree keeps its state and DOM and has
its effects unmounted. There are no document tabs in this editor (one document; ADR 219 keeps
multi-document out of scope), so that part of the plan item does not apply; plugin panels are dock
tabs and are covered by the dock.

Measured on the production build, before the slice (s1) → after (s2), two rounds each:

| Interaction | Next frame median, ms | Settled median, ms | Commits | Renders | Listeners added |
|---|---|---|---|---|---|
| dock tab switch | 14.1 → 15.7 | 14.3 → 15.8 | 6.3 → 6.8 | 227.6 → 230.2 | 0 → 0 |
| chrome toggle (Tab) | 16.4 → 18.1 | 21.4 → 21.6 | 7.2 → 8.2 | 890.7 → 916.0 | 22.5 → 22.5 |
| mode round trip | 16.0 → 16.9 | 19.6 → 19.2 | 6.0 → 6.8 | 915.5 → 928.6 | 4.5 → 4.5 |
| Swatches (fill) | 12.6 → 13.5 | 438.9 → 310.4 | 14.8 → 17.2 | 2,456 → 2,512 | 0 → 0 |

| Memory | s1 | s2 |
|---|---|---|
| after the dock tab switches: JS heap / DOM nodes / listeners | 13.3 MB / 3,718 / 369 | 13.6 MB / 4,241 / 391 |
| after the mode round trips | 13.0 MB / 3,266 / 325 | 13.5 MB / 3,824 / 341 |

What it says: the slice is about state, not speed. A tab, a column or a mode's left panel comes
back as it was (the typed query, the scroll position, the open sections), and the viewport is
not rebuilt after the Export mode. Switching costs the same: a revealed panel re-renders and
mounts its effects (its subscriptions and reads start again) much as a newly mounted one did, so
the renders per switch are unchanged, and the commits rise by about one (the reveal is a
separate commit). The price is memory: the hidden panels keep about 520 to 560 DOM nodes and
0.3 to 0.5 MB of heap with three dock tabs and two modes. The Swatches fill settles sooner
(439 → 310 ms), most likely because the Properties panel hidden behind it no longer runs its
reads while hidden (its effects are unmounted); a hidden panel does still re-render at low
priority when its context changes, which is where the extra commits come from.

`hidden-panels.spec.ts` asserts the behaviour: a query typed in the left panel survives Tab and a
mode round trip, a dock tab keeps its scroll position, and the viewport is the same element after
the Export mode. Three tests asserted the old unmounting (`toHaveCount(0)` after hiding) and now
assert that the panel is not on screen.

## View transitions (`<ViewTransition>`, `addTransitionType`, 19.3)

`transitionWith(direction, update)` (shell) runs an update as a Transition typed `paged-next` or
`paged-prev`; the boundaries name classes for those types only. Where: a dock tab switch from the
strip or the panel rail, the filmstrip's selection ring (a shared element), a library version
that appears after a save, and the slide notes panel, which follows the active slide in the
direction it moved and has the presenter's previous / next buttons (there was no slide
presenter; the notes panel is the presenter view). Page navigation on the canvas is the camera's
own tween and is not a DOM transition. The root does not take part, so the canvas keeps rendering;
under `prefers-reduced-motion` nothing animates (`view-transitions.spec.ts` checks both).

## Fragment refs (19.3)

`useNearViewport` (`@paged-media/react-live`): one IntersectionObserver on a `<Fragment ref>`
(`observeUsing`, new children included). The Pages panel and the filmstrip decode only the
thumbnails near the view; the slides panel asks the engine for those slides' thumbnails only. The
focus primitives (`focus()` / `focusLast()` on a Fragment ref, the dialog focus trap, toolbar
roving focus) are the keyboard work's: `FocusScope` and `useRovingFocus` in
`packages/shell/src/focus/` (editor ADR 234), which fix SH-2, SH-11 and SH-12; this wave does not
touch those findings.

Measured over a 60-page document (s2 → s3), opening the Pages panel six times:

| | s2 | s3 |
|---|---|---|
| thumbnails the Pages panel decodes (`<img>` elements) | 61 | 12 |
| DOM nodes / listeners after | 6,553 / 859 | 6,332 / 663 |
| settled median, ms (renders) | 5.4 (28.0) | 5.7 (28.2) |

The images are blob URLs outside the JS heap (14.2 → 14.3 MB). On the slides panel the same hook
holds back the engine's thumbnail renders for slides the user has not scrolled to (each one a
render worker round trip): the first twelve are asked for, the rest as they come into view.

The view transitions cost one more commit and the length of the animation on what they animate:
a dock tab switch from the strip settles in 35.2 ms instead of 15.8 (the switch is a Transition;
the next frame comes as soon, 14.9 ms), and renders fewer components (104 instead of 230: the
Transition batches the reveal). Everything else is unchanged within the noise.

## Images, fonts and stylesheets that suspend (19.3)

Inside a `<ViewTransition>` boundary, a Transition that sets an image's source waits for the image
to decode (up to 500 ms) before it commits, and a view transition waits for fonts that start
loading. The thumbnail queue (`page-thumbnails.ts`) sets the re-taken thumbnails in a Transition,
and the filmstrip's and the Pages panel's images sit in a boundary that never animates, so the old
picture stays until the new one has decoded. A dock tab switch is a view transition, so a panel
whose UI font weight is not loaded yet appears with it. The slide bundle's transition CSS is a
hoisted `<style href precedence>`. No first-party code loads a stylesheet at runtime, so there is
no `<link rel="stylesheet" precedence>` to suspend on. The font previews the plan names do not
exist as such: the glyphs panel previews a family by name (a system font or the fallback), which
does not load.

## Trusted Types (19.3)

The deployed site (`public/_headers`), the dev server and `vite preview` send
`Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; report-uri
/api/csp-report`. The report route is a Pages Function (`functions/api/csp-report.ts`, one log line
per report); the dev server answers it itself and appends each report to the file
`PAGED_CSP_REPORT_LOG` names.

Every sink the first-party sources write to goes through a policy
(`@paged-media/helpers` `trustedHtml` / `trustedScript`, each running that call's own sanitizer):

| Sink | Policy | What makes the input safe |
|---|---|---|
| plugin glyph `dangerouslySetInnerHTML` | `paged-plugin-glyph` | the SVG sanitizer |
| code editor highlight layer | `paged-code-highlight` | the highlighter, which escapes every token |
| sheet grid SVG | `paged-sheet-grid` | the engine's own render, re-hosted |
| web preview `srcdoc` | `paged-web-preview` | the composed preview (pasted HTML is sanitized on the way in; `sandbox=""`) |
| playground `new Function` | `paged-demo-script` | a script the user runs on purpose |
| `new Worker(url)` (Vite workers, module kernels, DuckDB) | `default` | the editor's origin, its own blobs or the module host |

Chromium does not treat a `new Function` built from TrustedScript arguments as trusted: it hands
the default policy the assembled source. The default policy admits a source built from a body a
named policy approved (`isApprovedScript`), and nothing else.

How clean it is, with the report log on (dev server): Playwright smoke (50 tests), the plugin
journeys (69, 20 skipped) and 105 shell and panel specs (the dock, chrome, modes, the retarget
specs, the panels browser, the playground, live scripts, the library, the web plugin, the
navigator): 4 reports, all the playground's `new Function`, before the default policy admitted
approved sources; 0 after. React 19.3 hands a TrustedHTML to `innerHTML` (`dangerouslySetInnerHTML`)
and to `setAttribute` (`srcDoc`) as is (react-dom 19.3.1's `setInitialProperties` and
`setValueForAttribute` do not coerce it), which is what lets the policies work through React.

Enforced since editor ADR 273 (2026-10-21): the same value is now sent as
`Content-Security-Policy`, on the deployed site, the dev server and `vite preview`. The deployed
site's report route stores nothing (it logs each report to the Pages project's live log), so the
evidence is the test suites run against the enforced dev server; the numbers are in the ADR. A
worker's own realm gets the policy from its response headers, so the header (not the build's
`<meta>`) is the place.

## The smaller 19.3 items

| Item | Verified | Measured |
|---|---|---|
| Resize updates land in the next frame (the canvas container) | Yes for the update itself: the viewport's ResizeObserver now sets the overlay host's size as state (it read a ref during render before), and React renders that update in the next frame. | Frames from a window resize until the overlay fits the viewport, 12 resizes × 2 runs: 2 in every build (before the slice the viewport re-rendered for the camera's new size anyway, so the stale ref was masked here; it was not masked when nothing else re-rendered). |
| Independent Transitions | Yes: `react-19.dom.test.tsx` starts a Transition that suspends and one in another event; the second commits while the first is pending. The editor's own Transitions (dock switches, filmstrip, library, notes, thumbnails) are each started from their own event, so one never waits for another. | — |
| `fetchPriority` on module preloads (the lazy bundles, ADR 222) | No, not by upgrading. React 19.3's `preloadModule(href, { fetchPriority })` writes the attribute, but the editor never calls it: the bundle chunks are dynamic `import()`s whose preloads Vite's own helper inserts, without a priority. | The boot probe: 20 module preloads, none with `fetchpriority`; Chromium fetched 23 of the page's 25 scripts at High (2 VeryLow) and the boot lane settled in 410 to 430 ms in every build. The engine wasm is fetched by the render worker. With the lane settled within half a second of the document there is nothing to reorder, so no priority hints were added. |

## Playwright

Local runs (the CI lane needs the corpus secret), on the Vite dev server, headless Chromium
without a WebGPU adapter:

| Run | Base (main) | After each slice |
|---|---|---|
| smoke (`@level:smoke`, chromium + journeys) | 50 passed | 50 passed (effect events, Activity, view transitions + Trusted Types) |
| plugin journeys | 69 passed, 20 skipped | 69 passed, 20 skipped (all three) |
| shell and panel specs (73 for Activity, 105 for view transitions) | — | Activity: 72 passed, 1 failed, the precondition that asserted the old unmounting (fixed in the slice); view transitions: 102 passed, 1 skipped, 2 failed in the new spec, which counted React's zero-length root animations (fixed; 2 passed) |

One failure along the way was real: the web render journey lost its render report once the web
source editor compiled (module state read during render); fixed in the effect-events slice before
it was pushed.

The bun lanes, plain and compiled, after the last slice: shell 261, shell DOM 98, canvas DOM
1,056, canvas unit 122, headless 1,463, web 346 + DOM 5, slide DOM 14, sheet DOM 7, react-live 5,
helpers 17, all passing both ways.
