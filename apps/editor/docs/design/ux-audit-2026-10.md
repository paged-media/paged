# UX audit — October 2026

An audit of the editor's whole interface: document lifecycle, chrome, canvas gestures, the built-in modules, keyboard and accessibility, performance, visual consistency, and the conventions DTP users bring from InDesign. Every finding below was reproduced in the running editor. Each has steps to reproduce and either screenshots or a measured number.

The audit tested `main` at `d5df00f` (engine 0.74.0-dev, built from the same revision) in Chrome, using new headless mode with WebGPU (`--enable-unsafe-webgpu --use-angle=metal`, as the `journeys-gpu` Playwright project does). Playwright scripts drove the real UI: menus, rail, canvas pointer and keyboard input, file input and drops. The default window was 1600 × 1000.

The test material was:

- the generated feature fixtures (text, geometry, groups, links);
- two real-world IDML templates, 54 MB with 8 pages and 105 MB with 20 pages;
- the end-to-end harness's DOCX, PPTX, XLSX, PSD and CSV files;
- a generated PNG.

Screenshots are not committed. Each finding names its files (`F-<id>-<slug>.png`); they sit beside a machine-readable `findings.json` with the same fields.

This audit does not repeat the [October panel audit](panel-audit-2026-10.md), which reviewed the contents of every panel. It looks at how the parts behave together.

## Executive summary

The ten findings with the largest impact:

| #   | Id            | Severity | Finding                                                                                    | Area                             |
| --- | ------------- | -------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| 1   | [F-01](#f-01) | blocker  | Dropping a file on the canvas replaces an edited document without asking                   | Document lifecycle               |
| 2   | [F-49](#f-49) | blocker  | Tab is bound to "hide panels", so focus can never move by keyboard                         | Keyboard and accessibility       |
| 3   | [F-36](#f-36) | blocker  | Text typed through an IME, dead keys or Option/AltGr is lost                               | Canvas gestures and text editing |
| 4   | [F-28](#f-28) | blocker  | No Cut, Copy, Paste or Duplicate for page items                                            | Canvas gestures and text editing |
| 5   | [F-26](#f-26) | major    | Dragging an unselected object draws a marquee instead of moving it                         | Canvas gestures and text editing |
| 6   | [F-29](#f-29) | major    | Double-click enters the wrong editing context; Direct Selection does not reach into groups | Canvas gestures and text editing |
| 7   | [F-02](#f-02) | major    | Corrupt or unsupported files fail silently, sometimes with a success message               | Document lifecycle               |
| 8   | [F-53](#f-53) | major    | Large documents show a blank canvas for 15–21 s with no progress                           | Performance and responsiveness   |
| 9   | [F-55](#f-55) | major    | Small windows leave almost no canvas, and below 1025 px the layout breaks                  | Performance and responsiveness   |
| 10  | [F-27](#f-27) | major    | No context menus                                                                           | Canvas gestures and text editing |

The next tier: dead-end opens for spreadsheets and images ([F-03](#f-03)), no New Document dialog ([F-04](#f-04)), a PDF export default that cannot succeed ([F-11](#f-11)), documents that open at 4% on the middle page ([F-32](#f-32)), mixed units with no preference ([F-39](#f-39)), and 1.7–3.6 GB of memory on large files ([F-54](#f-54)).

Three themes run through the list:

- **Basic DTP mechanics are missing or surprising.** There is no copy and paste of frames, no context menus, and a drag on an unselected object draws a marquee. Double-click enters the wrong context. Users from InDesign will hit these in the first minute.
- **Failures are silent.** Bad files, unavailable services, menu commands with nothing selected, and saves all produce no visible feedback. The one status indicator is amber all the time.
- **Keyboard and international input.** Tab is taken for hiding panels, so nothing can be reached by keyboard. Text entry drops anything typed through an IME, dead keys or Option/AltGr.

### Counts

| Area                                 | Blocker | Major  | Minor  | Polish | Total  |
| ------------------------------------ | ------- | ------ | ------ | ------ | ------ |
| Document lifecycle                   | 1       | 5      | 5      | 2      | 13     |
| Chrome: menus, header, dock, palette | 0       | 0      | 8      | 2      | 10     |
| Canvas gestures and text editing     | 2       | 4      | 5      | 3      | 14     |
| Built-in modules                     | 0       | 1      | 4      | 1      | 6      |
| Keyboard and accessibility           | 1       | 0      | 3      | 0      | 4      |
| Performance and responsiveness       | 0       | 3      | 1      | 0      | 4      |
| Visual consistency                   | 0       | 0      | 0      | 4      | 4      |
| DTP expectations                     | 0       | 1      | 1      | 0      | 2      |
| **Total**                            | **4**   | **14** | **27** | **12** | **57** |

## What works well

- **InDesign's tool keys.** All 27 tool shortcuts on the rail activate the right tool: V, A, T, P, N, backslash, M, F, L, C, R, S, O, G, ⇧G, I, H, Z, ⇧P and the module tools. Each tool has a tooltip with its group, name, chord and a one-line hint. Long-press opens a flyout, and the flyout tears off into a palette.
- **Input latency.** Click to selection is 34–49 ms (median about 42 ms). A typed character reaches the model and the next frame in a median 49–51 ms at normal speed. The command palette opens in 142 ms, and a mode switch takes 106–132 ms. Dragging (simple document) and wheel scrolling (54 MB and 105 MB documents) hold 60 fps on the main thread with no long tasks.
- **Camera.** Ctrl+wheel (the pinch equivalent) zooms about the cursor, and ⌘= and ⌘− zoom about the centre, and the point under the cursor or the centre stays put to within 0.00001 pt. Space-drag and middle-button drag pan, a horizontal wheel pans sideways, and PageUp, PageDown, Home, End and thumbnail clicks navigate.
- **Direct manipulation, once selected.** Shift-resize keeps proportions (144 × 100 → 188 × 130.6). Arrow and ⇧arrow nudge by 1 pt and 10 pt, and a move snaps to the page centre. Alt-drag duplicates, and each gesture tested undoes in one step.
- **The control bar follows the selection** (ADR 024): one rectangle, several objects (align and Group), text (styles, size and leading), group, sheet, vector graphic and raster image each get their own bar. Entering a module context swaps the rail and adds an Esc breadcrumb.
- **Safety nets that exist work.** Reload with unsaved edits triggers `beforeunload`, and File ▸ New and Open ask before discarding. Substituted fonts get InDesign's pink highlight, and the Fonts and Links panels flag what is missing.
- **Imports:** DOCX, PPTX and PDF open as documents in 0.5–5 s. The Word outline reports "Everything in the document was carried over". Image adjustments preview live while a slider moves.
- **Themes and focus.** The dark and light themes are both complete, and most body text passes AA contrast. Native focus rings show on every control that can take focus, and Esc closes dialogs.

## Measured numbers

| Measure                                                                                                   | Result                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Boot to editor ready (warm dev server)                                                                    | 0.5–0.7 s                                                                                    |
| Click → selection state → next frame                                                                      | 34–49 ms (first click after load 442 ms)                                                     |
| Keydown → insert round-trip → next frame, 2.5–8 chars/s                                                   | median 49–51 ms, max 61 ms (insert round-trip about 24 ms)                                   |
| Same, burst at about 55 chars/s                                                                           | median 235 ms, max 311 ms (insert round-trip 220 ms)                                         |
| Command palette open                                                                                      | 142 ms                                                                                       |
| Workflow mode switch (click → two frames)                                                                 | 106–132 ms                                                                                   |
| PageDown camera settle                                                                                    | about 300 ms (animated)                                                                      |
| Fit page (Home) animation                                                                                 | about 700 ms, also with reduced motion                                                       |
| Main-thread frame pacing while dragging (simple document) or wheel-scrolling (54 MB and 105 MB documents) | p50 / p95 / max 17 / 17 / 17 ms, 0 long tasks                                                |
| 54 MB, 8-page IDML: ready → first visible paint                                                           | 1.07 s → 14.6 s                                                                              |
| 105 MB, 20-page IDML: ready → first visible paint                                                         | 1.98 s → 21.5 s                                                                              |
| Memory, page + workers (`measureUserAgentSpecificMemory`)                                                 | idle 92 MB; 54 MB document 1.68 GB → 2.31 GB after a minute of use; 105 MB document 3.63 GB  |
| Main-thread JS heap with a large document                                                                 | 199–302 MB                                                                                   |
| Canvas share of the window                                                                                | 25% at 1280 × 720, 33% at 1440 × 900, 45% at 1920 × 1080, 17% at 1024 × 768, 4% at 800 × 600 |
| Zoom range                                                                                                | keyboard 0.28%–63,484%; ctrl-wheel up to 1,600%                                              |
| Menu shortcut-hint contrast                                                                               | 2.94:1 dark, 2.30:1 light (AA needs 4.5:1)                                                   |
| Accessibility tree                                                                                        | 3 landmarks, 0 headings, 0 tabs; 3 of 102 controls unnamed                                   |

The canvas renders in a worker on an `OffscreenCanvas`, so the latencies above end at the main thread's next frame after the engine answered. They do not include the worker's own present.

## Findings by area

### Document lifecycle

<a id="f-01"></a>

#### F-01 · Dropping a file on the canvas replaces an edited document without asking

**Severity:** blocker · **Effort:** S · **Affects:** Everyone who drags files in; worst for new users who have not saved yet.

The canvas drop target hands the file straight to the open path. The discard check that File ▸ New and File ▸ Open run is skipped, so unsaved work is replaced at once. A never-saved document is gone: the library versions only saved documents.

**Steps to reproduce**

1. File ▸ New document.
2. Draw a rectangle (the title bar shows "Edited").
3. Drag a .docx from the desktop onto the canvas (every file type takes the same path).

**Expected:** The same "unsaved edits" prompt as File ▸ Open, or a choice between placing the file and opening it.

**Actual:** The document is replaced by the dropped file with no prompt (0 dialogs raised; the page count went from 1 to the dropped file's).

**Recommendation:** Route the drop handler (`packages/shell/src/cockpit/CockpitLayout.tsx`, `onDrop` → `onFile`) through `confirmDiscard`. Better: a dropped image, Word or spreadsheet file onto an open document should place it (see F-03).

**Evidence:** Synthetic DataTransfer drop; `documentMeta().dirty` was true before the drop; no dialog event fired.

**Screenshots:** `F-01-drop-replaces-unsaved-doc.png`

<a id="f-02"></a>

#### F-02 · Corrupt or unsupported files fail silently, sometimes with a success message

**Severity:** major · **Effort:** S · **Affects:** Everyone who opens files; support load.

Opening a damaged .idml leaves the editor on "No document" with nothing on screen. The only trace is the tooltip of the 7 px status dot next to the document name. That tooltip claims success for a truncated .idml ("imported broken.idml") and shows a raw engine error for a .txt file ("load failed: Error: load failed (parse): zip: invalid Zip archive: Could not find EOCD"). The Problems panel says "No problems detected".

**Steps to reproduce**

1. Open a file whose extension is .idml but whose contents are not a valid ZIP.
2. Open a plain .txt file the same way.
3. Open the Problems panel.

**Expected:** A visible error (a dialog or a toast) naming the file and a plain reason, such as "This file is not a valid IDML package". The failure is also listed in Problems.

**Actual:** Nothing visible. The status dot is amber, the same colour it has after a successful open (F-07).

**Recommendation:** Surface load failures in a dialog or toast with the file name and a human reason. Never report "imported" unless a document was produced. Push the failure to Problems.

**Evidence:** Chip tooltips captured from `[data-document-chip]` after each open.

**Screenshots:** `F-02-corrupt-file-silent.png`

<a id="f-03"></a>

#### F-03 · Spreadsheets and images are accepted but lead to a dead end

**Severity:** major · **Effort:** M · **Affects:** Users of the sheet and image modules and anyone dragging assets in.

File ▸ Open (and drop) accept .xlsx and .psd/.png, but they do not open as documents the way .docx, .pptx and .pdf do. With no document open, an .xlsx fills the Workbook panel ("Imported sheet-….xlsx") and a .psd fills Image adjustments ("Select an image frame and Apply to composite"). Either way the canvas still says "No document". With a document open, a dropped image is decoded into the Image panel but not placed on the page.

**Steps to reproduce**

1. Fresh start, no document: open an .xlsx file.
2. Fresh start: open a .psd file.
3. Open any document and drop a .png on the page.

**Expected:** Every accepted type gives a visible result. A spreadsheet opens as a document with the range placed; an image opens as a page sized to the image or is placed where it is dropped, as InDesign does.

**Actual:** The panel fills while the canvas stays empty, or nothing appears on the page.

**Recommendation:** Give every importer an outcome on the canvas: create a document, or arm Place with the dropped asset. When a step is still needed, say what it is in the canvas empty state, not only in a side panel.

**Screenshots:** `F-03-xlsx-open-dead-end.png`, `F-03-psd-open-dead-end.png`, `F-03-image-drop-not-placed.png`

<a id="f-04"></a>

#### F-04 · "New document…" has no options: always one US Letter page in points

**Severity:** major · **Effort:** M · **Affects:** Every new-document user; most of Europe works in A4 and mm.

File ▸ New document… carries an ellipsis but opens no dialog. It always creates one 612 × 792 pt page with no margins, columns, bleed, facing pages or unit choice.

**Steps to reproduce**

1. File ▸ New document…

**Expected:** A New Document dialog with presets (A4, Letter, social sizes), page count, facing pages, margins, columns, bleed and units, remembered between uses.

**Actual:** A blank Letter page appears immediately.

**Recommendation:** Add a New Document dialog, or remove the ellipsis and add size presets to the command. Default to the locale's paper size.

**Screenshots:** `F-04-new-document-no-dialog.png`

<a id="f-05"></a>

#### F-05 · Discard prompt is a native OK/Cancel confirm with Mac-only wording and no Save

**Severity:** minor · **Effort:** S · **Affects:** Everyone; Windows and Linux users see the wrong key.

File ▸ New and File ▸ Open on an edited document show `window.confirm`: "This document has unsaved edits. Creating a new document will discard them. Save with Cmd+S first, or continue to discard." The user has to cancel, save and repeat. The text says Cmd+S on every platform. The code comment calls the native dialog deliberate and "a fine follow-up".

**Steps to reproduce**

1. Edit a document.
2. File ▸ New document…

**Expected:** A three-way dialog (Save, Don't save, Cancel), with the platform's chord in the text.

**Actual:** A native OK/Cancel confirm.

**Recommendation:** Replace it with the shell's dialog and a Save button that saves and then continues. Use `prettyKey` for the chord.

**Evidence:** Dialog text captured from the browser dialog event. Native dialogs do not appear in page screenshots; the screenshot shows the dirty state that triggers the prompt. Source: `packages/shell/src/state/commands/file-commands.ts` (`confirmDiscard`).

**Deliberate?** documented in code as deliberate.

**Screenshots:** `F-05-dirty-state-before-prompt.png`

<a id="f-06"></a>

#### F-06 · No session continuity: reload loses the document; Open recent and Close are stubs

**Severity:** major · **Effort:** M · **Affects:** Everyone, especially after a browser crash or update.

After a reload the editor comes back on "No document", although the library (OPFS) holds the document. File ▸ Open recent and File ▸ Close are disabled "soon" items, and there is no autosave. A reload or a crashed tab therefore always costs the working state, unless the user saved and reopens it from the Library panel.

**Steps to reproduce**

1. Open a document and open a few panels.
2. Reload the tab.

**Expected:** The last document reopens, or the start screen offers recent documents. Close works.

**Actual:** "No document".

**Recommendation:** Reopen the last library document on start, or show recent library documents in the empty state. Wire Open recent to the library. Implement Close.

**Deliberate?** documented limit (status.md: no autosave, no recent files).

**Screenshots:** `F-06-reload-loses-document.png`

<a id="f-07"></a>

#### F-07 · Save state is unreadable: the status dot is amber after every open, and a save gives no feedback

**Severity:** minor · **Effort:** S · **Affects:** Everyone.

The document chip's dot shows the engine status whenever the status string is not "ready". After an open the string is "imported X.idml", and after New it is "loaded 1 page". So the dot stays amber, the colour of "Edited — not saved", for the whole session, and the saved and dirty states never show. ⌘S downloads `name.paged` with no toast, and the chip does not change. The canvas title bar carries a separate "Edited" label.

**Steps to reproduce**

1. Open any document: the dot is amber.
2. Press ⌘S: a download starts and nothing in the UI changes.

**Expected:** One clear state (Saved or Edited) and a confirmation that names the destination after a save.

**Actual:** An amber dot that never changes, and silence after a save.

**Recommendation:** Treat the engine's post-load messages as ready (`packages/shell/src/chrome/Header.tsx`, `DocumentChip`). Show "Saved to … / Downloaded …" after Save. Merge the chip dot and the "Edited" label into one indicator.

**Screenshots:** `F-07-status-dot-after-save.png`

<a id="f-08"></a>

#### F-08 · Imported Word and PowerPoint files start out "Edited"

**Severity:** minor · **Effort:** S · **Affects:** Doc and slide module users.

Straight after opening a .docx or .pptx, the canvas title bar shows "Edited", so New, Open and reload warn about unsaved edits the user never made.

**Steps to reproduce**

1. Open a .docx file.
2. Look at the canvas title bar.

**Expected:** A freshly imported document is clean until the user changes it.

**Actual:** "Edited" immediately.

**Recommendation:** Mark the document saved (`markSaved`) after an importer's own post-import mutations.

**Screenshots:** `F-08-docx-marked-edited.png`

<a id="f-09"></a>

#### F-09 · Problems panel contradicts Publication health; nothing alerts on open

**Severity:** minor · **Effort:** S · **Affects:** Print production users.

In a document with two missing links, Publication health and the Document Map show "2 missing links", while Problems says "No problems detected". Nothing is announced on open: InDesign's Missing Fonts and Missing Links dialogs have no equivalent. The pink substitution highlight and the Fonts and Links panels do work.

**Steps to reproduce**

1. Open a document with missing links.
2. Open Problems from the right rail.

**Expected:** Problems lists the missing links and fonts, and the open is followed by a non-modal notice offering Relink and Find font.

**Actual:** Problems is empty; the counts sit only in the left column.

**Recommendation:** Feed link and font findings into Problems. Add an "N issues after opening" notice with actions.

**Screenshots:** `F-09-problems-vs-health.png`

<a id="f-10"></a>

#### F-10 · The first-run screen and the Open picker only know IDML

**Severity:** minor · **Effort:** S · **Affects:** First-time users.

The empty canvas says "Drop an IDML file here, or use File ▸ Open IDML…", but the menu item is "Open…". The native picker lists only .paged and .idml, so Word, PowerPoint, Excel, PDF and PSD files hide behind "All files". The empty state offers no buttons: no New, Open or recent documents, and no hint that the modules exist.

**Steps to reproduce**

1. Start the editor with no document.
2. Read the empty state; use File ▸ Open…

**Expected:** An empty state with New document, Open… and recent documents, plus the list of formats that open.

**Actual:** One line of grey text naming one format and a menu label that does not exist.

**Recommendation:** Rewrite the empty state with real buttons. Add each importer's types to the `showOpenFilePicker` filter (`packages/shell/src/PagedShell.tsx`).

**Deliberate?** the picker filter is a documented limit (status.md).

**Screenshots:** `F-10-empty-state.png`

<a id="f-11"></a>

#### F-11 · PDF export defaults to a standard the document cannot meet

**Severity:** major · **Effort:** S · **Affects:** Everyone exporting.

File ▸ Export PDF… opens with Conformance set to PDF/X-4 and a red message: "PDF/X-4 requires an output-intent profile — register one in the Color settings panel or switch to PDF 1.7." Export stays disabled. Every document without an output intent, including every new document, fails the default.

**Steps to reproduce**

1. Open any document without an output intent.
2. File ▸ Export PDF…

**Expected:** A default that exports, such as PDF 1.7 (or PDF/X-4 with a bundled default intent), with X-4 as an informed choice.

**Actual:** An error and a disabled Export button on first sight.

**Recommendation:** Default to the strictest standard the document can meet, or offer one-click "Use FOGRA39 / sRGB" inside the dialog.

**Screenshots:** `F-11-pdf-export-default-blocked.png`

<a id="f-12"></a>

#### F-12 · Export PDF dialog: native OS controls and no page range

**Severity:** polish · **Effort:** S · **Affects:** Export users.

The dialog draws OS-styled checkboxes and selects that do not match the kit. Pages has only "All (20)": no range, current page, or spreads-versus-pages choice. There are no saved presets inside the dialog; "Save preset" sits disabled in the Export Center.

**Steps to reproduce**

1. File ▸ Export PDF…

**Expected:** Kit controls, a page-range field and presets.

**Actual:** See the screenshot.

**Recommendation:** Use the shell's form primitives. Add a Range field and named presets.

**Screenshots:** `F-12-export-dialog-controls.png`

<a id="f-13"></a>

#### F-13 · Library panel shows content hashes and uses browser prompts

**Severity:** polish · **Effort:** S · **Affects:** Library users.

Each version shows a hash ("cfd9a99bd0") as its secondary label. "Release" (and, in server builds, opening a server repository) uses `window.prompt`. "Export with history" is styled as plain text.

**Steps to reproduce**

1. Save a document, then open Window ▸ Library.

**Expected:** Human version labels (time, who, what changed), in-panel naming and real buttons.

**Actual:** Hashes and native prompts.

**Recommendation:** Show the hash only in a details popover, and use an inline name field.

**Screenshots:** `F-13-library-hashes.png`

### Chrome: menus, header, dock, palette

<a id="f-14"></a>

#### F-14 · Object commands stay enabled with nothing selected and fail silently

**Severity:** minor · **Effort:** S · **Affects:** Everyone.

With an empty selection, every Object item is enabled: Bring to front, Group, Ungroup, the Nudge items, Delete, Make clipping mask, and so on. Choosing Group does nothing and says nothing. ADR 024's rule that the surface offer only what applies covers menus.

**Steps to reproduce**

1. Open a document and click empty pasteboard.
2. Open the Object menu and choose Group.

**Expected:** Items that need a selection are disabled, as in InDesign.

**Actual:** All are enabled, and nothing happens.

**Recommendation:** Give the `paged.object.*` menu contributions `when` predicates on the selection, the way the plugin items have them.

**Screenshots:** `F-14-object-menu-no-selection.png`, `F-14-group-nothing-selected.png`

<a id="f-15"></a>

#### F-15 · Layout menu calls working features "soon"

**Severity:** minor · **Effort:** S · **Affects:** Everyone looking for page setup.

Layout ▸ Margins and columns…, Ruler guides…, Create guides… and Numbering and section options… are disabled with a "soon" badge. Window ▸ Structure has working Margins and Columns, Guides and Numbering & Section Options panels (object-model rows per status.md).

**Steps to reproduce**

1. Open the Layout menu.
2. Compare with Window ▸ Structure.

**Expected:** The menu opens the panels that exist.

**Actual:** Disabled "soon" items.

**Recommendation:** Replace the four `soon()` seams in `apps/canvas/src/cockpit-menus.ts` with `panel()` entries, as was done for the Type menu.

**Screenshots:** `F-15-layout-menu-stale-soon.png`

<a id="f-16"></a>

#### F-16 · Shortcuts shown in menus, palette and help disagree with reality

**Severity:** minor · **Effort:** S · **Affects:** Keyboard users; anyone learning the app.

⌘0 (Fit document) and ⌘1 (Zoom to 100%) work, but View and the zoom menu show no chord, because the shortcuts live in a canvas hook (`apps/canvas/src/ui/useKeyboardShortcuts.ts`) rather than the keybinding registry. The command palette's right column shows internal ids ("paged.view.zoomIn") where chords belong. The Keyboard shortcuts panel lists ⌘D twice (Place image…, Fill down) and ⌘C/⌘V only for sheet cells, with no context.

**Steps to reproduce**

1. Open View: Fit document has no shortcut; press ⌘0 and it fits.
2. ⌘K, type "zoom".
3. Help ▸ Keyboard shortcuts.

**Expected:** One registry, the chords shown wherever a command is listed, and context named for contextual chords.

**Actual:** See the screenshots.

**Recommendation:** Move the ⌘0/⌘1/PageUp/PageDown/Home/End handlers into the keybinding registry. Show chords in the palette and drop the ids. Group the shortcuts panel by context.

**Screenshots:** `F-16-palette-ids-not-shortcuts.png`, `F-16-shortcuts-panel-duplicates.png`

<a id="f-18"></a>

#### F-18 · Window menu taxonomy is hard to scan and has duplicates

**Severity:** minor · **Effort:** S · **Affects:** Everyone hunting for a panel.

Window ▸ Styles holds Color, Color settings, Color Wheel, Gradients, Swatches and Ink Manager. Window ▸ Properties holds Layers, Align, Pathfinder, Info, Inspector and AI Assistant. Library appears at the top level and again under Other. The menu has both Pages and Pages list, and both Stories and Story. Plugins ▸ Data lists "Data query…" and "Data query". Fifteen top-level workspace items sit above eight sub-menus.

**Steps to reproduce**

1. Open Window and each sub-menu.

**Expected:** Categories that match InDesign's (Color, Type & Tables, Object & Layout, Output, Interactive, Utilities), with one entry per panel.

**Actual:** See the screenshot.

**Recommendation:** Rebuild the categories from the panel registry with an explicit category per panel, and de-duplicate titles.

**Screenshots:** `F-18-window-styles-category.png`, `F-17-window-menu-casing.png`

<a id="f-19"></a>

#### F-19 · Module commands appear outside their context

**Severity:** minor · **Effort:** M · **Affects:** Everyone; it erodes trust in the menus.

Edit ▸ Selection to path and Path to selection (paged.image) always show, even with no image. A top-level Draw menu appears when a plain host rectangle, a text frame (even while typing) or a placed image is selected. Object ▸ Path, Pathfinder and Opacity mask duplicate Plugins ▸ Draw ▸ Path, Pathfinder and Opacity mask under different names: Object has "Type on a path", Draw has "Type on path". This breaks ADR 024's rule that menus follow the context.

**Steps to reproduce**

1. Open Edit with a text document.
2. Click into text with the Type tool and look at the menu bar.

**Expected:** Raster commands appear only for raster content. Draw's menu appears for draw artwork, and each command has one home.

**Actual:** See the screenshots.

**Recommendation:** Give module menu contributions `when` clauses on the selection's content kind. Remove the host and module duplicates or alias them.

**Screenshots:** `F-19-edit-menu-image-items.png`, `F-19-draw-menu-while-typing.png`

<a id="f-20"></a>

#### F-20 · Right-dock tabs overflow without an affordance

**Severity:** minor · **Effort:** S · **Affects:** Everyone using more than four panels.

Opening several panels pushes the first tabs (Properties, Swatches) out of the tab strip. There is no overflow menu or chevron, and the first visible tab is cut in half ("perties"). Opening a module panel (Workbook, Image) on a fresh start already clips Properties.

**Steps to reproduce**

1. Open ten panels from Window.
2. Look at the right-dock tab strip.

**Expected:** An overflow menu, or tabs that shrink to icons.

**Actual:** Hidden and clipped tabs; the wheel scrolls the strip, but nothing says so.

**Recommendation:** Add an overflow button listing every open tab, and fade the strip's edges.

**Screenshots:** `F-20-dock-tab-overflow.png`, `F-03-xlsx-open-dead-end.png`

<a id="f-21"></a>

#### F-21 · The developer HUD is always on

**Severity:** polish · **Effort:** S · **Affects:** Everyone.

A readout over the canvas shows "GPU 60 fps · 20 pages · cache 100% (20/20) · 35.0 ms · 4% · 421, 40 · frame uca95bb / page usp (no frame)". `ViewportHud` renders unconditionally, so every build shows it, internal ids included.

**Steps to reproduce**

1. Open any document.

**Expected:** Diagnostics behind `?debug=` (the app already has `debugFlag`), and a zoom/page readout for users.

**Actual:** A dense developer readout over the artwork.

**Recommendation:** Gate `ViewportHud` behind `debugFlag("hud")`.

**Screenshots:** `F-21-debug-hud.png`

<a id="f-23"></a>

#### F-23 · Two of six modes are mostly placeholders

**Severity:** minor · **Effort:** S · **Affects:** Evaluators and new users.

Review is "Approve soon", "Request changes soon", "Compare versions soon", "No comments yet" and "Approvals coming soon". Content's main right panel is "Story status coming soon". Export lists Web bundle, Social crops and Print package as "soon". The mode bar gives these the same weight as Design.

**Steps to reproduce**

1. Click Review, then Content, in the mode bar.

**Expected:** Unbuilt modes hidden or marked as previews; each mode opens on something usable.

**Actual:** Mostly placeholder panels.

**Recommendation:** Hide Review until it has a backend. In Content, lead with the working Stories, Character and Paragraph panels.

**Screenshots:** `F-23-review-mode-placeholders.png`, `F-22-internal-ids.png`

<a id="f-24"></a>

#### F-24 · The disabled Share button is the loudest control; the tab title is "IDML canvas"

**Severity:** polish · **Effort:** S · **Affects:** Everyone.

Share is disabled (opacity 0.45 on the brand fill), but on the dark header it still reads as the primary call to action. The browser tab is titled "IDML canvas" whatever document is open.

**Steps to reproduce**

1. Look at the header and the browser tab.

**Expected:** Disabled controls that look disabled; a title of "<document> — paged".

**Actual:** See the screenshot.

**Recommendation:** Use a ghost style for the disabled Share. Set `document.title` from the document chip.

**Screenshots:** `F-24-share-button-prominence.png`

<a id="f-25"></a>

#### F-25 · AI entry points are offered when the service is unavailable

**Severity:** minor · **Effort:** S · **Affects:** Self-hosted and offline deployments.

"Search or ask…", the palette's "Powered by Claude", "Ask the AI Assistant…" in Properties and "New from a brief…" are all live. Only after the user asks do they learn it does not work; the dev server answers "Start the dev server with ANTHROPIC_API_KEY set to use Claude". The assistant still lists suggestions it cannot carry out.

**Steps to reproduce**

1. Without a configured proxy, ⌘K, type a request, press Enter.

**Expected:** Check availability once (the proxy answers 503) and hide or disable the entry points with a reason.

**Actual:** An error after the request.

**Recommendation:** Probe `/api/ai` at start and gate the ask affordances on the answer.

**Screenshots:** `F-25-ai-unavailable.png`

### Canvas gestures and text editing

<a id="f-26"></a>

#### F-26 · Dragging an unselected object draws a marquee instead of moving it

**Severity:** major · **Effort:** M · **Affects:** Everyone; this is the most frequent canvas gesture.

With the Selection tool, pressing on an unselected frame (filled or unfilled) and dragging starts a marquee. The object ends up selected but has not moved (3 of 3 trials). Moving takes two gestures: click, then drag. A selected object drags correctly and snaps to the page centre.

**Steps to reproduce**

1. Click empty pasteboard to deselect.
2. Press on a frame and drag.

**Expected:** The frame is selected and follows the pointer in one gesture, as in InDesign, Illustrator and Figma.

**Actual:** A dashed marquee; the frame stays put.

**Recommendation:** On pointer-down over a hit frame, select it and start the move gesture. Use the marquee only on empty space.

**Screenshots:** `F-26-pressdrag-marquee.png`, `F-26-unfilled-pressdrag-marquee.png`

<a id="f-27"></a>

#### F-27 · No context menus

**Severity:** major · **Effort:** M · **Affects:** Everyone, especially users coming from InDesign.

Right-click on a frame, in text, on the page or on the pasteboard opens no editor menu (0 `role=menu` elements). The canvas has no `contextmenu` handler, so a normal browser shows its own page menu (Back, Reload, Inspect) instead.

**Steps to reproduce**

1. Right-click a selected frame.
2. Right-click inside text.

**Expected:** Context menus with the frequent commands: Cut/Copy/Paste, Arrange, Group, Lock, Fitting, Effects, and Text Frame Options in text.

**Actual:** No editor menu; in a normal browser window, the browser's own page menu.

**Recommendation:** Add a context-menu registry fed by the command registry and the same `when` predicates.

**Screenshots:** `F-27-no-context-menu.png`

<a id="f-28"></a>

#### F-28 · No Cut, Copy, Paste or Duplicate for page items

**Severity:** blocker · **Effort:** L · **Affects:** Everyone.

The Edit menu has Undo, Redo, Select all, Select same and Run command. It has no Cut, Copy, Paste, Paste in Place, Duplicate or Clear. ⌘C then ⌘V on a selected frame does nothing (3 frames before, 3 after). No `cmd+c`, `cmd+x`, `cmd+v` or duplicate binding exists for frames; only sheet cells and text paste have them. Alt-drag duplicates, which works.

**Steps to reproduce**

1. Select a frame.
2. Press ⌘C, then ⌘V.
3. Open the Edit menu.

**Expected:** Cut, Copy, Paste, Paste in Place, Duplicate (⌥⇧⌘D) and Clear, across pages and between documents.

**Actual:** Nothing happens, and the menu does not offer them.

**Recommendation:** Add an internal clipboard of serialised page items: same-document first, then cross-document through the system clipboard with a custom MIME type.

**Screenshots:** `F-28-edit-menu-no-copy-paste.png`, `F-28-after-paste-nothing.png`

<a id="f-29"></a>

#### F-29 · Double-click enters the wrong editing context; Direct Selection does not reach into groups

**Severity:** major · **Effort:** M · **Affects:** Everyone editing images and groups.

Double-clicking a placed image opens paged.draw's "Vector graphic" context: the rail collapses to five pen tools and Draw settings opens. The raster context is reachable only through Plugins ▸ Image ▸ Adjust…. Double-clicking a shape inside a host group also enters "Vector graphic" instead of selecting into the group. Clicking a grouped shape with Direct Selection (A) selects the whole group. After Esc the child stays selected; a second Esc neither selects the parent group nor deselects.

**Steps to reproduce**

1. Place an image (⌘D) and double-click it.
2. Open a document with a group; double-click one of its shapes.
3. Press A and click a grouped shape.

**Expected:** Double-click on an image frame selects the image content, or enters the image context per ADR 024. On a group it selects the child. Direct Selection selects the child. Esc climbs one level at a time.

**Actual:** The vector context opens for images and grouped shapes, and Direct Selection selects the group.

**Recommendation:** Resolve double-click by content kind: image → image context, group → child, draw artwork → vector context. Let Direct Selection hit leaves. Make Esc climb the selection hierarchy.

**Deliberate?** the Direct Selection behaviour is described in status.md; the image and group double-click is not.

**Screenshots:** `F-29-dblclick-image-vector-context.png`, `F-29-dblclick-group-vector-context.png`, `F-29-direct-select-selects-group.png`

<a id="f-30"></a>

#### F-30 · No rotate zone outside the corners

**Severity:** minor · **Effort:** S · **Affects:** Users coming from Adobe tools.

With the Selection tool, a pointer 5–8 pt outside a corner still shows `nesw-resize` and resizes. At 14 pt it shows `grab`. Rotation is only on the top handle. InDesign and Illustrator rotate just outside a corner.

**Steps to reproduce**

1. Select a frame.
2. Hover 6–10 pt outside its top-right corner and drag.

**Expected:** A rotate cursor and rotation.

**Actual:** The frame resizes.

**Recommendation:** Add a rotate band outside each corner handle.

**Screenshots:** `F-30-no-corner-rotate.png`

<a id="f-31"></a>

#### F-31 · Zoom commands and limits depart from InDesign and from each other

**Severity:** minor · **Effort:** S · **Affects:** Everyone.

⌘0 fits the whole document (19 pages at 3.8%) where InDesign fits the page. ⌥⌘0 does the same; there is no Fit spread and no Zoom to selection. The zoom drop-down has four entries and accepts no typed value. Keyboard zoom runs from 0.28% to 63,484%; ctrl-wheel stops at 1,600%. At minimum zoom the ruler labels overlap into an unreadable band.

**Steps to reproduce**

1. Press ⌘0 in a multi-page document.
2. Press ⌘− forty times, then ⌘= sixty times.
3. Click the % control in the bottom bar.

**Expected:** Fit page (⌘0), Fit spread (⌥⌘0), Fit selection, presets and a typed %, one range for every zoom input (InDesign: 5–4000%), and ruler labels thinned at low zoom.

**Actual:** See the measurements and screenshots.

**Recommendation:** Add the three fit commands to the registry, clamp the camera in one place, and add presets.

**Evidence:** Camera scale read from `client.camera`: keyboard min 0.0028, max 634.8; ctrl-wheel max 16.

**Screenshots:** `F-31-min-zoom-rulers.png`, `F-31-zoom-menu.png`

<a id="f-32"></a>

#### F-32 · Documents open at "fit whole document": pages as slivers, page indicator mid-document

**Severity:** major · **Effort:** S · **Affects:** Everyone, on every open.

A 19-page document opens at 3.8% with every page a thin strip, and the page indicator reads 10 / 19, the page nearest the viewport centre. A 12-page PDF opens at 6% on page 7. The user has to press Home to see page 1.

**Steps to reproduce**

1. Open any multi-page document.

**Expected:** The first page (or spread) fitted to the window, with the indicator on 1.

**Actual:** 4–6% zoom on the middle of the document.

**Recommendation:** After load, fit page 1, which is what Home already does.

**Screenshots:** `F-32-open-fit-document.png`

<a id="f-33"></a>

#### F-33 · Shift+wheel scrolls vertically

**Severity:** polish · **Effort:** S · **Affects:** Mouse users on Windows and Linux.

Shift+wheel moved the camera by Δy = −200 and Δx = 0. With a mouse wheel on Windows and Linux, Shift+wheel is the horizontal scroll. A horizontal wheel delta does pan sideways.

**Steps to reproduce**

1. Hold Shift and turn the wheel over the canvas.

**Expected:** A horizontal pan.

**Actual:** A vertical pan.

**Recommendation:** Map Shift+deltaY to deltaX when `deltaX` is 0.

**Evidence:** Camera delta measured: shift-wheel dtx 0 / dty −200; horizontal wheel dtx −200.

**Screenshots:** `F-33-shift-wheel.png`

<a id="f-34"></a>

#### F-34 · Type-size and style shortcuts do nothing

**Severity:** minor · **Effort:** S · **Affects:** Text-heavy users.

With text selected, ⌘⇧> (size up) left the size at 12 pt. No keybinding exists for size, leading, tracking, or bold, italic and underline (none is registered in the editor or the modules). The Type menu shows no shortcuts at all.

**Steps to reproduce**

1. Select text and press ⌘⇧>.

**Expected:** InDesign's text chords: size ±, leading, tracking (⌥←/→), and bold, italic and underline (⌘⇧B/I/U).

**Actual:** No change.

**Recommendation:** Bind the standard chords to the existing Character mutations.

**Screenshots:** `F-34-text-format-shortcuts.png`

<a id="f-35"></a>

#### F-35 · The Pen tool drops back to Selection after each path

**Severity:** polish · **Effort:** S · **Affects:** Illustrators.

Finishing a path with Enter switches the active tool to Selection, so the next path needs P again. InDesign keeps the Pen.

**Steps to reproduce**

1. P, click four points, Enter.

**Expected:** The Pen stays active, and Esc or V leaves it.

**Actual:** The Selection tool is active.

**Recommendation:** Keep the Pen active after Enter.

**Screenshots:** `F-35-pen-reverts-to-selection.png`

<a id="f-36"></a>

#### F-36 · Text typed through an IME, dead keys or Option/AltGr is lost

**Severity:** blocker · **Effort:** M · **Affects:** Every non-US-keyboard user, all CJK users, and anyone typing typographic punctuation.

Text entry reads only `keydown` events whose `key` is one character, with Alt not held (`apps/canvas/src/ui/useTextEditing.ts`). Nothing handles `beforeinput` or composition. Inserting "é–@" through the input path (as an IME, dictation or the emoji picker do) added nothing, and Option+- added nothing. So the en and em dashes, typographic quotes, accents via dead keys, "@", "€", "{" and "[" on German, French and Nordic layouts, and all CJK input are untypeable.

**Steps to reproduce**

1. Create a text frame and type.
2. Insert text through an IME or the emoji picker, or press Option+- on macOS.

**Expected:** Every character the OS produces lands in the story.

**Actual:** The characters are dropped.

**Recommendation:** Drive insertion from a hidden contenteditable or textarea `beforeinput`/`input` (handling `isComposing`), and keep keydown for navigation and shortcuts only.

**Evidence:** Tested with Playwright `keyboard.insertText` (the commit path an IME, dictation or the emoji picker use) and Option+-; neither changed the story. While text is being edited no editable element holds focus, so an OS input method has no target at all. The code reads keydown only, and its printable branch requires `!e.altKey` (macOS Option, Windows AltGr) and no Ctrl. A real OS IME could not be driven headlessly.

**Screenshots:** `F-36-ime-option-chars-dropped.png`

<a id="f-37"></a>

#### F-37 · Text context surfaces show a blank font and lead with stroke settings

**Severity:** minor · **Effort:** S · **Affects:** Everyone setting type.

With a caret in new text, the control bar's font-family select is empty and the character-style select is truncated ("[No character style"). Properties shows Frame and stroke rows (Cap, Join, Miter, Gap color) before the type settings, which follow below an unrelated "Dashes & arrows" header and have no labels. The Stroke Type list shows raw ids ("StrokeStyle/$ID/Wavy").

**Steps to reproduce**

1. Type tool, drag a frame, type.
2. Look at the control bar and Properties.

**Expected:** The family and style that apply, type settings first in text context, and human names.

**Actual:** See the screenshot.

**Recommendation:** Show the resolved default face. Order Properties by context. Map stroke-style ids to names.

**Screenshots:** `F-37-text-control-bar.png`

<a id="f-38"></a>

#### F-38 · Geometry reads differently in the control bar and in Properties

**Severity:** minor · **Effort:** S · **Affects:** Layout users.

The control bar shows X/Y/W/H to one decimal (242.3 pt). Properties shows the same frame as Top/Left/Bottom/Right to two decimals (242.33 pt). Neither has InDesign's reference-point proxy, so W/H always grow from the top-left corner.

**Steps to reproduce**

1. Select a frame and compare the control bar with Properties.

**Expected:** One representation (X/Y/W/H with a reference point) and one precision.

**Actual:** Two of each.

**Recommendation:** Use X/Y/W/H with a 9-point reference proxy in both places.

**Screenshots:** `F-38-geometry-representation.png`

<a id="f-40"></a>

#### F-40 · No feedback while dragging a file over the canvas

**Severity:** polish · **Effort:** S · **Affects:** Everyone dragging files.

During `dragover` the canvas shows no outline, overlay or cursor change, so the user cannot tell whether a drop will open, place or replace (F-01).

**Steps to reproduce**

1. Drag a file over the canvas without releasing.

**Expected:** A drop overlay that says what will happen ("Place photo.png" or "Open as new document").

**Actual:** Nothing.

**Recommendation:** Add a drop overlay. It is also the place to resolve F-01 and F-03.

**Screenshots:** `F-40-no-drop-indicator.png`

### Built-in modules

<a id="f-42"></a>

#### F-42 · Sheet: no on-canvas cell editing, and typed keys go nowhere

**Severity:** major · **Effort:** L · **Affects:** Sheet module users.

Insert ▸ Spreadsheet… imports the file but places nothing: "Place on page" in the Workbook panel is a second step. The placed range is small, in the page corner, and its text overflows the cells. Double-clicking the table enters "EDITING Sheet": the rail greys out, the control bar says "no canvas tools apply here" and no cell cursor appears. Typing "42" and Enter changes nothing visible. Editing happens only in the Grid panel, which the canvas does not point to.

**Steps to reproduce**

1. Insert ▸ Spreadsheet…, choose an .xlsx file.
2. Workbook panel ▸ Place on page.
3. Double-click the table and type.

**Expected:** Insert places the range. Double-click shows a cell cursor on the canvas, typing edits the cell, and Tab and Enter move between cells.

**Actual:** See the screenshots.

**Recommendation:** Short term: open the Grid panel when the sheet context is entered, and say so in the control bar. Long term: in-frame cell editing through the scene layer.

**Screenshots:** `F-42-sheet-session.png`, `F-42-sheet-typed-nowhere.png`

<a id="f-43"></a>

#### F-43 · Image: two tool sets at once, and placed images are uncounted

**Severity:** minor · **Effort:** M · **Affects:** Image module users.

Live adjustments work: dragging Exposure updates the frame while the slider moves. The raster context, though, shows 15 tools in the rail and about 22 more unlabelled tool icons in the control bar, partly the same tools. The placed image is embedded ("inline:u1") and Publication health shows "0 Placed links". The panel spells "Colour" while the host spells "Color".

**Steps to reproduce**

1. ⌘D, place a PNG.
2. Plugins ▸ Image ▸ Adjust…

**Expected:** One tool set, a link entry (or a stated "embedded") counted in health, and one spelling.

**Actual:** See the screenshot.

**Recommendation:** Keep tools in the rail and put the active tool's options in the control bar. Count embedded images in Links as "Embedded".

**Screenshots:** `F-43-image-context-toolsets.png`

<a id="f-44"></a>

#### F-44 · Doc: the imported heading overlaps the next paragraph; health counts go stale

**Severity:** minor · **Effort:** M · **Affects:** Doc module users.

After Insert ▸ Word document… (and on open), the centred heading's line collides with the following body line. Publication health stays at "0 Stories, 0 Frames" after the insert. The outline panel and its diagnostics ("Everything in the document was carried over") are clear.

**Steps to reproduce**

1. New document, then Insert ▸ Word document… with a short memo.

**Expected:** Lines that do not collide, and counts that update.

**Actual:** See the screenshot.

**Recommendation:** Check paragraph spacing in the DOCX lowering (space-before/leading on headings). Refresh health on the documents door.

**Screenshots:** `F-44-docx-heading-overlap.png`, `F-08-docx-marked-edited.png`

<a id="f-45"></a>

#### F-45 · Module frames are labelled with host kinds

**Severity:** polish · **Effort:** S · **Affects:** Module users.

A web frame shows as "Rectangle" in the control bar and a placed sheet range as "Text frame", while the menu bar adds Web or Sheet. Insert ▸ Web frame… has an ellipsis but no dialog: it drops a 240 × 180 pt frame at a fixed spot.

**Steps to reproduce**

1. Insert ▸ Web frame…
2. Read the control bar.

**Expected:** "Web frame" and "Spreadsheet" as the selection label. An ellipsis only where a dialog follows.

**Actual:** See the screenshot.

**Recommendation:** Let a module provide the selection label. Remove the ellipsis or add placement by drawing.

**Screenshots:** `F-45-web-frame-labelled-rectangle.png`

<a id="f-46"></a>

#### F-46 · Data: engine wording, lowercase labels and native controls

**Severity:** minor · **Effort:** S · **Affects:** Data module users.

Bindings shows "bindings: [sync states] none", "preview record: ‹ prev –/– next ›", "jump to:", "Lower to document" (the rest of the product now says "Place on page"), "field (column name)", and OS-styled checkboxes. Plugins ▸ Data has both "Data query…" and "Data query".

**Steps to reproduce**

1. Data layout mode ▸ Import file… (CSV) ▸ Bindings.

**Expected:** Sentence-case labels in product language and kit controls.

**Actual:** See the screenshot.

**Recommendation:** Apply the October panel-audit wording rules to Bindings. Rename "Lower to document".

**Screenshots:** `F-46-data-bindings-wording.png`

<a id="f-47"></a>

#### F-47 · Slide: a deck behaves like a long document

**Severity:** minor · **Effort:** M · **Affects:** Slide module users.

A 10-slide deck opens as a vertical page stack at 11%. The "page N" labels sit on top of slide content, and the Document Map names slide 1 "Cover" and the rest "Page 2…". The Slides panel works (layouts, New slide) but repeats Duplicate, Delete and Hide under every thumbnail. There is no sorter view and no Play or presenter command anywhere in Plugins ▸ Slide.

**Steps to reproduce**

1. Open a .pptx.
2. Open Slides from the right rail.

**Expected:** Slide naming, a sorter or filmstrip, per-slide actions on hover or in a context menu, and a Play command.

**Actual:** See the screenshot.

**Recommendation:** Let the module set page nouns ("Slide") and the default view. Add Play.

**Screenshots:** `F-47-slide-deck-surface.png`

### Keyboard and accessibility

<a id="f-49"></a>

#### F-49 · Tab is bound to "hide panels", so focus can never move by keyboard

**Severity:** blocker · **Effort:** S · **Affects:** Keyboard-only and assistive-technology users; anyone filling a form.

Tab and Shift+Tab are global keybindings for "Toggle panels and tool rail" (InDesign's convention), and they fire from inside fields and dialogs (`packages/shell/src/registries/keybinding.ts` documents this). Each of twelve Tab presses from the document toggled the whole chrome, and focus never left `<body>`. In the Export PDF dialog, 40 presses left focus on the first select. No control can be reached by keyboard alone, which fails WCAG 2.1.1 (Keyboard) and 2.4.3 (Focus Order).

**Steps to reproduce**

1. Load a document and press Tab.
2. File ▸ Export PDF… and press Tab.

**Expected:** Tab moves focus inside chrome, panels and dialogs. Hiding panels with Tab applies only when the canvas has focus and no field is focused, or moves to another key.

**Actual:** The chrome disappears, and focus is stuck.

**Recommendation:** Fire the chrome toggle only when the canvas itself has focus (make the viewport focusable), never from `body`, fields, menus or `[role=dialog]`, so that Tab from the page enters the chrome. Offer the toggle on a second chord as well (InDesign users can keep Tab on the canvas).

**Deliberate?** the Tab toggle is documented (Concept 1, toolbar.md); its reach into fields and dialogs is a side effect.

**Screenshots:** `F-49-tab-hides-chrome.png`, `F-49-tab-stuck-in-dialog.png`

<a id="f-50"></a>

#### F-50 · ARIA structure: no menubar, tablist, main landmark or headings

**Severity:** minor · **Effort:** M · **Affects:** Screen-reader and keyboard users.

The menu bar is a `nav` of ten separate drop-downs, not a `menubar`: ArrowRight inside File does not move to Edit, and there is no F10 or Alt route. The right-dock tab strip has no `tablist` or `tab` roles (0 found). The accessibility tree has banner and two navigation landmarks, but no `main` for the canvas, no `complementary` for the docks and 0 headings (panel titles are styled text). The two round page-strip arrow buttons have no accessible name.

**Steps to reproduce**

1. Dump the accessibility tree (`locator('body').ariaSnapshot()`).
2. Open File and press ArrowRight.

**Expected:** `menubar` with arrow navigation, `tablist`/`tab`/`tabpanel`, `main` and `complementary` landmarks, panel titles as headings, and names on icon buttons.

**Actual:** See the measurements and screenshot.

**Recommendation:** Adopt Radix Menubar for the menu bar and Tabs for the right dock. Add landmarks, headings and `aria-label` on the page-strip arrows.

**Evidence:** ARIA snapshot: 240 lines, 3 landmarks (banner, navigation "Main menu", navigation "Tools"), 0 headings, 0 tabs; 3 of 102 controls without a name.

**Screenshots:** `F-50-menu-arrowright.png`

<a id="f-51"></a>

#### F-51 · Menu shortcut hints and "soon" badges fail contrast

**Severity:** minor · **Effort:** S · **Affects:** Low-vision users; anyone on a dim display.

The 11 px shortcut hints in menus measure 2.94:1 in the dark theme and 2.30:1 in the light theme, and the "soon" badges 2.46:1 and 1.96:1. WCAG AA requires 4.5:1. Body text elsewhere passes: in a scan of visible leaf text with a document open, only the wordmark's decorative dot failed in the dark theme and the search placeholder (4.35:1) in the light theme.

**Steps to reproduce**

1. Open the Object menu.

**Expected:** Hints at 4.5:1 or more.

**Actual:** See the measurements.

**Recommendation:** Raise the muted-foreground token used for menu hints, or enlarge them to 12 px or more and lighten them.

**Evidence:** Contrast computed from computed colours and effective opacity against the menu background.

**Screenshots:** `F-51-menu-hint-contrast.png`

<a id="f-52"></a>

#### F-52 · Camera animations ignore "reduce motion"

**Severity:** minor · **Effort:** S · **Affects:** Users with vestibular disorders.

With `prefers-reduced-motion: reduce` emulated, Home (fit page) still animates over about 700 ms through 11 intermediate zoom levels. PageUp and PageDown go through the same `animateCamera`. No CSS transitions were running.

**Steps to reproduce**

1. Turn on Reduce motion in the OS.
2. Open a document and press Home.

**Expected:** An instant camera jump.

**Actual:** An animated zoom.

**Recommendation:** Check `matchMedia('(prefers-reduced-motion: reduce)')` in `animateCamera`.

**Evidence:** Camera sampled each frame: 11 distinct scales over 687 ms with reduce emulated.

**Screenshots:** `F-52-reduced-motion-fit.png`

### Performance and responsiveness

<a id="f-53"></a>

#### F-53 · Large documents show a blank canvas for 15–21 s with no progress

**Severity:** major · **Effort:** M · **Affects:** Anyone opening real production files.

The editor reports ready after 1.1 s (a 54 MB, 8-page real-world IDML template) and 2.0 s (105 MB, 20 pages). The viewport stays an empty dark rectangle until 14.6 s and 21.5 s, with no spinner, progress or explanation. Spread thumbnails fill in over the next seconds.

**Steps to reproduce**

1. Open a large real-world IDML template (50–100 MB with images).
2. Watch the canvas after the page count appears.

**Expected:** Progressive rendering (text and frames first, images after), or a visible "Rendering page 1… / decoding 15 images" state.

**Actual:** Blank for 14.6 s and 21.5 s.

**Recommendation:** Render page 1 before resolving images, using placeholders. Show progress in the canvas.

**Evidence:** First paint = the first screenshot of the viewport with more than 20% non-dark pixels, polled every 250 ms. Document text in the screenshot is masked.

**Screenshots:** `F-53-heavy-doc-blank-canvas.png`

<a id="f-54"></a>

#### F-54 · Memory reaches 1.7–3.6 GB on large documents

**Severity:** major · **Effort:** L · **Affects:** Users on 8 GB machines, Chromebooks and tablets; risk of tab crashes.

`performance.measureUserAgentSpecificMemory()` (page plus workers): 92 MB idle; 1.68 GB after opening the 54 MB document and 2.31 GB after about a minute of navigation and zoom; 3.63 GB after opening the 105 MB document. The main-thread JS heap stays at 200–300 MB, so the cost is in the worker and wasm heaps.

**Steps to reproduce**

1. Open a large document; scroll through it and zoom in and out.

**Expected:** Memory in proportion to what is visible, with decoded images evicted off-screen.

**Actual:** See the measurements.

**Recommendation:** Profile the worker heap (image cache, page tiles). Cap decoded-image memory and use lower-resolution proxies for off-screen pages.

**Evidence:** Measured with measureUserAgentSpecificMemory (the app is cross-origin isolated).

**Screenshots:** none (a measured finding)

<a id="f-55"></a>

#### F-55 · Small windows leave almost no canvas, and below 1025 px the layout breaks

**Severity:** major · **Effort:** M · **Affects:** Laptop users (13–14 inch screens), split-screen users.

Both docks have fixed widths and never collapse. The canvas gets 25% of a 1280 × 720 window (544 × 422 px), 33% at 1440 × 900, 45% at 1920 × 1080 and 17% at 1024 × 768. At 800 × 600 it gets 64 px (4%): the page scrolls 225 px sideways, Share is cut off, the zoom % overlaps "Export" and the tool rail loses its lower tools.

**Steps to reproduce**

1. Resize the window to 1280 × 720, then 800 × 600.

**Expected:** Docks that collapse to their icon rails under about 1400 px, and a minimum layout that never scrolls horizontally.

**Actual:** See the screenshots.

**Recommendation:** Make the left Document Map and the right dock collapsible (Tab already hides them), auto-collapse by width, and set `min-width` so the chrome wraps rather than overflowing.

**Evidence:** Canvas share = viewport rect area ÷ window area; horizontal overflow = scrollWidth − innerWidth.

**Screenshots:** `F-55-viewport-1280x720.png`, `F-55-viewport-1024x768.png`, `F-55-viewport-800x600.png`

<a id="f-56"></a>

#### F-56 · Fast typing queues up

**Severity:** minor · **Effort:** M · **Affects:** Held keys (character and Backspace repeat), scripted or pasted keystrokes.

At normal typing speeds (2.5–8 characters/s) a character is in the model and on the next frame in a median 49–51 ms (max 61 ms), well inside budget. In a synthetic burst of about 55 characters/s (faster than typing; key repeat runs at roughly 30/s and was not measured separately) every `insertText` round-trip slows to a median 220 ms, and key-to-frame becomes a median 235 ms (max 311 ms). Inserts are sent one by one and queue in the worker.

**Steps to reproduce**

1. Hold a key down in a text frame, or type a burst.

**Expected:** Latency that stays flat as input speeds up.

**Actual:** See the measurements.

**Recommendation:** Coalesce consecutive inserts into one mutation while one is in flight.

**Evidence:** `client.mutate` wrapped in the page; keydown timestamps from a capture listener installed before the app's.

**Screenshots:** `F-56-typing-burst.png`

### Visual consistency

<a id="f-17"></a>

#### F-17 · Naming, casing and spelling drift between menus and panels

**Severity:** polish · **Effort:** S · **Affects:** Everyone.

The Window menu mixes Title Case ("Document Map", "Export Center") with sentence case ("Export settings", "Output readiness"). The same thing has two names: "Bullets and numbering…" (Type) and "Bullets & Numbering" (Window); "Numbering and section options…" (Layout) and "Numbering & Section Options" (Window); "Type on a path" (Object) and "Type on path" (Draw). Image says "Colour" where the host says "Color". "New document…" and "Web frame…" carry ellipses but open no dialog. Help ends with a trailing separator.

**Steps to reproduce**

1. Open Window, Type, Layout and the Plugins sub-menus.

**Expected:** One case style (the menus' stated sentence case), one name per thing, and ellipses only before a dialog.

**Actual:** See the screenshot.

**Recommendation:** Lint menu and panel titles in `registry-invariants.spec.ts`: case, ellipsis and duplicate names.

**Screenshots:** `F-17-window-menu-casing.png`

<a id="f-22"></a>

#### F-22 · Internal identifiers are shown to users

**Severity:** polish · **Effort:** S · **Affects:** Everyone.

Content mode's Stories list shows "u240c3b". Properties ▸ Stroke Type lists "StrokeStyle/$ID/Japanese Dots" and "StrokeStyle/$ID/Wavy". The HUD shows frame ids (F-21), and Library shows hashes (F-13).

**Steps to reproduce**

1. Click Content in the mode bar.
2. Open Stroke Type in Properties.

**Expected:** Human names; ids only in the Inspector.

**Actual:** See the screenshot.

**Recommendation:** Route these labels through the existing `displayName` helper.

**Screenshots:** `F-22-internal-ids.png`

<a id="f-48"></a>

#### F-48 · Entering an editing context shifts the whole workspace

**Severity:** polish · **Effort:** S · **Affects:** Everyone entering module content.

Entering a sheet, vector or raster context inserts an "EDITING …" breadcrumb row above the panels. The canvas, rulers and docks jump down about 28 px, and back on Esc.

**Steps to reproduce**

1. Double-click a sheet table, then press Esc.

**Expected:** A breadcrumb in an existing row (the control bar or the canvas title bar).

**Actual:** A layout jump.

**Recommendation:** Render the breadcrumb in the canvas title bar ("Untitled document › Sheet").

**Screenshots:** `F-48-context-layout-shift.png`

<a id="f-57"></a>

#### F-57 · Page labels and rulers degrade at low zoom

**Severity:** polish · **Effort:** S · **Affects:** Everyone.

At 11% the "page N" labels sit on top of the next page's content. The leftmost ruler label drops its minus sign ("300" for −300). At minimum zoom the ruler numbers overlap into an unreadable band (F-31).

**Steps to reproduce**

1. Open a slide deck or a long document at fit-document zoom.

**Expected:** Labels outside the page area, and ruler ticks thinned with zoom.

**Actual:** See the screenshots.

**Recommendation:** Place page labels in the gap between pages, and hide them when the gap is too small. Clamp the label density of the ruler.

**Screenshots:** `F-57-page-labels-overlap.png`, `F-57-ruler-minus-clipped.png`

### DTP expectations

<a id="f-39"></a>

#### F-39 · Mixed units (pt, mm, in) and no unit preference

**Severity:** major · **Effort:** M · **Affects:** Every DTP user outside the US print trade.

Everything shows in points (the control bar, Properties, rulers, "612 × 792 pt"), and there is no setting to change it. Elsewhere other units appear: the Align panel's spacing is in mm, the Prepress checklist reads "Bleed 3 mm", and the Page panel reads "8.27 in × 11.69 in". The document's own unit (`documentMeta().units`) comes back empty.

**Steps to reproduce**

1. Open Align, Prepress and the Page panel; compare with the control bar.

**Expected:** A document unit setting (mm, pt, in, px, pica) used everywhere, with typed values like "10mm" converted.

**Actual:** Three units, one of them unchangeable.

**Recommendation:** Add View ▸ Units (or a preference) and route every length field through one formatter.

**Screenshots:** `F-39-align-panel-mm.png`, `F-39-prepress-bleed-mm.png`

<a id="f-41"></a>

#### F-41 · No object Lock, Hide or Show all

**Severity:** minor · **Effort:** M · **Affects:** Layout users protecting backgrounds.

The Object menu has no Lock (⌘L), Unlock all on spread, Hide (⌘3) or Show all on spread, and ⌘L does nothing. Layers can be locked and hidden per layer (status.md), but single objects cannot.

**Steps to reproduce**

1. Select a frame, press ⌘L, open Object.

**Expected:** InDesign's object lock and hide commands.

**Actual:** Nothing.

**Recommendation:** Expose object-level `locked`/`visible` (IDML has `Locked` and `Visible` on page items) as commands with the standard chords.

**Screenshots:** `F-41-object-menu-no-lock-hide.png`

## DTP conventions: where paged departs from InDesign

| Convention                                       | paged                                     | Documented?                                              | Finding       |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- | ------------- |
| Tool keys (V, A, T, P, M, F, L, …)               | Match, all 27 verified                    | —                                                        | —             |
| Click-drag moves an unselected object            | Draws a marquee                           | No                                                       | [F-26](#f-26) |
| Direct Selection reaches into groups             | Selects the group                         | Yes (status.md)                                          | [F-29](#f-29) |
| Double-click a graphic frame selects its content | Opens the vector context                  | No; ADR 024 asks for the content's own context           | [F-29](#f-29) |
| Rotate just outside a corner                     | Resizes; top handle only                  | No                                                       | [F-30](#f-30) |
| Cut / Copy / Paste / Duplicate                   | Absent for page items                     | No                                                       | [F-28](#f-28) |
| Context menus                                    | Absent                                    | No                                                       | [F-27](#f-27) |
| Control panel with reference-point proxy         | Control bar, no proxy                     | No                                                       | [F-38](#f-38) |
| ⌘0 Fit page, ⌥⌘0 Fit spread                      | ⌘0 fits the whole document; no spread fit | No                                                       | [F-31](#f-31) |
| Spreads side by side on a pasteboard             | Pages stacked vertically                  | Yes (status.md, Limits)                                  | —             |
| New Document dialog                              | None; Letter in pt                        | No                                                       | [F-04](#f-04) |
| Measurement units preference                     | Points only; mm and in in places          | No                                                       | [F-39](#f-39) |
| Lock / Hide objects (⌘L, ⌘3)                     | Layer level only                          | No                                                       | [F-41](#f-41) |
| Missing Fonts and Links dialogs on open          | Passive counters only                     | No                                                       | [F-09](#f-09) |
| Tab hides panels                                 | Yes, also inside fields and dialogs       | Yes (toolbar.md); the reach into fields is a side effect | [F-49](#f-49) |
| Floating, dockable panels                        | Fixed docks with tabs                     | Yes (ADR 002)                                            | —             |
| Save / Don't save / Cancel on close              | Native OK/Cancel                          | Yes, in code, as interim                                 | [F-05](#f-05) |
| Autosave and recent files                        | None                                      | Yes (status.md, Limits)                                  | [F-06](#f-06) |
| Text shortcuts (⌘⇧> size, ⌥←/→ tracking)         | Not bound                                 | No                                                       | [F-34](#f-34) |

## Not tested, and why

- **Real trackpad pinch inertia and momentum scrolling.** These cannot be produced headlessly. The test used synthetic ctrl+wheel and wheel events, which the browser delivers for pinch and two-finger scroll.
- **A real OS input method (IME), dictation and dead keys.** The test used Playwright's `insertText`, which commits text the way an IME does, and Option+- for Alt characters. The code path (keydown only) confirms the result.
- **OS drag and drop from the desktop.** The test dispatched `dragover`/`drop` with a `DataTransfer` carrying real files; the handler cannot tell the difference.
- **Native open and save pickers.** The editor skips `showOpenFilePicker` under automation by design. Open went through the file-input fallback and Save through the download fallback.
- **Browser-reserved chords** (⌘1–8, ⌘W, ⌘N, ⌘T). Playwright sends keys to the page and bypasses browser accelerators, so whether Chrome steals ⌘1 (Zoom to 100%) or ⌘D (Place) before the page sees them was not observable.
- **Screen readers** (VoiceOver, NVDA). Only the accessibility tree and keyboard behaviour were inspected.
- **Worker-side present latency.** Paint happens inside a worker's `OffscreenCanvas`; main-thread frames and engine round-trips were measured instead.
- **The AI Assistant's answers and paged.server sync.** No API key or server was configured, so only their unavailable states were seen.
- **Windows and Linux.** The audit ran on macOS. Chord labels and the Ctrl mapping were read from code, not exercised.

## Method

A detached worktree of `main` at `d5df00f`, with the engine and module wasm built from the same revision (the outputs of `build-wasm-packages.sh` and `moon run <module>:wasm`), was served by Vite as the Playwright config does. Each area had its own Playwright script: menus enumerated item by item, every tool shortcut pressed and checked against the rail's active slot, gestures driven through page coordinates mapped by the live camera, and latency measured in the page with `performance.now()` and `requestAnimationFrame`. Contrast was computed from computed colours and effective opacity. Every screenshot was reviewed by eye before it was cited.
