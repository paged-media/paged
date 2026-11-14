# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 1200–1299, from 2026-11-13
([PM-0019](../../../../docs/adr/PM-0019-editor-adr-range.md)). 200–299 is full, and the records
written after it, 300, 301 and 303–315, sit in the extensions' range (300–349): they keep their
numbers, the directory tells them apart from the extensions' records of the same numbers, and
where a number alone is ambiguous it is cited with its component ("editor ADR 304",
"extensions ADR 304"). Records 002, 023
and 024 predate that scheme and keep their numbers. Records 200–217 were written on
2026-10-02 from the code as it stood, for decisions made earlier; their status says so.

| ADR | Title | Status |
|---|---|---|
| [002](002-cockpit-over-dockview.md) | Shell substrate: custom Cockpit, replacing Dockview | Accepted (amended 2026-10-02; 2026-11-13 by 1208) |
| [023](023-shared-panels-binding-providers.md) | Shared panels: the host owns the panel, plugins provide the values | Accepted (amended 2026-10-02) |
| [024](024-context-sensitivity-is-a-core-concept.md) | Context-sensitivity is a core concept of paged | Accepted (amended 2026-10-02) |
| [200](200-engine-as-npm-wasm-packages.md) | The engine is consumed as published npm wasm packages | Accepted, recorded retroactively 2026-10-02 |
| [201](201-plugins-as-pinned-packages.md) | First-party plugins are compiled in as pinned published packages | Accepted, recorded retroactively 2026-10-02; superseded by PM-0008 (2026-10-18) |
| [202](202-render-worker-owns-the-canvas.md) | The render worker owns the canvas; main thread and engine talk over a sequenced channel and shared memory | Accepted, recorded retroactively 2026-10-02 |
| [203](203-shell-is-a-registry-host.md) | The shell is an app-agnostic registry host: the app declares, the shell renders | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-18) |
| [204](204-declarative-property-panels.md) | Property panels are declarative compositions over a curated catalogue | Accepted, recorded retroactively 2026-10-02 |
| [205](205-client-packaged-as-write-sdk.md) | The editor's wasm client is packaged as the write SDK | Accepted, recorded retroactively 2026-10-02; amended by PM-0008 (2026-10-18) |
| [206](206-package-layering-lint-zones.md) | Package layering is enforced by lint zones that have their own tests | Accepted, recorded retroactively 2026-10-02 |
| [207](207-honest-seams.md) | Unbacked UI ships as a visible, inert seam | Accepted, recorded retroactively 2026-10-02 (amended 2026-11-13 by 1208) |
| [208](208-tools-are-data-plus-gesture-handler.md) | Tools are data plus a gesture handler | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-18) |
| [209](209-command-is-the-action-primitive.md) | The command is the single action primitive | Accepted, recorded retroactively 2026-10-02 |
| [210](210-design-token-bridge.md) | One token file bridges the brand system to the UI substrate | Accepted, recorded retroactively 2026-10-02 (amended 2026-11-13 by 1209) |
| [211](211-no-backend.md) | The editor has no backend: documents are local files | Accepted, recorded retroactively 2026-10-02 |
| [212](212-one-automation-surface.md) | One automation surface for tests, demos and the playground | Accepted, recorded retroactively 2026-10-02 |
| [213](213-solo-mode.md) | Solo mode is a filter over the same app | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-22) |
| [214](214-operation-sandwich.md) | Every operation is proven by one invariant: model, pixels, byte-identical undo | Accepted, recorded retroactively 2026-10-02 |
| [215](215-measured-capability-table.md) | The capability table is measured, not declared | Accepted, recorded retroactively 2026-10-02 |
| [216](216-test-tiers.md) | Test tiers, and where each one gates | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-19) |
| [217](217-showcase-reference-document.md) | The showcase: one reference document built through the real editor | Accepted, recorded retroactively 2026-10-02 |
| [218](218-network-wall-build-time-data-origins.md) | The network wall admits exact data origins listed at build time | Accepted, 2026-10-05 |
| [219](219-plugin-documents-door.md) | A plugin may replace the open document, and the editor asks first | Accepted, 2026-10-06 |
| [220](220-wasm-modules-are-hosted.md) | Wasm modules are hosted, not deployed | Accepted, 2026-10-11 |
| [221](221-claude-through-a-same-origin-proxy.md) | Claude reaches the editor through one same-origin proxy | Accepted 2026-10-11 |
| [222](222-code-split-plugin-bundles.md) | Plugin bundles are code-split; PDF loads on first import | Accepted 2026-10-11 |
| [223](223-the-module-door.md) | The editor answers the module door from a build-time module manifest | Accepted 2026-10-11 |
| [224](224-films-are-recorded-by-the-editor.md) | The paged.media films are recorded by the editor's own test runner | Accepted 2026-10-12 |
| [225](225-the-local-library.md) | The local library: open is an import, save is a version | Proposed 2026-10-17 |
| [226](226-contribution-types-have-one-definition.md) | Contribution types have one definition: the contract, extended by the shell | Accepted 2026-10-18 |
| [227](227-surface-conformance.md) | Surface conformance: a surface counts as tested when a test asserts it under covers() | Accepted 2026-10-19 |
| [228](228-flaky-tests-are-quarantined.md) | A flaky test is quarantined with an owner and an expiry, not retried until green | Accepted 2026-10-19 |
| [229](229-react-compiler.md) | The React Compiler compiles every first-party React source | Accepted 2026-10-19 |
| [230](230-one-replace-question.md) | One question before any document replaces the open one | Accepted 2026-10-19 |
| [231](231-page-item-clipboard.md) | The page-item clipboard: Cut, Copy, Paste, Paste in place, Duplicate | Accepted 2026-10-19 (amended 2026-10-28 by 289; 2026-11-13: the verbs run in order) |
| [232](232-canvas-context-menu.md) | The canvas context menu is made of commands | Accepted 2026-10-19 |
| [233](233-panel-controls-share-one-kit.md) | Panel controls share one kit: named by their row, refusals in words | Accepted 2026-10-19 (amended 2026-11-13 by 1216) |
| [234](234-keyboard-focus-and-text-input.md) | Keyboard focus belongs to the focused control; text arrives as input | Accepted 2026-10-19 (amended 2026-11-13 by 1201; D-03 implemented 2026-11-13) |
| [235](235-the-selection-tools-pointer-model.md) | The Selection tools follow InDesign's pointer model | Accepted 2026-10-19 (amended 2026-11-13 by 1201) |
| [236](236-a-caret-holds-its-character-style.md) | A caret holds the character style chosen at it | Accepted 2026-10-19 |
| [237](237-a-document-opens-on-its-first-page.md) | A document opens on its first page | Accepted 2026-10-19 (amended 2026-11-13 by 1208) |
| [238](238-the-default-pdf-is-one-the-document-can-meet.md) | The default PDF is one the document can meet | Accepted 2026-10-19 |
| [240](240-react-19-features.md) | The editor uses React 19's effect events, Activity, view transitions, Fragment refs and Trusted Types | Accepted 2026-10-19 |
| [245](245-one-document-unit.md) | One document unit for every length | Accepted 2026-10-19 (amended 2026-11-13 by 1216) |
| [246](246-one-zoom-range.md) | One zoom range, and the view chords in the keybinding registry | Accepted 2026-10-19 (amended 2026-11-13 by 1201, 1211) |
| [247](247-stored-settings-are-shape-checked.md) | Stored settings are read with a shape check | Accepted 2026-10-19 |
| [248](248-an-answer-is-what-is-true.md) | An answer says what is true: failures fail, late answers are dropped, readers follow | Accepted 2026-10-19 |
| [249](249-offered-only-where-it-applies.md) | A control is offered only where it applies: the command's when, the field's kind | Accepted 2026-10-19 (amended 2026-11-13 by 1218) |
| [250](250-escape-climbs-out-of-a-group.md) | Escape climbs out of a group one level at a time | Accepted 2026-10-19 (amended 2026-11-13 by 1201, 1207 and 1214) |
| [251](251-object-lock-and-hide.md) | Object lock and hide | Accepted 2026-10-19 |
| [252](252-ask-affordances-know-the-ai-service.md) | The ask affordances know whether there is an AI service | Accepted 2026-10-19 |
| [253](253-one-action-one-batch.md) | One user action is one batch | Accepted 2026-10-19 |
| [254](254-engine-values-read-in-words.md) | Engine values read in words: enum members, references, ids | Accepted 2026-10-20 |
| [255](255-every-choice-is-a-control.md) | Every choice is a control with its state | Accepted 2026-10-20 |
| [256](256-the-object-section-reads-as-the-transform-panel.md) | The Object section reads as the Transform panel; type settings lead in text | Accepted 2026-10-20 |
| [257](257-indesigns-fits-and-page-keys.md) | InDesign's fit commands and page keys, in the registry | Accepted 2026-10-20 (amended 2026-11-13 by 1211) |
| [258](258-a-dropped-picture-is-placed-where-it-lands.md) | A picture dropped on an open document is placed where it lands | Accepted 2026-10-20 (amended 2026-11-13 by 1205) |
| [259](259-landmarks-tabs-and-headings.md) | Landmarks, the dock's tabs and panel headings | Accepted 2026-10-20 |
| [261](261-the-insert-menu-draws-what-the-tools-draw.md) | Insert ▸ Rectangle and Ellipse draw what the drawing tools draw | Accepted 2026-10-20 |
| [262](262-a-file-opened-with-nothing-open-becomes-a-document.md) | A file opened with nothing open becomes a document | Accepted 2026-10-20 |
| [263](263-ruler-labels-thin-as-you-zoom-out.md) | Ruler labels thin as you zoom out | Accepted 2026-10-20 (amended 2026-11-13 by 1213) |
| [264](264-a-remembered-grant-is-the-documents-own.md) | A remembered grant is the document's own, keyed by what the host opened | Accepted 2026-10-20 |
| [265](265-dock-tabs-fit-the-dock.md) | The dock's tabs fit the dock | Accepted 2026-10-20 |
| [266](266-one-source-for-the-print-output-facts.md) | One source for the print-output facts | Accepted 2026-10-20 |
| [267](267-margins-and-columns-on-the-page.md) | Margins and columns are drawn on the page | Accepted 2026-10-20 |
| [268](268-owned-native-text-keeps-the-click.md) | Owned native text keeps the Type-tool click | Accepted 2026-10-20 |
| [269](269-the-demo-guide-floats-over-the-editor.md) | The demo guide floats over the editor, and the script waits behind a disclosure | Accepted 2026-10-20 |
| [270](270-the-file-chooser-holds-its-input.md) | The file chooser holds its input until it answers | Accepted 2026-10-20 |
| [271](271-a-rail-button-shows-its-panel.md) | A rail button shows its panel | Accepted 2026-10-20 |
| [272](272-a-finished-export-closes-its-dialog.md) | A finished export closes its dialog | Accepted 2026-10-20 |
| [273](273-trusted-types-are-enforced.md) | Trusted Types are enforced | Accepted 2026-10-21 |
| [274](274-the-editor-profile-is-runtime-data.md) | The editor profile is runtime data | Accepted 2026-10-22 |
| [275](275-features-gate-what-is-offered.md) | Features gate what is offered, over surface ids | Accepted 2026-10-22 |
| [276](276-filling-a-template.md) | Filling a template | Accepted 2026-10-22 |
| [277](277-the-editor-mounts-as-an-instance.md) | The editor mounts as an instance | Accepted 2026-10-23 |
| [281](281-the-canvas-mounts-frame-surfaces.md) | The canvas mounts a bundle's frame surface over the active frame | Accepted 2026-10-22 (amended 2026-11-13 by 1214) |
| [282](282-enter-enters-owned-content.md) | Enter enters the content a plugin owns | Accepted 2026-10-23 (amended 2026-11-13 by 1201 and 1215) |
| [283](283-a-frame-surface-goes-full-screen.md) | A frame surface goes full screen through a chrome override | Accepted 2026-10-23 |
| [284](284-the-breadcrumb-stays-under-the-title-bar.md) | The edit-context breadcrumb stays under the title bar; full screen carries its own | Accepted 2026-10-24 (amended 2026-11-13 by 1215) |
| [285](285-the-history-panel.md) | The History panel lists every step by name, and a snapshot restore is one step | Accepted 2026-10-24 |
| [287](287-view-modes.md) | View modes, grids and smart guides: Outline, Overprint and Pixel Preview, the grids, snapping v2, Rotate View | Accepted 2026-10-24 (amended 2026-11-13 by 1212) |
| [289](289-the-vector-clipboard.md) | The vector clipboard: copy writes SVG, paste reads SVG | Accepted 2026-10-28 |
| [288](288-asset-export.md) | Asset Export | Accepted 2026-10-28 |
| [290](290-the-ml-service.md) | The ML service: in-browser models on demand, a local image model through the editor's own origin | Accepted 2026-10-24 |
| [291](291-the-data-panel.md) | The Data panel: the document's data as a grid, over the data door | Accepted 2026-10-24 |
| [292](292-the-bind-popover.md) | The bind popover: field, rules, map or expression on any property field | Accepted 2026-10-24 |
| [293](293-a-template-opened-as-a-document-says-so.md) | A template opened as a document says so, and offers "Edit template" | Accepted 2026-10-24 |
| [294](294-the-fill-presets-on-phones-and-tablets.md) | The fill presets on phones and tablets | Accepted 2026-10-24 |
| [295](295-free-transform.md) | Free Transform: one box, the engine's arms, a destructive distort until envelopes | Accepted 2026-10-24 |
| [298](298-control-bar-groups-per-edit-context.md) | Control-bar groups and status items follow the edit context | Accepted 2026-10-24 |
| [299](299-scoped-keybindings-over-text-input.md) | Keybindings scoped to an edit context win over the text input | Accepted 2026-10-24 |
| [300](300-markup-margin-band.md) | The markup margin band: balloons beside the page follow their anchors | Accepted 2026-10-29 |
| [301](301-in-place-header-footer-editing.md) | Headers, footers and notes are edited in place | Accepted 2026-10-28 |
| [303](303-find-and-replace.md) | Find & Replace | Accepted 2026-10-25 |
| [304](304-a-module-presentation-fills-the-screen.md) | A module's presentation fills the screen | Accepted 2026-10-25 |
| [305](305-the-audience-gets-a-window-of-its-own.md) | The audience gets a window of its own | Accepted 2026-10-25 |
| [306](306-module-views-replace-the-canvas.md) | Module views replace the canvas | Accepted 2026-10-25 |
| [307](307-the-slide-profile.md) | The slide profile: PowerPoint's Normal view and its keys | Accepted 2026-10-25 |
| [308](308-video-export-runner.md) | Video export runner: the show drawn offline, WebCodecs, an MP4 muxer, progress and Cancel | Accepted 2026-10-28 |
| [309](309-effects-transparency-and-appearance-panels.md) | The Effects, Transparency and Appearance panels and the Effect menu: kinds from core's catalog, the mask's options and Clip, every edit context | Accepted 2026-10-29 |
| [310](310-live-shape-widgets.md) | Live-shape widgets on the canvas and the Transform panel's Shape section | Accepted 2026-10-30 |
| [311](311-shared-host-surfaces-in-every-context.md) | Gradients, Picture adjustments, History and Free Transform in every edit context | Accepted 2026-10-30 |
| [312](312-the-appearance-panel-lists-every-fill-and-stroke.md) | The Appearance panel lists every fill and stroke: the native appearance front to back, Illustrator's add, duplicate, move and clear, one write each | Accepted 2026-10-31 |
| [313](313-generate-image-fills-any-image-frame.md) | Generate Image fills any image frame from the host: a selected frame or a new one, one undo step, the registry's own refusals | Accepted 2026-11-01 |
| [314](314-insert-barcode-from-the-host.md) | Insert barcode… is a host command (`paged.insert.barcode`) over the engine's `paged.barcode`, with a row in every kind of document | Accepted 2026-11-08 |
| [315](315-reference-inserts-are-host-commands.md) | Footnotes, destinations, cross-references and index entries are host commands (`paged.insert.*`) and panel forms; paged.doc's dialogs call them | Accepted 2026-11-11 |
| [1200](1200-the-interaction-contract-is-adopted.md) | The interaction contract is adopted: the specification `PM-UX-INTERACTION-001` is the normative interaction target, implemented in waves, with TARGET CHANGEs, one exception ledger and no screenshot-only gate; the UX/UI redesign strategy is the product direction | Accepted 2026-11-13 (adopted, not implemented) |
| [1201](1201-interaction-decisions.md) | Interaction decisions D-01 to D-16 and the Escape order: Shift toggles, a directional marquee, conventional Tab, the image's content first, one exit resolver, one Escape resolution per press | Accepted 2026-11-13 (decided, not implemented); amends 234, 235, 246, 250, 282 |
| [1202](1202-uxi-coverage-ratchets-the-interaction-contract.md) | An inventory mirrors the interaction contract (requirements, tests, interactions with their owners, the exception ledger, the enforced gates), and a coverage report ratchets its acceptance tests: tests claim `UXI-Tnn` in their titles, unclaimed ones are acknowledged with their task | Accepted 2026-11-13 |
| [1203](1203-save-status-says-what-is-saved-where.md) | The save status says what is saved where: one save-state machine per editor (new, editing, saving, saved locally, syncing, synced, not synced, failed, read-only, recovered), each a guarantee that held; a local save whose target failed reads "Saved locally · Not synced" with Retry (D-10) | Accepted 2026-11-13 (amended 2026-11-13 by 1224) |
| [1204](1204-recovery-journal.md) | The recovery journal: per-editor checkpoints of unsaved work in the origin-private file system, a crashed session's work offered back as Restore (a new document, never over the source), Compare or Discard; bounded and purged on save and close | Accepted 2026-11-13 |
| [1205](1205-drop-says-what-it-will-do.md) | A drop says what it will do: one resolver (place, place in the frame under the pointer, replace its picture, import, open, replace the document, refuse) shown at the pointer before the drop and carried out on it; a file that is no package replaces nothing; the open picker and the empty canvas offer every format | Accepted 2026-11-13; amends 258 |
| [1206](1206-focus-returns-to-the-opener.md) | Focus returns to the opener, else to the canvas: one focus-return service for dialogs, the palette, menus and the context menu | Accepted 2026-11-13 |
| [1207](1207-one-escape.md) | One Escape: an arbiter per editor resolves each press once, in the specification's §12.1 order; handlers by tier, the gestures still to join defer; ratchets `escape-listener` and `raw-window-key-listener` | Accepted 2026-11-13 (amended 2026-11-13 by 1214); amends 250 |
| [1208](1208-docks-are-resizable-and-the-workspace-adapts.md) | Docks are resizable and the workspace adapts: dividers and per-mode widths, wide / laptop / narrow by the width the cockpit is given, the camera keeps the centre on a resize, the Focus workspace, progressive loading stages, the header and the Window menu | Accepted 2026-11-13; amends 002, 207, 237 |
| [1209](1209-density-presets.md) | Density presets: Comfortable, Professional and Compact through `[data-density]` tokens; density never sizes the document | Accepted 2026-11-13; amends 210 |
| [1210](1210-the-interaction-coordinator.md) | The interaction coordinator: one per editor, with sessions (owners ranked by §3.4, legal phase edges, ended exactly once), epochs and guarded tokens for late answers, and a trace with no user text; the terminal events (blur, a hidden page, a lost capture, a document or tool switch, a failed worker, unmount) end every session; no refused begin and no Escape turns a drag into a pan; behind the `coordinator` flag first | Accepted 2026-11-13 |
| [1211](1211-navigation-history-and-one-current-page.md) | Navigation history and one current page: one rule for the current page (rotation included), Back and Forward through explicit navigations, every zoom route in the one range, an editable zoom field, Actual size and a calibrated size, reduced motion and tweens that yield | Accepted 2026-11-13; amends 246, 257 |
| [1212](1212-editing-aids-and-proof-view.md) | Editing aids and Proof view: eight aids each remembered on its own (two disabled until the engine supports them), one overlay rule in the host, hidden guides do not snap, Proof view masks the pasteboard at the trim or the bleed and keeps the selection | Accepted 2026-11-13; amends 287 |
| [1213](1213-page-lenses-and-semantic-zoom.md) | Page lenses and semantic zoom: the document map as Pages, Structure, Layers, Issues and Data lenses with one search, every jump recorded for Back; overview, page and detail tiers decide which handles and ruler ticks draw, never the selection or the tool; page names off the pages | Accepted 2026-11-13; amends 263 |
| [1214](1214-one-way-out-of-a-context.md) | One way out of a context: one exit resolver (reason × dirty × the module's `exitPolicy`) for every exit, a resolve prompt, the document switch resolved before the replace question; the stack as a reducer with a post-commit effect queue, hooks by frame id, the scope query, groups in the breadcrumb | Accepted 2026-11-13; amends 250 and 281 |
| [1215](1215-frame-content-edit.md) | Frame, content, edit: a picture frame enters its content first (the picture moves, the frame stays), Edit image explicitly (D-05); labels name the content; the trail lives in the context toolbar's fixed bar | Accepted 2026-11-13; amends 282 and 284 |
| [1216](1216-one-numeric-field.md) | One numeric field: one parser (units, + − × ÷, brackets, relative `+=` / `*110%`, mixed units resolved to the field's unit, the locale's decimal comma, typed errors) and one field (Enter or blur commits, Escape restores, "Mixed", messages in words, the bound badge, a scrub as one undo step with a live preview, relative entries per object); the wrappers, the control bar and the host panels use it; `host.widgets.NumericField`; rule `raw-number-input` | Accepted 2026-11-13; amends 233, 245 |
| [1217](1217-inspector-search-and-disclosure.md) | Inspector search and disclosure: Properties finds a property by label, synonym or a plugin row's text and opens its section; Frame / Content / Text groups; common sections open, advanced collapsed, remembered per kind; a multi-selection's scope ("3 objects · 2 text frames, 1 image") and "Applies to 2 of 3" editing that subset (D-16); the control bar's "More…" | Accepted 2026-11-13 |
| [1218](1218-commands-say-why-they-do-not-apply.md) | Commands say why they do not apply: `applicability(state)` answers a state and a reason (needs: a document, outside an edit context, no caret, no point editing, a selection); menus grey with the reason, the palette lists what it cannot run with why, navigates ("Go to page 14", "page B-3") and offers "Help: …"; one home per command (F-19) | Accepted 2026-11-13; amends 249 |
| [1219](1219-operation-feedback.md) | Operation feedback: one service per editor says how an operation ended (the specification's eight outcomes), an error as action, reason, whether the document changed and remedy; inline, one toast channel with no storm, or Problems for what stays; detail behind Details; `host.notify` for extensions | Accepted 2026-11-13 |
| [1220](1220-new-document.md) | New document: a dialog of purpose presets (Print, Digital, Structured) and a custom setup (size, orientation, unit, pages, bleed, margins, columns) with a live preview, remembered; `paged.file.new` with no payload stays the quick blank page | Accepted 2026-11-13 |
| [1221](1221-guided-export.md) | Guided export: the PDF export as output, readiness (blockers refuse before anything starts, warnings with their fix), what the file will be, export with named stages and Cancel, a verified result through the feedback service; kit controls, page scope, presets; the Layout rows that work | Accepted 2026-11-13; relates to 238, 266, 272 |
| [1222](1222-compatibility-report.md) | Compatibility report: every import's and export's losses (engine ADR 1097) as one report per operation, explained by area and severity with the code on demand, pages and items one click away, the summary said once after an import, the round-trip risk per format | Accepted 2026-11-13 |
| [1223](1223-publication-health-on-the-page.md) | Publication health on the page: one gathering of the publication's issues, markers on the items and pages, a page overview, a click goes there (Back and Return), selects and offers targeted fixes that say what they will do; the Issues lens reads the same issues | Accepted 2026-11-13 |
| [1224](1224-session-continuity.md) | Session continuity: the library document open last reopens at the next start when the journal offers nothing; File ▸ Close; File ▸ Open recent… (the library and the files opened lately); a library push is the save status's remote step | Accepted 2026-11-13; amends 1203 |
| [1225](1225-template-fill-says-what-is-left.md) | Template fill says what is left: Required / Optional, progress, Next field, missing content, Finish with export and save | Accepted 2026-11-14 |
| [1226](1226-snapping-says-what-it-snaps-to.md) | Snapping says what it snaps to: every snap line names its target (page centre, margin, guide, an item's edge…); one bypass key, the platform's primary modifier, for every drag and point tool | Accepted 2026-11-14 |
| [1230](1230-an-accessible-object-tree.md) | An accessible object tree: the document's spreads and page items as a virtualized WAI-ARIA tree (levels, places, set sizes; type, name, page, locked, hidden in its name), one selection with the canvas and the inspector both ways, Alt+Shift+O and Escape between it and the canvas; keyboard-only inserts that land in view, rotate and scale steps, a selection cycle through overlapping objects | Accepted 2026-11-14 |
| [1231](1231-high-contrast-and-aa.md) | High contrast and AA: every text token 4.5:1 in both themes (F-51), hints never faded; a high-contrast variant of each theme (7:1 text, 4.5:1 boundaries and focus ring, a two-tone halo on every overlay cue) by preference or `prefers-contrast`; 24 px targets; axe and a token contrast test as proof; 200 % zoom | Accepted 2026-11-14 |
| [1232](1232-performance-budgets.md) | Performance budgets: selection, typing, first paint and memory measured with the audit's methods at p50 / p95 / p99, egregious budgets asserted nightly on the production build with a generated stress document; the CPU render one tile per tick from the viewport's centre with a 64 MB tile budget; typing folded per round trip (F-56); every cache's owner and budget stated (decoded images: `EXC-003`) | Accepted 2026-11-14 |

Decisions made in other repositories that this editor's code rests on are listed in
[`../README.md`](../README.md). Comments in the source also cite ADR 025 (the journal) and
ADR 031 (failing loudly on a broken contract); those two records are not published.
