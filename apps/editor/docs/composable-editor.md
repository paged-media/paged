# The composable editor — Concept

October 2026. Concept paper, initial draft. Sections describe intent. Where an implementation
later differs, [`status.md`](status.md) and the ADRs in [`adr/`](adr/README.md) are
authoritative. Nothing described here ships yet unless a section says so.

Paths are relative to the repository root unless they are links.

---

## 1. Why

The editor has two shapes today.

- **The editor.** Every bundle, every host panel and tool, and the six workflow modes of the
  cockpit ([ADR 002](adr/002-cockpit-over-dockview.md)).
- **Solo mode.** `?solo=<name>` starts the same application with one plugin bundle activated
  and an allow-list of host surfaces ([ADR 213](adr/213-solo-mode.md)). `paged.draw` is an
  illustration program, and `paged.doc` is a word processor. No second build, no second document
  model.

The next shape is an editor that whoever embeds it can compose. A partner product, whether a
web-to-print shop, a marketing platform, a PIM or DAM, or a SaaS with a "design this" button,
embeds paged and decides what its users get:

| Shape             | What the end user sees                                                                                            | Example                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Full**          | The whole editor, perhaps with the partner's theme and without some menus.                                        | An agency tool that ships a page-layout editor.         |
| **Focused**       | One module's application: today's solo profiles, configured by the host.                                          | A product team that needs a drawing surface or a sheet. |
| **Template fill** | No menus, no panels, no tool rail. A preloaded template; the user types into the open fields and swaps a picture. | A business-card order form; a store manager's poster.   |
| **Form**          | A form beside a live preview; the canvas takes no pointer edits at all.                                           | A batch of 400 shelf labels, one checked by hand.       |
| **Viewer**        | The document, read-only, with page navigation and zoom.                                                           | Proofing inside a review workflow.                      |

Two things are new, and this paper is about both:

1. **Composition becomes runtime configuration.** ADR 213 established that "a profile is
   configuration", but the profile is TypeScript compiled into the application and chosen by a
   URL parameter. An embedder needs to hand the editor a profile at start, in data, and to
   change its mind about single features afterwards.
2. **Templates and permissions.** The "template fill" shape needs a document that says which
   of its parts an end user may change, and how. It also needs an engine that refuses
   everything else, no matter which surface asks. Paged has no such concept today: the closest
   pieces are object lock ([ADR 251](adr/251-object-lock-and-hide.md)), which guards geometry
   only, and the placeholders and bindings of `paged.data`.

The thesis is the one ADR 213 already proved, carried further. **One application, one build,
one document model, one engine. Every shape is a profile plus a role.**

## 2. Requirements of an embeddable editor

Gathered from the shapes above. Each is restated as a design element in later sections.

1. **One create call.** A host mounts the editor into an element it owns and passes one
   configuration object. It gets back a handle. No URL parameters, no global state, and more
   than one editor per page is not ruled out by design.
2. **Presets, then adjustments.** A host starts from a named preset (`full`, `template-fill`,
   a solo profile) and adjusts it: drop a menu, add a command to a toolbar, hide the rulers.
   Presets are data, and so are adjustments.
3. **Every region of the chrome is optional, and its contents are an ordered list.** A host
   can remove the menu bar entirely, or keep it and choose its order. The tool rail, the
   panel slots and the header bar work the same way.
4. **What is shown is a separate matter from what is allowed.** Hiding the "Delete" command
   is a UI decision. Refusing the deletion of a locked logo is a document rule. The two layers
   must not be confused: a hidden command is still reachable from a script, a plugin or the
   automation surface.
5. **Roles.** The same document is opened by the person who designs the template and by the
   person who fills it in, and they see and may do different things.
6. **Permissions resolve in a known order.** A role's defaults, then a document-wide rule,
   then an item's own rule. A host can force a permission on or off for a session, or defer
   it to the document.
7. **Placeholders and variables.** A template names its open parts: a text field, an image
   slot, a choice among allowed values. Each has a stable name that survives saving, export and
   a round trip through InDesign.
8. **Form-based filling.** Every open part of a template can be listed and set from outside
   the canvas: from a form inside the editor, from the host's own form, or from a server.
9. **The host owns I/O.** Save, export, upload, close and "back" are actions the host
   implements. The editor has no backend ([ADR 211](adr/211-no-backend.md)), and the engine does
   no I/O ([core ADR 109](../../../engine/core/docs/adr/109-engine-does-no-io.md)). An embedded
   editor makes this a feature: the partner's storage is the storage.
10. **Headless parity.** Whatever the embedded editor can do to a template, a server can do
    without a browser: fill, validate, render, export, batch.

Three facts make paged's version of this its own:

- **The format is IDML.** A `.paged` file is a valid IDML package
  ([core ADR 118](../../../engine/core/docs/adr/118-paged-file-is-a-valid-idml-package.md)). A
  template made in InDesign should open as a template, and a template saved by paged should
  survive being opened and saved in InDesign. The policy has to live where IDML keeps foreign
  data.
- **Print output.** The end product is usually a PDF for a press. A filled template is checked
  against output rules (preflight, overset text, image resolution), not only against
  permissions.
- **Modules.** Text, images, drawings, sheets, data and web content are plugin bundles. A
  template may contain a sheet or a chart, and a profile may include or exclude whole
  modules.

## 3. Principles

- **One application.** Every shape is the ordinary editor with a profile, as ADR 213 decided
  for solo. No second entry point, no second build, no second document model. A preset that
  needs code the editor does not have is a feature request for the editor.
- **Allow-list, not deny-list.** A profile names what it keeps. A new host panel does not
  appear in every embedded editor without someone deciding so (the reasoning of ADR 213,
  `apps/editor/apps/canvas/src/solo/profiles.ts`). Adjustments to a preset may remove or add,
  but the preset itself is an allow-list.
- **Two layers, never mixed.**
  - **Features** decide what the UI offers. They live in the shell and are cosmetic.
  - **Permissions** decide what the engine accepts. They live in the document and the engine
    session, and they hold for every caller: canvas gestures, panels, the command palette, the
    `paged.*` script global, plugins, the automation surface, the CLI.
- **The engine says no, the UI does not pretend.** A refused edit comes back as an outcome
  ([plugin-sdk ADR 310](../../../platform/extensions/docs/adr/310-one-write-door.md)), and the
  UI shows it. The UI may hide what is not permitted; it never shows an affordance that the
  engine will refuse ([ADR 249](adr/249-offered-only-where-it-applies.md)).
- **The host owns storage, uploads and identity.** The editor never calls a partner's
  backend on its own initiative; it runs the host's actions.
- **Configuration is data, validated.** A profile, a feature set and a template policy are
  JSON with a schema. Unknown ids are reported, never silently ignored (see the guard of
  ADR 213, `apps/editor/scripts/solo-profiles-guard.mjs`).
- **No faked features.** An embedder sees the same honest stubs as the editor
  ([concept.md](concept.md), "What it will never do").
- **One door.** The embedding API is a façade over the surfaces that exist: `CanvasClient`
  and `mutate` ([ADR 205](adr/205-client-packaged-as-write-sdk.md)), the command registry
  ([ADR 209](adr/209-command-is-the-action-primitive.md)) and the automation surface
  ([ADR 212](adr/212-one-automation-surface.md)). It adds no second way to change a document.

## 4. The layer model

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Host application (partner product)                                       │
 │   createEditor(el, config)  ·  or  <iframe> + postMessage bridge         │
 └──────────────┬───────────────────────────────────────────────▲───────────┘
                │ config                                        │ actions: save,
                ▼                                               │ export, upload,
 ┌──────────────────────────────────────────────────────────┐   │ close, …
 │ 1  Embed        package, mount, handle, events            │───┘
 ├──────────────────────────────────────────────────────────┤
 │ 2  Profile      which bundles, which modes, which regions │  registration
 │                 and what each region holds, in order      │  (what exists)
 ├──────────────────────────────────────────────────────────┤
 │ 3  Features     runtime on/off and predicates over the    │  UI gates
 │                 surface ids that exist                    │  (what is shown)
 ├──────────────────────────────────────────────────────────┤
 │ 4  Role +       session role, document template policy,   │  engine
 │    template     per-item permissions and constraints      │  (what is allowed)
 ├──────────────────────────────────────────────────────────┤
 │ 5  Engine       one mutate door; policy checked before     │
 │                 apply; refusals as outcomes                │
 └──────────────────────────────────────────────────────────┘
                ▲
                │ same template + same values
 ┌──────────────┴───────────────────────────────────────────┐
 │ 6  Headless     paged CLI / paged-node / engine-serve:     │
 │                 fill, validate, render, export, batch      │
 └──────────────────────────────────────────────────────────┘
```

Layers 2 and 3 are about the shell. Layers 4 and 5 are about the document and the engine.
Layer 6 is the same engine without a shell. The rest of this paper takes them in turn.

## 5. Composition: the editor profile

### 5.1 What exists

Solo mode's profile (`SoloProfile` in `apps/editor/apps/canvas/src/solo/profiles.ts`)
already names most of what a composition needs:

- one bundle id;
- a title and a blurb;
- a document size;
- the host panels, tools and top-level menus it keeps;
- the cockpit slots (`ModeCockpitSlots`);
- the panel-rail entries;
- the palette suggestions.

`apps/editor/apps/canvas/src/main.tsx` resolves the profile once at module scope and filters
`BUILT_IN_PANELS`, `BUILT_IN_TOOLS`, `PANEL_RAIL` and the host menus by it. It loads only the
profile's bundle and registers one mode, so the mode switcher is not rendered.
`setChromeStorageScope` (`apps/editor/packages/shell/src/state/chrome-storage-scope.ts`) keeps
the profile's stored layout apart from the editor's.

Its limits:

- It is compiled in. A host cannot pass one.
- It filters what is _registered_. It cannot remove a region of the chrome: the header, menu
  bar, context toolbar, tool rail, panel rail and mode bar are always rendered by `PagedShell`
  (`apps/editor/packages/shell/src/PagedShell.tsx`). Only Tab and Shift+Tab and the screen
  modes hide parts of it.
- It holds exactly one bundle and one mode.

### 5.2 Regions

The regions of the chrome, as `PagedShell` and `CockpitLayout`
(`apps/editor/packages/shell/src/cockpit/CockpitLayout.tsx`) render them today, get stable ids:

| Region id         | Today                                                           | Holds (ordered)                                     |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| `header`          | `Header`: wordmark, document title, `headerExtras`              | items: commands, a title, the host's own components |
| `menubar`         | `MenuBar` inside the header                                     | top-level menus, each a list of menu items          |
| `context-toolbar` | `ContextToolbar` with the mode's `toolbarLeft`                  | contextual controls, by selection kind              |
| `tool-rail`       | `ToolRail` with the fill/stroke cluster and screen-mode control | tools and tool groups                               |
| `left`            | the cockpit's left panel                                        | one panel                                           |
| `canvas`          | `CanvasColumn`: title bar, rulers, viewport, thumbnail rail     | canvas furniture flags; the viewport itself         |
| `right`           | `RightDock`: tabs or a single inspector                         | panels                                              |
| `panel-rail`      | `PanelRail` at the right edge                                   | panel launchers                                     |
| `mode-bar`        | `ModeSwitcher` with the zoom control                            | modes, zoom, page navigation                        |
| `palette`         | `CommandPalette`                                                | on/off; suggested commands                          |
| `context-menu`    | `CanvasContextMenu` ([ADR 232](adr/232-canvas-context-menu.md)) | menu items, by target kind                          |

Each region is **optional**: absent means not rendered, not merely hidden. A region that is
present holds an **ordered list of ids from the registries the shell already hosts**: command,
menu, panel and tool ids ([ADR 203](adr/203-shell-is-a-registry-host.md)), plus a small set of
layout entries (`separator`, `spacer`, `group`). Plugin contributions keep their ids, so a
host can place `media.paged.draw.panel.brushes` in the right dock exactly like a host panel.

Two new region kinds are needed by the template shapes:

- **`form`.** A panel that lists the template's fields and edits their values (§7.10). It can
  sit in `left`, `right` or take the whole width beside a preview.
- **`actions-bar`.** A short bar of host actions: "Back", "Save", "Add to cart". It is
  rendered where the host says, top or bottom, and runs the host's actions (§8.3).

### 5.3 The `EditorProfile`

`EditorProfile` is the runtime, data-only successor of `SoloProfile`. A sketch:

```ts
interface EditorProfile {
  /** Preset this profile starts from; adjustments below apply on top. */
  extends?: PresetId; // "full" | "template-fill" | "form" | "viewer" | "solo:draw" | …
  /** Bundles to activate. Others are never fetched (ADR 222). */
  bundles?: readonly string[]; // manifest ids, e.g. "media.paged.draw"
  /** Workflow modes. One mode hides the mode switcher, as solo does. */
  modes?: readonly ModeSpec[];
  /** Regions. An absent key keeps the preset's region; null removes it. */
  regions?: Partial<Record<RegionId, RegionSpec | null>>;
  /** Canvas furniture. */
  canvas?: {
    rulers?: boolean;
    guides?: boolean;
    thumbnails?: boolean;
    titleBar?: boolean;
    pageNavigation?: "none" | "arrows" | "thumbnails";
    zoom?: "fixed-fit" | "user";
  };
  /** Document used when none is passed: a size, or a template to start from. */
  document?: { sizePt?: readonly [number, number]; template?: TemplateRef };
  /** Separates stored layout and preferences from other embeddings. */
  storageScope?: string;
}

interface RegionSpec {
  items: readonly RegionItem[]; // ids, in order
  placement?: "top" | "bottom" | "left" | "right"; // where a region may move
}

type RegionItem =
  | string // a command, panel, tool or menu id
  | { kind: "separator" | "spacer" }
  | { kind: "group"; id: string; items: readonly RegionItem[] }
  | { kind: "host"; id: string }; // a host-registered component (§8.4)
```

**Adjusting a preset** uses edits by matcher, so a host does not copy a whole list to change
one entry:

```ts
editor.ui.region("menubar").remove("menu:Window");
editor.ui
  .region("header")
  .insert({ after: "paged.file.save" }, "host:add-to-cart");
editor.ui
  .region("tool-rail")
  .set(["paged.tool.select", "paged.tool.text", "paged.tool.hand"]);
```

Matchers are an exact id, a glob (`paged.object.*`), `first` or `last`, or an index.

### 5.4 Presets

The six solo profiles become presets: `solo:draw`, `solo:image`, `solo:sheet`, `solo:doc`,
`solo:web` and `solo:data`. `?solo=<name>` keeps working as the URL spelling of `extends:
"solo:<name>"`, so ADR 213's journeys stay green. New presets:

| Preset          | Bundles                 | Regions                                                                                | Role default |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `full`          | all                     | all, as today                                                                          | `editor`     |
| `solo:<name>`   | one                     | as the solo profile                                                                    | `editor`     |
| `template-fill` | those the template uses | `canvas` (no rulers, no title bar), `form` on the right, `actions-bar`, zoom and pages | `filler`     |
| `form`          | those the template uses | `form` beside a non-interactive preview; `actions-bar`                                 | `filler`     |
| `viewer`        | those the document uses | `canvas`, page navigation, zoom                                                        | `viewer`     |
| `author`        | all                     | `full` plus the Template panel (§7.8) and a "preview as filler" switch                 | `author`     |

"Those the template uses" is computed from the document: a template with a sheet frame
activates `paged.sheet`, and one without does not.

`apps/editor/scripts/solo-profiles-guard.mjs` becomes a preset guard. It resolves every id of
every preset against the code that registers it, as it does for solo today. A host's own
profile is checked at start the same way, and unknown ids are reported through the `warning`
event (§8.2).

### 5.5 What the profile does not do

- It does not grant permissions. A preset that shows no "Delete" command still opens a
  document in which deleting is permitted, unless the role and the template say otherwise.
- It does not change the document model. A "card" is a one-page document of a card's size,
  just as solo's artboard is a one-page document (ADR 213, Context).
- It does not load code the build does not contain. Bundles are compiled-in chunks
  ([ADR 222](adr/222-code-split-plugin-bundles.md), [plugin-sdk ADR 319](../../../platform/extensions/docs/adr/319-trust-line.md));
  a profile chooses among them.

## 6. Features

### 6.1 Feature ids are surface ids

The editor already enumerates every surface it offers, for conformance
([ADR 227](adr/227-surface-conformance.md)): `command:<id>`, `panel:<id>`, `tool:<id>`,
`menu:<path>`, `keybinding:<id>`, `setting:<id>`, `importer:<id>`, `exporter:<id>`. Those
are the feature ids. No second vocabulary is invented. A few chrome features that are not
registry entries get ids of the same shape: `chrome:rulers`, `chrome:guides`,
`chrome:thumbnails`, `chrome:context-menu`, `chrome:drag-and-drop`, `chrome:keyboard`.

```ts
editor.features.disable("command:paged.object.delete");
editor.features.disable("panel:paged.layers");
editor.features.disable("menu:Window/*");
editor.features.set(
  "command:paged.page.add",
  ({ document }) => document.pageCount < 4,
);
editor.features.isEnabled("tool:paged.tool.pen"); // → boolean
```

### 6.2 Semantics

- **Globs.** `command:paged.object.*` addresses a family. `isEnabled` on a glob is true only
  when every match is enabled.
- **Predicates.** A predicate receives a read-only view: the selection, the document's
  metadata, the role, and the previous answer. It returns a boolean. The latest `set` wins;
  a predicate may defer to the previous answer, so a host can narrow a preset without
  rewriting it.
- **Where they are evaluated.** Where the shell already gates. A command's `when` and
  `entryApplies` decide whether a menu entry, a palette row or a keybinding applies
  ([ADR 209](adr/209-command-is-the-action-primitive.md), [ADR 249](adr/249-offered-only-where-it-applies.md)).
  A disabled feature is one more clause in that test, and a disabled panel or tool is
  filtered from the registry views that render the chrome.
- **Registration and features differ.** The profile decides what is _registered_; what is
  absent is never loaded. Features decide what is _offered_, and can change during a session
  without a reload.

### 6.3 Features are not security

A disabled command is still reachable through `paged.*`, a plugin or the automation surface.
That is intended: features shape a UI. Anything that must not happen to the document is a
permission (§7), checked by the engine.

## 7. Templates and permissions

### 7.1 What a template is

A **template** is an ordinary `.paged` document, therefore a valid IDML package. It carries a
**template policy** that says:

- which items are **fields** an end user fills in, and what kind;
- which **permissions** hold for the whole document and for each item;
- which **constraints** a value must meet.

There is no separate template format. A template is opened, rendered, exported and edited by
the same code as any document. Removing the policy turns it back into a plain document.

### 7.2 Where the policy lives

The policy must survive three trips: paged save and load, IDML export and import, and an
InDesign open and save. IDML already has a home for foreign key–value data, and the engine
already round-trips it:

- **Document level.** `DesignMap.labels`, written by `Operation::SetDocumentMetadata`
  (`engine/core/crates/paged-model/src/lib.rs`). The key `x-paged:template` holds the
  document-wide policy as JSON: version, default permissions, field order, form groups.
- **Item level.** `Spread::labels`, the IDML `Properties/Label` key–value pairs per item
  (`engine/core/crates/paged-model/src/lib.rs`, imported in
  `engine/core/crates/idml-import/src/spread.rs`, round-trip tests in
  `engine/core/crates/idml-export/tests/it/label_roundtrip.rs`). The key
  `x-paged:template` on an item holds its field definition and its permissions. This is the
  same `x-paged:<owner>` convention plugin metadata uses.
- **Stable names.** `Spread::item_names`, the IDML `Name` of an item, is the handle a field is
  addressed by from outside: `frame[name="headline"]` in the address grammar of
  [core ADR 131](../../../engine/core/docs/adr/131-one-address-grammar-and-selectors.md). A
  name survives an InDesign save; a `Self` id may not.

### 7.2.1 Marking fields in InDesign

Server-side template products built on InDesign have settled on one convention: the
designer marks the editable parts of a layout with **XML tags** (Window ▸ Utilities ▸ Tags),
and whatever is untagged stays as designed. Print designers know this workflow, and paged
should accept a template prepared that way without asking for a paged-specific step.

Paged already reads the XML structure. `XmlTag` and `XmlElement` in
`engine/core/crates/paged-model/src/lib.rs` (D-02, parsed in
`engine/core/crates/idml-import/src/xml_structure.rs`) hold the document's tags, the element
that tags a story or a page item, and the elements that tag ranges of a story. On IDML
export the `XML/` parts are copied from the original package and inline story elements travel
as opaque runs (`engine/core/crates/idml-export/src/lib.rs`, `src/rewrite.rs`). An imported
tagged file therefore keeps its tags, but the exporter does not yet write tags from the model:
a tag added in paged, or a tag on a document created in paged, would be lost. Writing the
XML structure from the model is planned (§12, "Decided").

Three channels mark a field, in this order of precedence:

1. **The policy label** `x-paged:template` on the item. It is written by paged's Template
   panel (§7.9) and is the only channel that carries constraints and permissions.
2. **An XML tag** on a page item or a story. A tagged text frame becomes a `text` field and a
   tagged graphic frame an `image` field. A tagged range inside a story becomes a `text-run`
   field. The tag name is the field name, and XML attributes on the element may carry a label
   and simple constraints (`maxLength`, `required`).
3. **A name or a data-merge placeholder.** An item's IDML `Name`, and data-merge `<<field>>`
   placeholders, which paged already imports (`engine/core/crates/idml-import/src/story.rs`),
   are hints that the Template panel offers to turn into fields.

**Opening a tagged InDesign file as a template** is an import step. It derives fields from
tags (and, when asked, from names and placeholders), writes the policy labels, and leaves the
tags in place. The InDesign side therefore keeps working: a designer can reopen the file,
retag a frame, and import again. Paged's Template panel shows which fields came from tags, so
an author can tell a field that is still tag-driven from one that paged edited.

### 7.3 Fields

| Kind         | Target                                          | Value                        | Written by                                                                                                     |
| ------------ | ----------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `text`       | a whole text frame's story                      | plain or lightly styled text | the existing text mutations, scoped to the story                                                               |
| `text-run`   | a placeholder run inside a story                | plain text                   | `Operation::SetFieldValue` on a `PlaceholderField` (`paged-model`, `FieldKind::Placeholder`)                   |
| `variable`   | a custom text variable, wherever it is inserted | plain text                   | the text-variable operations (`TextVariable`, `CreateTextVariable`, `InsertField`)                             |
| `image`      | a graphic frame                                 | an image (bytes or URI)      | `Operation::ReplaceImageBytes` / `PlaceImage`, then a fit ([ADR 257](adr/257-indesigns-fits-and-page-keys.md)) |
| `choice`     | a property of one or more items                 | one of an allowed list       | `Set{address, path, value}` with a value from the list (a swatch, a font, a paragraph style)                   |
| `visibility` | an item or a group                              | on or off                    | `ElementVisible`                                                                                               |
| `data`       | a `paged.data` binding                          | a record, or a field of one  | `paged.data`'s binding apply ([data ADR 552](../../../modules/data/docs/adr/552-binding-is-a-recipe.md))       |

**A field swaps content, not design.** By default a `text` field takes the value and keeps
the frame's paragraph and character styles; an `image` field takes the picture and applies the
frame's fit. Changing formatting is a separate permission (`text.style`, `image.crop`) that
the author grants deliberately. That keeps the design intent intact for most templates,
where the end user should not pick colours or point sizes.

A `variable` field fills every place the variable is inserted. A headline that repeats on the
front and back of a card is one field, not two.

`paged.data` already models Illustrator-style variables and data sets as a view over its
bindings ([data ADR 557](../../../modules/data/docs/adr/557-variables-and-data-sets.md)), and
its link between a text field and a binding is a custom text variable. Template fields
reuse that link rather than inventing a parallel one. A template field _is_ a variable or a
binding with a policy attached. The difference between the two features is who fills the
value: a person in a form, or a data source in a batch.

### 7.4 Constraints

A field may carry constraints. They are checked when a value is set and again before save
or export:

- text: `maxLength`, `maxLines`, `required`, `pattern`, and an **overflow rule**: `refuse`,
  `shrink` (step the point size down to a minimum), or `allow-and-flag` (preflight reports
  overset text);
- image: minimum effective resolution at the placed size, accepted media types, aspect-ratio
  range, and the fit applied after a replace (fill frame proportionally, fit content, centre);
- choice: the allowed list itself;
- all: a label, help text and a group for the form, all localisable.

A constraint the engine can check (overset, effective resolution, the allowed list) is checked
by the engine. Overset is already reported per story (`paged-renderer/src/diagnostics.rs`).
Effective resolution is not computed today. The engine carries InDesign's stored
`EffectivePpi` value, which goes stale after a replace or a scale, so a computation from pixel
size and placed scale is new work. A constraint only the host can judge (a valid product code) is a host
validation hook (§8.3).

### 7.5 Permissions

Permissions name what may be done to an item. The vocabulary is small and maps onto families
of engine operations (`paged_mutate::Operation`,
`engine/core/crates/paged-mutate/src/operation.rs`):

| Permission                                              | Covers                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `select`                                                | the item can be selected at all; without it, it is scenery |
| `text.edit`                                             | insert and delete text in the story                        |
| `text.style`                                            | character and paragraph formatting in the story            |
| `image.replace`                                         | replace the placed image                                   |
| `image.crop`                                            | move and scale the image inside its frame                  |
| `item.move` / `.resize` / `.rotate` / `.flip`           | geometry of the item                                       |
| `item.delete` / `.duplicate`                            | remove or copy the item                                    |
| `item.restack`                                          | change z-order or layer                                    |
| `appearance.fill` / `.stroke` / `.effects` / `.opacity` | the item's appearance                                      |
| `document.add-item`                                     | create new items (any tool that inserts)                   |
| `document.pages`                                        | add, remove, move pages                                    |
| `document.styles`                                       | create or change styles, swatches, variables               |

Each permission resolves to **allow** or **deny**. The order is:

1. the **role's defaults** (§7.6);
2. the **session override**, set by the host for this editor (`allow`, `deny`, or `defer`);
3. the **document default** in the template policy;
4. the **item's own setting**.

Where the session says `defer`, the document decides. For the `filler` role, every
permission defaults to deny. A field's kind grants the permissions it needs (a `text` field
grants `select` and `text.edit`, an `image` field `select` and `image.replace`), and the
author may grant more (`image.crop`, `text.style`).

Object lock ([ADR 251](adr/251-object-lock-and-hide.md)) stays what it is, a geometry lock for
editing. It is not a permission. For a filler, a template's items are denied geometry
changes whether locked or not.

### 7.6 Roles

A role is **session state**, set by the host when it creates the editor and changeable later.
It is **not stored in the document**: the same file is a template to its author and a form to
its filler.

| Role     | Policy applies?   | Can change the policy? | Typical shape           |
| -------- | ----------------- | ---------------------- | ----------------------- |
| `author` | no                | yes                    | `author`, `full`        |
| `editor` | no                | no                     | `full`, `solo:<name>`   |
| `filler` | yes               | no                     | `template-fill`, `form` |
| `viewer` | everything denied | no                     | `viewer`                |

The role also feeds the feature predicates (§6.2), so the UI follows it: a `filler` sees no
Template panel, an `author` sees field outlines on the canvas.

### 7.7 Enforcement in the engine

**Every write passes one door.** Panels, gestures, scripts, plugins and the CLI all reach the
engine as a `Mutation`, which lowers to `paged_mutate::Operation`s. The engine has two choke
points, each of which already runs a guard:

- `CanvasModel::apply_mutation` in `engine/core/crates/paged-canvas/src/model.rs` calls
  `refuse_unauthorable` before anything else. At this level text ranges and addresses are
  still visible.
- `apply_inner` in `engine/core/crates/paged-mutate/src/apply/mod.rs` calls
  `lock::refuse_if_locked` before it dispatches each operation, including every operation inside
  a batch.

Not every write reaches `apply_inner`. Text insertion and deletion run as text operations
directly from `apply_mutation` (`engine/core/crates/paged-canvas/src/mutate.rs`), and several
document-settings mutations return early there. The policy check therefore sits **at both
levels**:

- **beside the lock check**, at the operation level, so a batch cannot smuggle an operation
  past it;
- **in `apply_mutation`**, for the text path and the settings writes that never become an
  operation;
- **at gesture begin**, where a drag is refused before its preview starts, as the lock already
  is (`engine/core/crates/paged-canvas/src/gesture.rs`).

The check works as follows:

- The engine session gets a **role** and the resolved **session overrides**, set by a new
  wire message at load and on change.
- Before an operation applies, the check resolves the target item's permissions (§7.5) and
  refuses with a new error, `NotPermitted { permission, target }`. The editor's `mutate`
  returns this as an outcome; it does not throw ([plugin-sdk ADR 310](../../../platform/extensions/docs/adr/310-one-write-door.md)).
- **Undo and redo are exempt**: an inverse restores a state that was permitted when it was
  made. Today undo re-runs the lock check, and `lock.rs` only argues that it cannot fail. With
  roles that argument breaks: an author may switch to "preview as filler" and then undo an
  edit made as author. The exemption must therefore be explicit. Undo, redo and batch
  rollback apply without the policy.
- **Constraint checks** that belong to the engine (allowed values, overset with the `refuse`
  rule) run after a tentative apply, and roll the batch back on failure.

Because the role is per engine session, the check does not need to know _which caller_ sent
an operation. That question is still open for plugins (B-16 in
[plugin-sdk ADR 010](../../../platform/extensions/docs/adr/010-raw-mutate-gate-capability-enforcement.md)).
For a template, the answer is the same for every caller in the session.

What is **not** an enforcement mechanism, and must not be treated as one:

- **Layer lock.** It blocks hit-testing only. The model's own comment says so, and a test pins
  that a locked layer still takes dispatched mutations.
- **Edit contexts** ([ADR 024](adr/024-context-sensitivity-is-a-core-concept.md)). They narrow
  the tools and panels in the UI.
- **Features** (§6.3).

### 7.8 Trust

Enforcement in the browser makes the editor _behave_. It does not make the result
_trustworthy_: whoever controls the page can drive the engine directly, or edit the bytes.
A partner who prints what end users submit validates on the server:

```
paged template check --template card.paged --filled submission.paged --json
```

The check loads both documents, diffs them, and reports every change the template policy does
not permit, plus every constraint the filled document breaks. A cleaner variant does not trust
the submitted document at all. The browser submits **field values** only (`getFieldValues()`,
§8.2), and the server applies them to its own copy of the template headlessly (§9). That is
the recommended flow for print.

### 7.9 Authoring

The template author works in the full editor with the `author` role:

- **A Template panel** lists the document's fields. Selecting a frame offers "Make field":
  choose the kind, a name (the item's IDML `Name`), a label, help text, a group, the
  constraints and any extra permissions.
- **Document defaults**: which permissions hold for items that are not fields (default: none).
- **Field outlines** on the canvas, a distinct overlay colour, so the open parts of a template
  are visible at a glance.
- **Preview as filler**: a switch that sets the session role to `filler` and the profile to
  `template-fill`, without saving or reloading. The author tries the template as the end user
  will, then switches back.
- **Preflight** reports policy problems: a field without a name, two fields with one name, an
  image field whose frame is locked for replace, a required field inside a hidden item. With
  tag-based templates, a poorly tagged file is the usual reason a template misbehaves. So
  preflight also reports tags that do not correspond to a frame, a tag on a frame inside a
  group that the field cannot reach, and two frames sharing a tag where only one was meant.
- **Parent pages.** Items on a parent (master) page are scenery for a filler: a logo or a
  running header there cannot be changed from a document page. A field on a parent page is
  reported by preflight. An author who wants it editable overrides the item onto the page.
- **Linked images.** A template's placed images are usually links. Before a template can be
  previewed or filled, each link resolves to an asset the host can serve (§8.3,
  `resolveAsset`). Unresolved links are listed, and they show as missing on the canvas rather
  than as blank frames.

### 7.10 Filling

With the `filler` role and the `template-fill` preset:

- Items without `select` are scenery: clicks pass through them, and they show no selection.
- Fields show a quiet outline and, on hover, their label. An image field shows a **Replace**
  button on the canvas. A text field enters text editing on a single click.
- The **form** lists every field in the author's order and groups, and edits the same values
  as the canvas. A change in either shows in the other, because both read the document.
- Required fields and constraint failures show in the form and gate the host's "submit"
  action (§8.3).
- Undo and redo work as everywhere else, through the engine's history.

## 8. Embedding

### 8.1 Two ways in

**The npm package** is the primary way. A package (working name `@paged-media/editor`, §12)
exports `createEditor`. The host mounts the editor into an element it owns:

```ts
import { createEditor } from "@paged-media/editor";

const editor = await createEditor(document.getElementById("design")!, {
  profile: { extends: "template-fill" },
  role: "filler",
  template: {
    bytes: await fetch("/templates/card.paged").then((r) => r.arrayBuffer()),
  },
  values: { name: "Ada Example", title: "Head of Print" },
  theme: { mode: "light", tokens: { "--paged-accent": "#0a7" } },
  locale: "de",
  actions: {
    upload: async (file) => ({ uri: await myStorage.put(file) }),
    save: async (bytes) => myApi.saveDraft(bytes),
    submit: async ({ values }) => myApi.order(values),
  },
});
```

The editor still needs `SharedArrayBuffer`, so the host page needs cross-origin isolation
(COOP and COEP headers). That is a real requirement for a partner, and it is the main reason
for the second way. There is no degraded mode (§12, decided on 2026-10-24): `createEditor` on a
page that is not isolated refuses with an `EditorError` of code `notCrossOriginIsolated` whose
message names the iframe path.

**The iframe** is the other way. The editor is served from its own origin (`embed.html`). The
host embeds it and talks to it through a postMessage bridge with the same API, asynchronously.
The editor's origin sets its own isolation headers and serves its own files. A frame is isolated
only when its host page is, so the host page still sends COOP `same-origin` and COEP
`credentialless`, which asks nothing of its other resources, and the iframe allows
`cross-origin-isolated` (`connectEditor` sets it). The bridge generalises
the one that exists for the documentation site
(`apps/editor/apps/canvas/src/playground/IframeScriptBridge.tsx`, [ADR 212](adr/212-one-automation-surface.md)):
an origin allow-list, request ids, typed replies. Today it carries one message kind, run a
script; it grows to carry the handle's methods and events.

Both ways expose one API. The npm handle is the reference, and the bridge is a generated
proxy of it.

### 8.2 The handle

```ts
interface EditorHandle {
  // document
  load(source: DocumentSource): Promise<void>; // .paged, .idml, template
  save(): Promise<Uint8Array>; // .paged bytes (client.exportPaged)
  export(opts: ExportOptions): Promise<Blob>; // PDF, PNG; same exporters as the editor

  // template
  fields(): readonly FieldInfo[]; // name, kind, label, group, constraints
  getFieldValues(): Record<string, FieldValue>;
  setFieldValues(values: Record<string, FieldValue>): Promise<FieldOutcome[]>;
  validate(): Promise<ValidationReport>; // constraints + preflight

  // configuration
  ui: RegionApi; // §5.3
  features: FeatureApi; // §6
  setRole(role: Role, overrides?: PermissionOverrides): void;
  setTheme(theme: ThemeSpec): void;
  setLocale(locale: string): void;

  // events
  on(
    event:
      | "ready"
      | "change"
      | "fieldChange"
      | "selection"
      | "validity"
      | "warning"
      | "error"
      | "idDeprecated", // an old id met in the profile or features (§12, item 2)
    listener: (e: EditorEvent) => void,
  ): () => void;

  dispose(): void;
}
```

`setFieldValues` writes through the same `mutate` door as the canvas, so the values are
undoable, permission-checked and constraint-checked. A refused value comes back as an outcome.

### 8.3 Host actions

The editor never decides where a document is stored, where an image is uploaded to, or what
"done" means. Those are **actions**, registered by the host:

| Action           | Called when                                      | Default when absent                       |
| ---------------- | ------------------------------------------------ | ----------------------------------------- |
| `save`           | the user saves; `save` command                   | download the `.paged` file (today's save) |
| `export`         | the user exports                                 | download the file                         |
| `upload`         | an image is dropped or chosen for an image field | embed the bytes (`ReplaceImageBytes`)     |
| `submit`         | the actions bar's primary button                 | none; the button is not shown             |
| `close` / `back` | the actions bar's close or back button           | none; the button is not shown             |
| `validate`       | before `submit`; host-side checks of values      | engine constraints only                   |
| `pickAsset`      | the user asks for an image from a library        | the local file picker                     |
| `resolveAsset`   | a document's linked image needs its bytes        | images embedded in the package only       |

An action is a command ([ADR 209](adr/209-command-is-the-action-primitive.md)) whose handler
the host supplies. It is therefore reachable from menus, keybindings and the palette, and it is
observed by the journal like any other command. `upload` returns a URI or bytes. The engine
only places what the host resolved, which matches the engine's "no I/O" rule
([core ADR 109](../../../engine/core/docs/adr/109-engine-does-no-io.md)).

### 8.4 Host components

A host may place its own small components in a region (`{ kind: "host", id }`, §5.3): a
price, a "need help?" link, a product selector. They are registered with a render function
and a read-only view of the editor (selection, field values, validity), and they write only
through the handle. This is a narrower door than a plugin: it adds UI, not engine behaviour.
Anything bigger is a plugin under the plugin contract.

### 8.5 Theme and language

- **Theme.** The editor's design tokens are CSS custom properties
  (`apps/editor/packages/shell/src/styles/theme.css`, [ADR 210](adr/210-design-token-bridge.md)).
  A host passes a light or dark base and overrides tokens. The tokens are the public theming
  surface, so their names become a stable contract.
- **Language.** The editor's strings are English and inline today. The whole editor and its
  bundles move to string catalogues, and a host chooses the `locale`. Field labels and help texts in a template are the author's
  strings and are stored per language in the policy.
- **Loading.** A host-customisable loading state while the engine wasm starts: a message,
  the host's logo, or nothing.

## 9. Headless and batch

The same template and the same values give the same output without a browser. The pieces
exist:

- the engine CLI `paged` (`engine/core/crates/paged-cli`): `place`, `set`, `get`,
  `query`, `script`, `export`, `render`;
- `paged-node` (`apps/cli`): `set`, `batch`, `export`, and through `paged.data`, `apply` and
  `merge` per record;
- `paged.data`'s batch generation, which reuses the engine
  ([data ADR 555](../../../modules/data/docs/adr/555-batch-reuses-the-engine.md)), and merges
  that add pages ([core ADR 128](../../../engine/core/docs/adr/128-pages-a-merge-can-make.md));
- a stateless render service, `paged engine-serve`
  ([server ADR 953](../../../apps/server/docs/adr/953-the-headless-engine-lane.md), proposed).

What the template system adds is a verb that speaks its terms:

```
paged template ingest  card.idml --resolve assets/ --out t/   # §9.1
paged template fields  card.paged                               # list fields, kinds, constraints
paged template fill    card.paged --values values.json -o out.paged
paged template check   --template card.paged --filled out.paged  # §7.8
paged export           out.paged --pdf --pdf-standard x4 -o card.pdf
```

`fill` runs with the `filler` role, so a values file that tries to change what the template
does not allow is refused headlessly as well. A batch is `fill` per record, or a `paged.data`
merge whose bindings are the template's fields.

### 9.1 Ingesting a template

A host that keeps templates in its own asset library runs one headless step when a template
arrives, so that nothing about it is discovered later in an end user's browser:

1. derive fields from the policy labels and XML tags (§7.2.1);
2. resolve linked images against the library and list the ones that fail;
3. run template preflight (§7.9);
4. render a preview and thumbnails per page;
5. store the field list beside the template, so the host can build its own form, search and
   permissions without opening the document.

`paged template ingest card.idml --resolve <dir|url> --out <dir>` is that step: it writes the
`.paged` template, a JSON field manifest, a preflight report and the previews.

### 9.2 Catalogues and product data

The same fields can be filled from product data instead of a person. A catalogue is a template
whose fields are mapped once to product attributes (name, price, image, description), plus a
list of products. Each product becomes a page or a block, and the result is one multi-page
print PDF. This is `paged.data`'s record flow
([data ADR 554](../../../modules/data/docs/adr/554-record-flow-pagination.md)) with the
template's fields as its bindings. The template system contributes the mapping UI and the
permission that a filler may change the product list but not the layout.

## 10. Mapping to existing code

| Building block                      | Where                                                                                                            | Gives today                                                                      | Missing for this concept                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `SoloProfile`, `resolveSoloProfile` | `apps/editor/apps/canvas/src/solo/profiles.ts`                                                                   | allow-list of bundle, panels, tools, menus, slots                                | runtime data, many bundles, regions, adjustments          |
| Solo filters                        | `apps/editor/apps/canvas/src/main.tsx`                                                                           | filtered `BUILT_IN_PANELS`, `BUILT_IN_TOOLS`, menus                              | a general filter driven by `EditorProfile`                |
| Profile guard                       | `apps/editor/scripts/solo-profiles-guard.mjs`                                                                    | id check of six profiles in CI                                                   | presets and host profiles at start                        |
| Shell registries                    | `apps/editor/packages/shell/src/state/registries-context.tsx`, `src/registries/*`                                | 12 registries; contributions with stable ids                                     | region lists over them; feature gates in their views      |
| Cockpit slots and modes             | `apps/editor/packages/shell/src/registries/mode.ts`, `apps/editor/apps/canvas/src/cockpit-modes.ts`              | per-mode `ModeCockpitSlots`                                                      | optional regions; header, menu bar and rails as regions   |
| Chrome storage scope                | `apps/editor/packages/shell/src/state/chrome-storage-scope.ts`                                                   | separate stored layout per solo profile                                          | scope per embedding                                       |
| `when`, `entryApplies`              | ADR 209, ADR 249                                                                                                 | per-entry applicability                                                          | feature clause                                            |
| Edit contexts                       | `apps/editor/packages/shell/src/registries/edit-context.ts`, ADR 024                                             | narrowed tools and panels in the UI                                              | nothing; a model for the filler canvas, not a guard       |
| Object lock                         | `engine/core/crates/paged-mutate/src/apply/lock.rs`, ADR 251                                                     | engine-refused geometry edits on locked items                                    | permissions beyond geometry; per role                     |
| Labels and names                    | `Spread::labels`, `item_names`, `DesignMap.labels` in `engine/core/crates/paged-model/src/lib.rs`                | round-tripped key–value data and stable item names                               | the `x-paged:template` schema                             |
| XML structure                       | `XmlTag`, `XmlElement` (D-02) in `engine/core/crates/paged-model/src/lib.rs`; `idml-import/src/xml_structure.rs` | imported tags on stories, items and ranges; source `XML/` parts copied on export | tags as field markers (§7.2.1)                            |
| Placeholders and text variables     | `PlaceholderField`, `TextVariable`, `SetFieldValue`, `InsertField`                                               | fillable runs and variables                                                      | field metadata, constraints                               |
| `paged.data` bindings and variables | `modules/data`, data ADRs 552–557                                                                                | bindings, variables view, batch                                                  | a field is a binding with a policy                        |
| Plugin capabilities                 | `platform/extensions/packages/plugin-api/src/manifest.ts`, plugin-sdk ADR 010                                    | per-plugin write scopes, enforced in the SDK host                                | nothing; orthogonal to roles                              |
| Automation bridge                   | `apps/editor/apps/canvas/src/playground/IframeScriptBridge.tsx`, ADR 212                                         | postMessage `paged:run` with an origin allow-list                                | the full handle over the bridge; production build         |
| Viewer                              | `engine/core/web/idml-viewer` (`@paged-media/viewer`)                                                            | an embeddable read-only renderer                                                 | nothing; stays the lightweight option for pure viewing    |
| CLI                                 | `engine/core/crates/paged-cli`, `apps/cli`                                                                       | headless open, set, place, export, merge                                         | the `template ingest`, `fields`, `fill` and `check` verbs |

## 11. Roadmap

Each phase ends with something an embedder can use, and each records its decisions as ADRs
as it lands (editor 274 onwards; engine and module ranges for their parts; a repository-wide
PM record where a new public package is involved).

**P0 — The runtime profile.**

- `EditorProfile` as data, with a schema.
- Every region of `PagedShell` optional, and region contents as ordered id lists.
- The six solo profiles re-expressed as presets; `?solo=` maps onto them.
- The guard covers presets.
- _Exit:_ the solo journeys pass unchanged; a `template-fill`-shaped profile with no header,
  menu bar or rails renders a document.

**P1 — Features.**

- `features.enable / disable / set / isEnabled` over surface ids, with globs and predicates,
  wired into `entryApplies` and the registry views.
- _Exit:_ a feature toggled at runtime removes a menu entry, a palette row and a keybinding
  together, and the conformance suite covers the feature API.

**P2 — Template policy and engine enforcement.**

- The `x-paged:template` schema on documents and items.
- The session role and overrides on the engine (a wire message).
- The `NotPermitted` refusal next to the lock check; engine-side constraints.
- _Exit:_ an operation suite per permission proves that a `filler` session refuses what the
  policy denies, from the canvas, a script and a plugin alike. The policy survives `.paged`
  save and load, IDML export and import, and an InDesign round trip (corpus lane).

**P3 — Filling.**

- The `form` region; field outlines and the canvas Replace button; scenery pass-through.
- The `template-fill`, `form` and `viewer` presets.
- _Exit:_ a journey fills a business card through the canvas and through the form and
  exports a PDF; denied edits are not offered.

**P4 — Embedding.**

- The package and `createEditor`; the handle; host actions; host components.
- Theme tokens as a contract; a string table and locales.
- The iframe bridge as a generated proxy of the handle.
- _Exit:_ an example host page embeds the editor both ways, with a custom upload and a
  submit action.

**P5 — Authoring and headless.**

- The Template panel, preview as filler, template preflight.
- `paged template fields | fill | check`; batch fill through `paged.data`.
- Template ingest (§9.1) and the catalogue mapping (§9.2).
- _Exit:_ a template made in InDesign with tagged frames becomes a template in paged, is
  filled in the browser, and is checked and rendered on a server.

P0 and P2 are independent and can run in parallel. P3 needs both.

## 12. Non-goals and open questions

### Non-goals

- A second build, entry point or document model per shape.
- A backend in the editor. Storage, identity and uploads stay with the host.
- Features as a security mechanism.
- A visual "editor builder". A host composes with data; a builder tool can come later and
  produce the same data.
- Multi-user collaboration on one template. It is a separate concept; roles here are per
  session.

### Decided

Taken on 2026-10-21, with the implementation plan
([`composable-editor-plan.md`](composable-editor-plan.md), §14):

- **The package** is public, `@paged-media/editor`, recorded as an amendment of
  [PM-0008](../../../docs/adr/PM-0008-npm-packages-and-release.md). It bundles the editor's
  private packages and depends on `@paged-media/paged` for the engine.
- **Localisation** covers the whole editor and its bundles: one string catalogue per
  package, and plugin contribution titles that may be message keys.
- **Tags authored in paged** are written: making a field also tags the item, and the IDML
  exporter writes the XML structure from the model.
- **Tagged text ranges** become placeholder runs when a file is opened as a template.
- **Only the `author` role writes the template policy**; a host may allow it for an editor
  session.
- **Engine decision records** get a new number range, so they no longer collide with the
  editor's.

### Decided on 2026-10-24 (the former open questions)

1. **Cross-origin isolation.** No degraded in-page mode. A host that cannot send COOP and COEP
   embeds through the iframe (`connectEditor`); `createEditor` on a page that is not
   cross-origin isolated refuses with a message that names the iframe path. Built: an
   `EditorError` with the code `notCrossOriginIsolated`, also from `connectEditor` when the frame
   is not isolated ([PM-0013](../../../docs/adr/PM-0013-editor-package.md), amendment 2).
2. **Stable ids.** The package's `feature-ids.json` is the public list of command, panel and
   tool ids. An id leaves it only after a deprecation window, with an alias that keeps an old
   profile or feature set working, and the change is in the release notes. Built:
   `deprecated-ids.json`, aliases in profile resolution and `handle.features`, the `idDeprecated`
   event, and the guard in `feature-ids.mjs` (PM-0013, amendment 2).
3. **Touch and small screens.** The `template-fill` and `form` presets are made usable on phones
   and tablets: touch-sized targets, pinch zoom, a form-first layout below a breakpoint, and
   image upload from the camera. The full and focused editors stay desktop editors.
4. **Document-bound roles.** No. Roles stay per session and the host decides them; the full
   editor shows a template as a template and offers "Edit template" explicitly. Built: the
   template notice ([ADR 293](adr/293-a-template-opened-as-a-document-says-so.md)).
5. **Permission granularity in text.** A placeholder run is the range mechanism: a field limited
   to part of a story is a placeholder run (from XML tags or Make field on a selection). No
   second mechanism.
6. **Field values with style.** The author lists the character styles a text field allows (for
   example Bold and Italic) and whether it takes line and paragraph breaks. The form offers
   exactly those; the value is written as runs in the allowed styles, and nothing else is
   accepted.
7. **Choice fields over frames.** Authors can group variant frames (alternates) under one
   choice field; the filler picks one and the others are hidden. Alternates round-trip as
   hidden items in IDML.
8. **Licensing for embedders.** It follows the repository's licence terms and is outside the
   scope of this paper.
