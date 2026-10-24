# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 200–299. Records 002, 023
and 024 predate that scheme and keep their numbers. Records 200–217 were written on
2026-10-02 from the code as it stood, for decisions made earlier; their status says so.

| ADR | Title | Status |
|---|---|---|
| [002](002-cockpit-over-dockview.md) | Shell substrate: custom Cockpit, replacing Dockview | Accepted (amended 2026-10-02) |
| [023](023-shared-panels-binding-providers.md) | Shared panels: the host owns the panel, plugins provide the values | Accepted (amended 2026-10-02) |
| [024](024-context-sensitivity-is-a-core-concept.md) | Context-sensitivity is a core concept of paged | Accepted (amended 2026-10-02) |
| [200](200-engine-as-npm-wasm-packages.md) | The engine is consumed as published npm wasm packages | Accepted, recorded retroactively 2026-10-02 |
| [201](201-plugins-as-pinned-packages.md) | First-party plugins are compiled in as pinned published packages | Accepted, recorded retroactively 2026-10-02; superseded by PM-0008 (2026-10-18) |
| [202](202-render-worker-owns-the-canvas.md) | The render worker owns the canvas; main thread and engine talk over a sequenced channel and shared memory | Accepted, recorded retroactively 2026-10-02 |
| [203](203-shell-is-a-registry-host.md) | The shell is an app-agnostic registry host: the app declares, the shell renders | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-18) |
| [204](204-declarative-property-panels.md) | Property panels are declarative compositions over a curated catalogue | Accepted, recorded retroactively 2026-10-02 |
| [205](205-client-packaged-as-write-sdk.md) | The editor's wasm client is packaged as the write SDK | Accepted, recorded retroactively 2026-10-02; amended by PM-0008 (2026-10-18) |
| [206](206-package-layering-lint-zones.md) | Package layering is enforced by lint zones that have their own tests | Accepted, recorded retroactively 2026-10-02 |
| [207](207-honest-seams.md) | Unbacked UI ships as a visible, inert seam | Accepted, recorded retroactively 2026-10-02 |
| [208](208-tools-are-data-plus-gesture-handler.md) | Tools are data plus a gesture handler | Accepted, recorded retroactively 2026-10-02 (amended 2026-10-18) |
| [209](209-command-is-the-action-primitive.md) | The command is the single action primitive | Accepted, recorded retroactively 2026-10-02 |
| [210](210-design-token-bridge.md) | One token file bridges the brand system to the UI substrate | Accepted, recorded retroactively 2026-10-02 |
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
| [231](231-page-item-clipboard.md) | The page-item clipboard: Cut, Copy, Paste, Paste in place, Duplicate | Accepted 2026-10-19 |
| [232](232-canvas-context-menu.md) | The canvas context menu is made of commands | Accepted 2026-10-19 |
| [233](233-panel-controls-share-one-kit.md) | Panel controls share one kit: named by their row, refusals in words | Accepted 2026-10-19 |
| [234](234-keyboard-focus-and-text-input.md) | Keyboard focus belongs to the focused control; text arrives as input | Accepted 2026-10-19 |
| [235](235-the-selection-tools-pointer-model.md) | The Selection tools follow InDesign's pointer model | Accepted 2026-10-19 |
| [236](236-a-caret-holds-its-character-style.md) | A caret holds the character style chosen at it | Accepted 2026-10-19 |
| [237](237-a-document-opens-on-its-first-page.md) | A document opens on its first page | Accepted 2026-10-19 |
| [238](238-the-default-pdf-is-one-the-document-can-meet.md) | The default PDF is one the document can meet | Accepted 2026-10-19 |
| [240](240-react-19-features.md) | The editor uses React 19's effect events, Activity, view transitions, Fragment refs and Trusted Types | Accepted 2026-10-19 |
| [245](245-one-document-unit.md) | One document unit for every length | Accepted 2026-10-19 |
| [246](246-one-zoom-range.md) | One zoom range, and the view chords in the keybinding registry | Accepted 2026-10-19 |
| [247](247-stored-settings-are-shape-checked.md) | Stored settings are read with a shape check | Accepted 2026-10-19 |
| [248](248-an-answer-is-what-is-true.md) | An answer says what is true: failures fail, late answers are dropped, readers follow | Accepted 2026-10-19 |
| [249](249-offered-only-where-it-applies.md) | A control is offered only where it applies: the command's when, the field's kind | Accepted 2026-10-19 |
| [250](250-escape-climbs-out-of-a-group.md) | Escape climbs out of a group one level at a time | Accepted 2026-10-19 |
| [251](251-object-lock-and-hide.md) | Object lock and hide | Accepted 2026-10-19 |
| [252](252-ask-affordances-know-the-ai-service.md) | The ask affordances know whether there is an AI service | Accepted 2026-10-19 |
| [253](253-one-action-one-batch.md) | One user action is one batch | Accepted 2026-10-19 |
| [254](254-engine-values-read-in-words.md) | Engine values read in words: enum members, references, ids | Accepted 2026-10-20 |
| [255](255-every-choice-is-a-control.md) | Every choice is a control with its state | Accepted 2026-10-20 |
| [256](256-the-object-section-reads-as-the-transform-panel.md) | The Object section reads as the Transform panel; type settings lead in text | Accepted 2026-10-20 |
| [257](257-indesigns-fits-and-page-keys.md) | InDesign's fit commands and page keys, in the registry | Accepted 2026-10-20 |
| [258](258-a-dropped-picture-is-placed-where-it-lands.md) | A picture dropped on an open document is placed where it lands | Accepted 2026-10-20 |
| [259](259-landmarks-tabs-and-headings.md) | Landmarks, the dock's tabs and panel headings | Accepted 2026-10-20 |
| [261](261-the-insert-menu-draws-what-the-tools-draw.md) | Insert ▸ Rectangle and Ellipse draw what the drawing tools draw | Accepted 2026-10-20 |
| [262](262-a-file-opened-with-nothing-open-becomes-a-document.md) | A file opened with nothing open becomes a document | Accepted 2026-10-20 |
| [263](263-ruler-labels-thin-as-you-zoom-out.md) | Ruler labels thin as you zoom out | Accepted 2026-10-20 |
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
| [281](281-the-canvas-mounts-frame-surfaces.md) | The canvas mounts a bundle's frame surface over the active frame | Accepted 2026-10-22 |
| [282](282-enter-enters-owned-content.md) | Enter enters the content a plugin owns | Accepted 2026-10-23 |
| [283](283-a-frame-surface-goes-full-screen.md) | A frame surface goes full screen through a chrome override | Accepted 2026-10-23 |
| [284](284-the-breadcrumb-stays-under-the-title-bar.md) | The edit-context breadcrumb stays under the title bar; full screen carries its own | Accepted 2026-10-24 |
| [291](291-the-data-panel.md) | The Data panel: the document's data as a grid, over the data door | Accepted 2026-10-24 |
| [292](292-the-bind-popover.md) | The bind popover: field, rules, map or expression on any property field | Accepted 2026-10-24 |

Decisions made in other repositories that this editor's code rests on are listed in
[`../README.md`](../README.md). Comments in the source also cite ADR 025 (the journal) and
ADR 031 (failing loudly on a broken contract); those two records are not published.
