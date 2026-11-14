# Status

What the editor ships and what it does not, read from the code at commit `6d098eb`
(engine `@paged-media/canvas-wasm` 0.66.0, protocol 66). How the parts fit is in
[`architecture.md`](architecture.md). Panel-by-panel detail is in
[`reference/panels.md`](reference/panels.md), which is a dated snapshot.

## Shipped

- **Documents.** Open (`.idml`, `.paged`, and any file type a loaded plugin's importer
  claims) from the "Open…" command or by drag and drop; New document; Save as a `.paged`
  container (Cmd/Ctrl+S), to a stored file handle when there is one and otherwise as a
  download; "Save As IDML…"; "Open PDF…" through the PDF plugin's importer. The header's
  save status says what the last save did and where: saved locally, saved to the file,
  "Saved locally · Not synced" with Retry when the file did not take the bytes, "Couldn't
  save" with the reason ([ADR 1203](adr/1203-save-status-says-what-is-saved-where.md)). A
  recovery journal keeps checkpoints of unsaved work in the browser and offers them back
  after a crash or a reload: Restore (as a new document), Compare, Discard
  ([ADR 1204](adr/1204-recovery-journal.md)). The native picker and the empty canvas offer every
  format an importer opens (the empty canvas also New, Open… and the library's recent
  documents), and a file that is no package or that the engine cannot read leaves the open
  document as it was and says why. A file dragged over the canvas says what the drop will do
  before it lands (place, place into the frame under the pointer, import, open, open in place
  of this document, or refused and why), and the drop does that
  ([ADR 1205](adr/1205-drop-says-what-it-will-do.md)).
- **Export.** PDF through the export dialog, with progress and cancel; page images as PNG;
  every exporter a plugin registers, listed in the Outputs panel. Swatch libraries can be
  imported and exported as `.ase`.
- **Canvas.** Rendering in a worker, on WebGPU with a CPU fallback. Pan and zoom; click and
  marquee selection; move, resize, scale and rotate gestures with snap guides; frame content
  transforms; path-edit mode, where anchors, handles and segments drag, several anchors
  select by marquee, arrows nudge them and Delete removes them, each edit one undo step;
  text editing with caret and range selection.
- **Tools.** 28 built-in tools (`packages/tools/src/built-in-tools.ts`): 19 with a gesture
  handler (page, type, line, pen, pencil, smooth, frame and shape tools, scissors, rotate,
  scale, shear, two gradient tools, eyedropper); Selection, Direct Selection, Hand and Zoom;
  and five marked `planned`. Direct Selection is the Selection tool's pointer path plus path-edit
  mode, kept on while the tool is in hand (`packages/shell/src/state/selection-context.tsx:52-57`);
  its behaviour, and the Pen's, are paged.draw's `DirectSelectMachine` and `PenMachine`
  (`@paged-media/vector-tools`), so the Pen also continues, closes and joins open paths.
- **Commands.** A command palette, menus and keybindings over one registry. Insert commands
  for text frame, rectangle, ellipse, line, table, page and placed image; arrange, group
  and ungroup; undo and redo.
- **Panels.** 73 registered panels across six workflow modes (design, content, prepress,
  data, review, export), among them properties, character and paragraph, styles, swatches
  and colour, layers, pages, links, preflight, separations and the Export Center.
- **Plugins.** Eight first-party bundles are activated at start: draw, web, data, sheet,
  image, publish, pdf, doc. Their panels, tools, commands, importers, exporters and edit
  contexts appear in the same chrome.
- **Solo mode.** `?solo=<name>` for six profiles: `paged.draw`, `paged.image`,
  `paged.sheet`, `paged.doc`, `paged.web`, `paged.data`.
- **Phones and tablets.** The `template-fill` and `form` presets work on a phone below 720 px:
  the field sheet or the form first, 44 px touch targets, one-finger pan, pinch zoom and zoom
  buttons, and a camera input for a picture field ([ADR 294](adr/294-the-fill-presets-on-phones-and-tablets.md)).
  The full and focused editors are desktop editors.
- **Scripting.** A script editor panel runs `paged.*` scripts in the engine's interpreter,
  `paged.data.*` included (it reads the document's data service); a REPL panel parses one-line commands (`set`, `insert`, `remove`, `move`, `undo`, `redo`,
  `inspect`) into mutations. An Actions panel records and replays command invocations.
- **Diagnostics.** A Problems panel (plugin diagnostics, failed saves, missing default
  font) and a Journal panel over a local event log that can be exported as a file.
- **Playground build.** `build:demo` keeps the automation handle, a script playground and
  an iframe bridge for running `paged.*` source from an embedding page. Live scripts
  (`*-live.js`) run hands-free with `?autoplay&embed`, checked end to end by
  `tests/live-scripts.spec.ts`.
- **Templates.** The Template panel makes fields, sets what a filler may do and previews the
  template as a filler; the form fills every kind of field, text in the styles and with the
  breaks the author allows and alternates by a picker (ADR 276; engine ADRs 1000–1002, 1017).
- **Films.** The paged.media films are recorded by a Playwright project (`films`, local only,
  [ADR 224](adr/224-films-are-recorded-by-the-editor.md)); the paged.draw film is the first.

## Object model in the panels (ADR 323, in progress on a branch)

Panel fields read and write through `host.objects`, the one object registry the bundles, the
automation surface and the panels share. A schema-driven field (`PropertyField`) takes its
widget from the target's schema row; a bespoke control keeps its widget inside an
`ObjectFieldFrame`. Both write one batch over the whole selection (one undo step), offer
"Bind to data…" (the bind popover, over the data door `data@1`) and show a badge
when paged.data reports a property binding on the path
(`media.paged.data.propertyBindings`).

**Plugin objects (ADR 323 §4).** A plugin declares property rows in a schema panel
(`{ field: "property", address, path, kind }`, plugin-api 0.2.45); the renderer draws each
with the same `PropertyField` over `host.objects`. The address resolves live: the selection
(scoped to a plugin kind: `<selected> > kind`), a selector, a binding the plugin publishes
(a list row picks one object), or explicit addresses. "Bind to data…" on a plugin object
gets a durable selector through its hosting frame (`<frame Name / x-paged:oid> > kind`,
`:nth` when several). React plugin panels get the same field as `host.widgets.PropertyField`
(and `PropertyFrame` around a kept control). Panels: Web properties, Image properties
(layer, mask, smart object, 22 adjustment rows), Draw properties (+ Stroke and Fill as
core property rows), Sheet properties, Word properties; paged.slide declares five, but this
editor does not load the slide bundle yet.

| Panel                                                     | Fields on the object model                                                                                                                                                                                   | Kept on the old lane                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Stroke                                                    | 9                                                                                                                                                                                                            | —                                                                                                                   |
| Text Frame Options                                        | 7                                                                                                                                                                                                            | —                                                                                                                   |
| Text Wrap                                                 | 5                                                                                                                                                                                                            | —                                                                                                                   |
| Character                                                 | 16 schema fields (+ No break, shown once the engine reports it); family select and OpenType chips (bespoke)                                                                                                  | —                                                                                                                   |
| Paragraph                                                 | 21 schema fields (+ last line indent, auto leading, single word justification, balance ragged lines, shown once the engine reports them)                                                                     | rule above / below (no schema row: whole-struct `paragraphRule`)                                                    |
| Frame Fitting                                             | 3 schema fields; reference-point grid, fill-proportionally (bespoke)                                                                                                                                         | —                                                                                                                   |
| Color                                                     | fill (swatch collection select), tint; the mixer's Apply (`frameFillColor`, or `doc.defaultFillColor` with nothing selected)                                                                                 | —                                                                                                                   |
| Effects                                                   | 62 per-effect schema fields; the transparency targets (Object, Stroke, Fill, Text or Graphic), each with its opacity and blend; 8 enable pills; a group's Isolate blending and Knockout group (bespoke)      | —                                                                                                                   |
| Global Light (new, Object ▸ Effects)                      | angle and altitude on `doc`                                                                                                                                                                                  | —                                                                                                                   |
| Gradients, Swatches                                       | the fill field (collection select)                                                                                                                                                                           | swatch edit (`editSwatch` writes the whole colour; `swatch.space` / `swatch.value` alone would lose tint and model) |
| Bullets & Numbering                                       | list type, two marker character styles; format, expression, glyph, text after, start at (bespoke); Assign                                                                                                    | numbering continue (three-state on the wire, `text` in the schema)                                                  |
| Object / Transform                                        | opacity; W/H over `frameBounds`, rotation, scale X/Y, flip H (bespoke)                                                                                                                                       | X/Y (the transformed footprint; written by the nudge's translation plan)                                            |
| Attributes                                                | 5                                                                                                                                                                                                            | —                                                                                                                   |
| Inspector                                                 | every row whose path has a schema row                                                                                                                                                                        | rows without one (marked `data-schema="none"`)                                                                      |
| Table                                                     | 22 cell paths on `cell:<table>/<r>,<c>` (fill tint and row / column span as schema fields), 3 table paths on `table:<id>`                                                                                    | row/column/header/footer (ops, not properties)                                                                      |
| Layers                                                    | visible, locked, printable, name on `layer:<id>` (row toggles and the Layer Options fields); delete; item → layer (`itemLayer`)                                                                              | move, insert (ops)                                                                                                  |
| Paragraph / Character / Object Styles                     | the applied style (`ref`), built in each family's panel; "Style Options…"                                                                                                                                    | new / delete style (collection ops)                                                                                 |
| Cell / Table Styles                                       | "Options…" per style                                                                                                                                                                                         | apply (from the Table panel)                                                                                        |
| Style Options (new)                                       | the paragraph, character, object, cell and table style definitions on `style:<family>/<id>`: every catalog row of the family, in InDesign's sections; next style and region / bullet / number styles as refs | based on (shown, not edited)                                                                                        |
| Document Setup (new)                                      | bleed, slug, defaults, colour management, proof setup, active condition set on `doc`                                                                                                                         | —                                                                                                                   |
| Margins and Columns (new)                                 | page bounds, margins, columns, master on `page:<id>`; "All pages" = one batch                                                                                                                                | —                                                                                                                   |
| Swatch Options (new)                                      | the colour as one write of `swatch.color`; name, type, tint, alpha, alternate, ink settings                                                                                                                  | —                                                                                                                   |
| Text Variables, Numbering & Section Options, Guides (new) | every row of `textVariable:` / `section:` / `guide:`                                                                                                                                                         | create / delete (ops)                                                                                               |
| Object Options (new)                                      | corner options, arrowheads, dashes, gradient angle / length / feather, transforms, flip V, name, layer, object style, image link, labels on the selection                                                    | —                                                                                                                   |
| Anchored Object                                           | all ten anchored paths (bespoke controls in `ObjectFieldFrame`s)                                                                                                                                             | —                                                                                                                   |
| Align                                                     | the typed command `paged.align.objects` `{ kind, targets }` (one batch)                                                                                                                                      | —                                                                                                                   |
| Control, Properties                                       | reuse the migrated compositions                                                                                                                                                                              | —                                                                                                                   |

Each options panel lays out paths only: a field's type, range and widget come from the target's
schema row, and rows the schema adds that no section names appear under "More" (for a style, only
rows whose `appliesTo` names the family). "Bind to data…" on a document-level object (a style, a
swatch, a page, `doc`, …) binds the address itself, whose IDML Self id round-trips; page items
keep the name or `x-paged:oid` target.

Engine gaps the specs record as expected failures (protocol 71 local build): undo does not
restore colour settings written through `doc.renderingIntent` (`setColorSettings`).

A field marked `hideUnreported` is laid out ahead of the engine: it renders only when the
target's schema has the row and the running engine reads the path (`RequestGet` does not answer
`noSuchPath`). The paragraph's line setting and the character's No break (core ADR 153, after
engine 0.71.11) are laid out that way in the Paragraph and Character panels and in Style Options.

Not migrated yet: Tabs (`paragraphTabStops` has no schema row), the paragraph rules (whole-struct
`paragraphRule`), the story's page-growth rows (`flowGrow*`) and the collection panels
(pages, links, hyperlinks, conditions, colour groups, master pages, …), whose rows are
documents' collections rather than properties. Plugin panels migrate in their own repos.

The table addresses go through an editor-side extension of the SDK's core seam, because
the published seam answers `unmapped` for `cell:` and `table:` and its cell address does
not carry the story; it moves into the SDK (or core's `Set`) when they map them. A second
extension carries the rows the pinned engine has and the SDK's vendored catalog does not
(a cell style's fill tint) or marks read-only although the engine now stores them (a cell's
fill tint, engine 0.71.11); each applies only while the SDK's rows disagree.

## Interaction contract programme (planned)

Adopted on 2026-11-13: the interaction specification `PM-UX-INTERACTION-001` is the editor's
normative interaction target and the UX/UI redesign strategy its product direction
([ADR 1200](adr/1200-the-interaction-contract-is-adopted.md)); the specification's open
decisions are settled in [ADR 1201](adr/1201-interaction-decisions.md); the work is planned in
[`interaction-plan.md`](interaction-plan.md).

Implemented so far: the save status (DF1, [ADR 1203](adr/1203-save-status-says-what-is-saved-where.md),
`UXI-T67`), the recovery journal (DF2, [ADR 1204](adr/1204-recovery-journal.md)) and drop
intent (DF3, [ADR 1205](adr/1205-drop-says-what-it-will-do.md), `UXI-T62` to `UXI-T64`). Track DF's
second part has landed: one operation feedback service per editor says how an operation ended —
the specification's eight outcomes, an error as action, reason, whether the document changed and
remedy, on one toast channel with no storm or in Problems while it stays, the engine's words behind
Details, and `host.notify` for extensions (DF8, [ADR 1219](adr/1219-operation-feedback.md),
extensions ADR 1107; F-02); the compatibility report lists every import's and export's losses
(the engine's loss report, now also on the IDML load and export) explained, located and with each
format's round-trip risk, and says an import's summary once (DF4,
[ADR 1222](adr/1222-compatibility-report.md), `UXI-T66`); File ▸ New document… opens a dialog of
purpose presets and a custom setup with a live preview (DF5, [ADR 1220](adr/1220-new-document.md);
F-04); the PDF export is guided — readiness before anything starts, what the file will be, named
stages and Cancel, a verified result — in kit controls with a page scope and presets, and the
Layout rows open their panels (DF6, [ADR 1221](adr/1221-guided-export.md), `UXI-T68`; F-12,
F-15); the publication's issues are on the page as markers, in a page overview and in the Issues
lens, one click to the item with targeted fixes (DF7,
[ADR 1223](adr/1223-publication-health-on-the-page.md), `UXI-T55`; F-09); the clipboard's verbs run
in the order they were given and paste keeps relative geometry, Paste in place its positions
(DF9, [ADR 231](adr/231-page-item-clipboard.md) amended, `UXI-T65`); and the document open last
reopens at the next start, with File ▸ Open recent… and File ▸ Close
([ADR 1224](adr/1224-session-continuity.md); F-06). Track KF (keyboard and focus) is built: Escape is resolved
once per press by a per-editor arbiter in the specification's order, and at the top level it
clears the selection ([ADR 1207](adr/1207-one-escape.md)); every key listener hears only its own
editor's keys; Tab moves focus everywhere, the chrome toggle is `paged.view.toggleChrome`
(Cmd/Ctrl+\) and "Tab hides panels (InDesign)" an opt-in setting
([ADR 234](adr/234-keyboard-focus-and-text-input.md), amended); an input method's composition
commits once and the input follows the rotated view; focus returns to the opener of a dialog,
the palette or a menu, else the canvas ([ADR 1206](adr/1206-focus-returns-to-the-opener.md);
issue #32); lists and selects keep their keys, and Alt+arrows set leading and tracking (UX audit
F-34). The viewport's drag cancel, the gesture spine and path editing answer Escape through the
arbiter too (ADR 1210).

Track WS's first part has landed (WS0–WS7; [ADR 1208](adr/1208-docks-are-resizable-and-the-workspace-adapts.md),
[ADR 1209](adr/1209-density-presets.md)): the docks are resizable (240–480 px, per mode) and the
cockpit adapts to the width it is given (wide; laptop, the left dock a rail with a flyout; narrow,
both docks overlays), switchable in Edit ▸ Settings; a viewport resize keeps the document point at
its centre (UXI-T50); the Focus workspace (Cmd/Ctrl+.) hides everything but the canvas and the tool
rail; density presets (Comfortable, Professional, Compact) size the chrome; a load shows its stages
(recognized, geometry, first paint, refining) on the canvas and in the header and fits page 1
(UXI-T49); the header has a quiet Share and the document in the tab's title;
Review is off the mode bar, the developer readout is behind `?debug=hud`, and the Window menu
follows InDesign's categories with one sentence-case name per panel. UX audit F-17, F-18, F-21,
F-23, F-24, F-53 and F-55 close. WS8 has landed
([ADR 1211](adr/1211-navigation-history-and-one-current-page.md)): one current page for every
reader (the page at the viewport's centre, rotation included, else the nearest; UXI-T54), Back and
Forward through the places explicit navigations leave (Layout ▸ Go back / Go forward,
Cmd/Ctrl+PageUp / PageDown, buttons in the bottom bar; UXI-T55's navigation half), every zoom
route inside 5–4,000 %, an editable zoom field with the fits, Actual size (an inch as 96 CSS px)
and Calibrated size (from a screen calibration) beside 100 % (UXI-T48), and camera jumps that
respect reduced motion and yield to the next wheel or pan (UXI-T53; F-52). WS9 has landed
([ADR 1212](adr/1212-editing-aids-and-proof-view.md)): eight editing aids, each remembered on its
own, in View ▸ Editing aids and the bottom bar (frame edges, margins and columns, ruler guides, the
baseline grid, text threads, overset markers on every overset frame; hidden characters and
nonprinting items are listed but disabled until the engine supports them), hidden ruler guides no
longer snap, and Proof view (the former Preview screen mode, W) hides every aid and the selection's
handles, masks the pasteboard at the trim or the bleed with crop marks and a badge, and keeps the
selection. WS10 has landed ([ADR 1213](adr/1213-page-lenses-and-semantic-zoom.md)): the
document map navigates through five lenses with one search — Pages, Structure (sections,
headings, bookmarks, stories), Layers (named objects), Issues (pages with missing or
low-resolution images, overset stories and preflight findings) and Data (placed records, with a
binding) — each jump recorded for Back; zoomed below 15 % the handles and points give way while
the selection outline, markers and page names (now beside a page when the gap under it is too
small) stay, and from 400 % the rulers draw minor ticks (F-57).

Track IC's interaction coordinator is the canvas's default ([ADR 1210](adr/1210-the-interaction-coordinator.md)):
each editor holds the session owning the pointer, the epochs a late answer is checked against and a
development trace (`__interaction`, no user text). A press is routed once, at pointerdown, by one
table (`press-route.ts`), and its session ends exactly once: a lost pointer capture, a window
blur, a hidden page, a document or tool switch, a failed worker and unmount roll it back; a begin
the engine refuses and Escape never turn the rest of the drag into a pan, and Escape cancels a
marquee or a press too, through the Escape arbiter (`UXI-T07`–`T10`, `UXI-T61`). A click's, a
press's, a double-click's and the context menu's hit test answered after a newer press, document
or context is dropped (`UXI-T57`, `UXI-T59`). Space (and Cmd, Cmd+Space) held during a
document-changing drag waits until it settles (D-09), and a suspended Pen resumes its path; a
wheel takes the camera from an animation (`UXI-T52`); a pinch takes over a pending press
(`UXI-T71`); an Alt-drag commits the copy it previewed (`UXI-T06`); a Type-tool drag that starts
over text selects text. A press off the selection is answered in one call (hit, selection and
move), and a drag that outruns the answer moves from the press point (`UXI-T58`). The guide drag, the loaded thread cursor and an armed placement are
sessions too. `?debug=legacy-pointer` keeps the old path until IC6 removes it.

Track CM5, part b (2026-11-14): a sheet frame offers **Frame · Edit cells**; inside, the bar says
Editing cells, has Done, and warns when selected rows or columns do not print in the frame, with a
print preview of the selection (sheet ADR 532, extensions ADR 1108; F-42). paged.doc adds the
Story view — the same story as continuous text, written into the engine's story — and the Story
Map of every thread with overset and unplaced stories (doc ADR 630). paged.data shows its
workflow as six steps, a record scrubber and an outlier finder; its binding badges are the
editing aid Data bindings (data ADR 566; F-46). Template fill says Required or Optional, the
progress and the next field, blocks Finish on missing content and then offers export and save,
on phones too (ADR 1225, `UXI-T73`).

Track CM's first part has landed (CM1–CM4; [ADR 1214](adr/1214-one-way-out-of-a-context.md),
[ADR 1215](adr/1215-frame-content-edit.md), extensions ADR 1106): every way out of an edit
context — Escape, the breadcrumb, another tool, another selection, a document switch — goes
through one exit resolver that weighs the reason, whether the context holds unfinished work and
the module's declared `exitPolicy`; a dirty context whose module asks puts up a small Keep /
Discard / Cancel question, and a document switch asks it before the replace question
(`UXI-T40` to `UXI-T44`). The stack runs each context hook once, after it changed; the breadcrumb
shows entered groups and lives in the context toolbar's fixed bar, so entering a context moves
nothing (F-48); contexts and module-owned frames are named as their modules name them (F-45). A
double-click on a picture frame positions the picture inside it first; Edit image (the level
control, Enter, or a second double-click) enters paged.image (D-05). A conformance suite holds
every module's context and the specification's group C (`UXI-T35` to `UXI-T46`, `UXI-T51`), and
gate G2 is enforced. The canvas's press outside a context still commits until track IC calls the
resolver there.

Track FI (fields, the inspector, commands) has landed. The one numeric
field is built ([ADR 1216](adr/1216-one-numeric-field.md)): every number in the editor's panels,
the control bar and (as `host.widgets.NumericField`) the plugins' panels reads units,
expressions and mixed units ("10 mm + 2 pt"), relative changes ("+=5 mm", "*110%") and the
locale's decimal comma; a refused value says why; a mixed selection reads "Mixed", and a
relative change applies to each object in one undo step; a scrub previews live and is one undo
step. Properties has a search over labels, synonyms and plugin rows, sections grouped Frame /
Content / Text that open as the user left them per kind, and a multi-selection scope ("Applies
to 2 of 3" edits that part), and the control bar's "More…" opens it at the matching field
([ADR 1217](adr/1217-inspector-search-and-disclosure.md)). A command that does not apply says why:
greyed in the menus with its reason, listed with it in the palette, which also goes to a page
("go to page 14") and offers "Help: …" ([ADR 1218](adr/1218-commands-say-why-they-do-not-apply.md));
every align route honours the key object, and an align control's hover shows its reference
(D-07).

Otherwise the editor behaves as
the sections above and the existing records describe: Shift-click adds and Cmd-click toggles,
and the marquee takes what it intersects.
Wave 0's interaction inventory
(`scripts/interaction-inventory.json`, with the one exception ledger), the coverage report for
the `UXI-T` tests and the test harness are being built.

## Limits of what is shipped

- **Browser.** The application needs cross-origin isolation, `SharedArrayBuffer`,
  `OffscreenCanvas` and a module worker. Save-to-file needs the File System Access API;
  without it every save is a download.
- **CPU fallback.** Without WebGPU the live canvas draws each page from one PNG tile, 256 px
  wide by default (`apps/canvas/src/worker/render.ts:93`).
- **Page layout.** Pages are stacked vertically; the pages of a spread are not placed side
  by side (`apps/canvas/src/ui/layout.ts`).
- **Open.** Two importers may claim one extension; the first registered wins. While a file is
  dragged the browser names its type, not its file name, so a drop whose type nothing claims
  reads "Drop to open or import this file" until it lands (ADR 1205).
- **Save.** There is no autosave to the document's file and no recent-files list: the
  recovery journal keeps checkpoints of unsaved work in this browser, which are no save
  (ADR 1204), and only the page entry and the plain editor keep one. Save writes the
  `.paged` bytes to the file handle stored by the "Open…" command's native picker and
  downloads when none is stored. A push to paged.server is not reflected in the save
  status. That picker code is the only place the handle is set or cleared
  (`packages/shell/src/PagedShell.tsx:774-844`).
- **Default font.** The fallback face is fetched from `/fonts/Inter.ttf`. The dev server
  serves that path from a fixture directory outside this repository;
  `apps/canvas/public/` contains no font.
- **Seams.** Five tools, three export targets (web bundle, social crops, print package),
  the collaboration cluster in the header and several panels (comments, component library,
  review inspector, the data-suite preview, object export, export tagging) are rendered
  disabled or as placeholders. The Review mode, mostly such panels, is not offered on the
  mode bar ([ADR 207](adr/207-honest-seams.md), amended).
- **Multi-selection edits.** A property edit through a catalogue-bound panel on several
  selected elements sends one mutation per element, so it is one undo step per element
  (`packages/shell/src/catalog/binding-hook.ts:546-549`).
- **Plugins.** `@paged-media/doc` resolves through a `link:` override to a sibling checkout,
  not from the registry. Solo mode skips the other bundles' activation, not their modules.
- **Packages.** No workflow here publishes `@paged-media/client`; `@paged-media/tools` is private.
- **Tests.** The two gating Playwright projects run on Linux without a GPU. The GPU
  journeys, the fidelity suite and the journey screenshot comparisons (all 24 baselines are
  macOS) do not gate. No workflow runs `pnpm test:journal` or builds `apps/devtools`.
- **Stale documents.** The root, `apps/canvas` and `apps/devtools` READMEs describe a
  `build-wasm.sh` step that does not exist.

## Not built

- A server, accounts, sharing or real-time collaboration ([ADR 211](adr/211-no-backend.md)).
- Loading a plugin at run time, and any isolation between a bundle and the application
  ([plugin-sdk ADR 319](https://github.com/paged-media/paged/blob/main/platform/extensions/docs/adr/319-trust-line.md)).
- A unit-test runner for the application: apart from three Node scripts under `scripts/`,
  every test is a Playwright spec.
- A use for the worker-based bundle loader in `packages/shell/src/bundles/`: it is exported
  from the shell, and nothing in `apps/` imports it.
- A policy for two plugins that claim the same file extension.
- A gating CI lane for the GPU path: the GPU journey step in `tests.yml` is manual and advisory.
