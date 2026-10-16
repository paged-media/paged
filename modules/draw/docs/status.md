# Status

What `paged.draw` ships and what it does not, read from the code on `main` at
`@paged-media/draw` 0.1.0-canary.20 (published; manifest version 0.5.0). The bundle declares
`@paged-media/plugin-api` and `@paged-media/plugin-sdk` `>=0.2.55-canary.0` as peers; its
tests run against `@paged-media/canvas-wasm` 0.71.8. Every shipped item is registered by
`activate(host)`. How the parts fit is in [`architecture.md`](architecture.md); what each
canary added is under [Releases](#releases).

## Shipped

- **Anchor editing.** Add, Delete and Convert anchor tools on polygons, rectangles, text
  frames and graphic lines. A double-click on one of these enters the `vectorGraphic` edit
  context; on a host with the binding-provider door, the host's Layers panel then lists the
  entered object and its siblings.
- **Drawing tools.** Curvature and Pencil insert a path. Paintbrush sweeps a calligraphic
  outline, Blob Brush unites the sweep with a selected element of the same fill, Eraser
  subtracts one from the selected paths. Width outlines an open path at a varying width.
- **The graphic default.** A path drawn with Curvature or Pencil wears the document's
  `[Normal Graphics Frame]` object style (fill, stroke colour and stroke weight), or
  InDesign's own values for it (no fill, a 1 pt `Color/Black` stroke) when the document has
  no such style. The paint is written in the insert's batch, so drawing stays one undo step.
  When the document has creation defaults of its own, the engine applies them and the tools
  add nothing (`handlers/graphic-default.ts`). The brushes paint their own sweep.
- **Other tools.** Gradient Annotator (with on-canvas gradient stops), Measure, Shape
  Builder, Corner Radius (on rotated and transformed shapes too), Eyedropper, Lasso Select
  (by intersection, or by centre), Live Paint Bucket and Live Paint Selection, Type on a
  Path, Repeat, Knife, and Scissors at any point on a path.
- **Tool options.** Pencil, Paintbrush, Blob Brush, Eraser, Width and Lasso Select publish
  their settings to the host's tool-options popover.
- **Snapping.** Curvature asks the engine through `host.document.snapPoint` where the host
  supports it (engine protocol 67 and later): the point snaps against every visible
  element's anchors, centres and outlines, the page, ruler guides and the grid, with the
  session's tolerance, as the host's own tools do. On an older engine the plugin-side
  snapper is the fallback: the page's edges, centre lines and corners and the tool's own
  placed anchors, within 6 screen px. Cmd turns snapping off on both paths. The fallback's
  geometry, `snapPoint` in `draw-geometry`, is exported.
- **Stroke and fill.** Weight, colour, cap, dashes, arrowheads, corner radii, fill colour,
  tint, gradient angle and length are core frame properties, edited in the host's Stroke,
  Object Options and Gradients panels; the bundle contributes no Stroke or Fill panel of its
  own (the modules stay exported). Dash patterns (four presets) and linear or radial
  gradients are commands.
- **Draw settings.** A schema panel of the object model's property rows (below), rendered
  by the host as property fields. The `vectorGraphic` edit context raises it. The nine
  feature panels (Appearance, Graphic styles, Symbols, Live paint, Pattern, Repeat, Blend,
  Objects on path, Path options) open with one sentence on what they are for, keep their
  longer note in a collapsed "About" section, show an action's refusal in the panel, and
  ask for a second click before deleting a graphic style or a symbol.
- **Path commands.** Outline stroke, Offset (with miter, round or bevel joins and a miter
  limit), Simplify, Join, Close, Average endpoints, Reverse path direction;
  Pathfinder Unite, Subtract, Intersect, Exclude, Divide, Trim, Merge, Crop, Outline and
  Minus back; Make and Release compound path; five corner presets for rectangles, polygons
  and text frames; Select same fill, stroke or stroke weight (with a tolerance); Insert arc,
  spiral, rectangular grid and polar grid; Reflect (horizontal, vertical, a typed axis, and
  a copy) and Transform again; a dash editor. Parameters are typed in a Path Options panel,
  which the menu's "…" entries open. Reflect writes a group's transform in the frame of the
  group holding it, so a group nested in a rotated or scaled parent mirrors about the axis
  asked for, on an engine that keeps a nested group's transform relative to its parent and
  reports a group's geometry (canvas-wasm 0.71.11). On an engine that reports no geometry
  for a group, the write is the reflection composed with the stored transform, which is
  what that engine needs.
- **Appearance.** Several fills and strokes on one object, edited in a panel; Bake lowers
  the stack to a group of single-paint items and Release restores it.
- **Graphic styles and symbols.** A named appearance that objects stay linked to; a named
  artwork definition with placed instances. Both have a panel, and their libraries are
  stored in the `.paged` file.
- **Live paint, pattern, repeat, blend, objects on a path.** Each keeps a stored recipe and
  has a panel plus commands to make, update and release it. The first four insert artwork;
  objects on a path moves the selected objects and creates none.
- **Opacity mask and type on a path.** Make and release a mask from the top selected object;
  attach an existing story to a path and detach it.
- **Create outlines.** Type ▸ Create outlines turns a text frame's glyphs into compound
  paths, one per fill colour, grouped when there are several, in one undo step.
- **Image trace.** One command turns a placed raster image into grouped, filled paths. It
  runs in a host worker where the host offers one, and on the calling thread otherwise.
- **SVG.** An importer for `.svg` files and an exporter for the selection.
- **Menu.** 80 commands have menu entries on a host that offers the menu door.
- **The link index.** The ten features that tag elements with this bundle's metadata
  (graphic styles, symbols, live paint, pattern, repeat, blend, objects on a path, opacity
  masks, type on a path, the appearance bake) find them through one shared index per
  document revision (`src/link-index.ts`). A new revision starts with every committed change
  the host reports through `document.onDidChange`, a canvas gesture's commit and a script run
  included, and with every document opened (`document.onDidOpen`). Nothing is read off the
  raw engine client.
  Reporting gesture commits and script runs needs plugin-api / plugin-sdk 0.2.55, the
  bundle's peer minimum.

## Object model

`activate(host)` contributes ten object kinds through `host.contribute.objectModel`, so a data
binding, a script, the command-line tool and a schema-driven panel field reach draw's objects
through `host.objects` (code: `packages/draw-bundle/src/object-model/`). Addresses are
`plugin:media.paged.draw/<kind>/<id>`. The contract is the object model of plugin-sdk
[`DESIGN.md`](https://github.com/paged-media/plugin-sdk/blob/main/DESIGN.md) §21 (§21.8 the
first consumers' fix-ups, §12.7 the panel property row). It is on `main` and published since
`@paged-media/draw` 0.1.0-canary.16.

| Kind | Rows | Backing | One write = |
|---|---|---|---|
| `path` | 10 (points, one point `points[]` and its anchor and two handles, contour starts, open flags, counts, transform) | core `framePath` | 1 undo step |
| `appearance` | 5 (fills, strokes, graphic style, overridden, baked) | element envelope + bake | 1 undo step |
| `graphicStyle` | 10 (name, fills, strokes, 6 base paints, linked count) | library, document label | 1 undo step, followers re-applied |
| `symbol` | 6 | library, document label | 1 undo step (delete unlinks instances) |
| `symbolInstance` | 4 | per-leaf links | 1 undo step |
| `pattern` | 11 | recipe, document label | 1 undo step |
| `repeat` | 20 | recipe, document label | 1 undo step |
| `blend` | 15 | recipe, document label | 1 undo step |
| `livePaint` | 4 | recipe, document label | 1 undo step |
| `objectsOnPath` | 11 | recipe, document label | 1 undo step |

- **Undoable library and recipe writes.** An object-model write stores the library in a
  content-addressed part and names its hash in the document label `x-paged:media.paged.draw`,
  in the same commit as any page change. Undo reverts the label and the library reads back as
  it was (`src/recipe-store.ts`). The parts are a cache: a library small enough also rides
  inline in the label, which InDesign keeps when it drops the parts.
- **One write per batch.** The contribution has a plugin-level `batch`
  (`src/object-model/plan.ts`): every draw op of a batch is planned together, so several
  libraries in one batch become ONE `state` write hosted on `doc` under the sub-key
  `x-paged:media.paged.draw.recipes`, which the registry merges into the document label and
  whose parts it writes. A one-element appearance write is a `state` write under the sub-key
  `…appearance` on that element (the envelope's other keys stay); stacks on several elements,
  or next to a library write, are full-envelope `setPluginMetadata` mutations the registry
  checks. Every draw object answers `hostOf`, so `page:#1 > plugin:media.paged.draw/path` and
  `doc > plugin:media.paged.draw/repeat` select.
- **Typed commands.** 97 of the 107 commands have a typed twin with the same id; the ten
  Path Options "…" commands, which only raise a panel, are the untyped remainder.
- **A recipe write changes the recipe, not the artwork.** The artwork follows on the typed
  update command (`updateRepeat`, `updateBlend`, `editPatternField`, `regenerateLivePaint`,
  `updateObjectsOnPath`): two undo steps, because an update mints new ids.
- **Two libraries in one batch are refused**: they share the one document label.

### Illustrator variables

| Variable | Where it maps |
|---|---|
| Text | core `story:<id>` `content` (or a story range) |
| Linked file | core image placement (`placeImage`); not yet a `host.objects` path |
| Visibility | core `elementVisible` on the page item |
| Graph data | not built — paged.draw has no chart engine (see below) |

**Graph data is a gap.** paged.draw draws no charts and will not grow a chart engine.
paged.sheet has one (plotters into a frozen geometry IR drawn as native vector). Reuse goes
through `host.objects`: paged.sheet's object model contributes a `chart` kind with a `series`
row, so a graph-data variable is a data binding onto the sheet chart's series, and the chart
stays paged.sheet's object. Nothing in paged.draw is needed for that.

### Panel fields for the shared PropertyField

The host renders each property row as a `PropertyField`; the Draw settings panel is a schema
panel of these rows. The fields:

- Stroke and fill (core rows, edited in the host's Stroke, Object Options and Gradients
  panels): `frameStrokeWeight`, `frameStrokeColor`, `frameStrokeEndCap`,
  `frameStrokeStartArrowhead`, `frameStrokeEndArrowhead`, the four `frameCornerRadius*`,
  `frameFillColor`, `frameFillTint`, `frameGradientFillAngle`, `frameGradientFillLength`.
- Repeat, Blend, Pattern and Objects on Path options: every numeric, toggle and select field
  is a parameter row of its kind (`repeat.count`, `blend.spacing`, `pattern.overlap`, …).
- Appearance and graphic styles: the stack rows `fills` / `strokes` are list rows (items listed
  top-first, add / remove / reorder, one undo step per edit).
- Path: `points` is a list row of anchor / left / right items, `subpathStarts` a number list.
  The per-point item rows (`points[]`, `points[].anchor|left|right`) have no row of their own
  (a panel row's path is static); the panel reaches them as the points row's items
  (`DRAW_PANEL_ITEM_ROWS`, a documented exception).
- Pattern `tile` / `spacing` (points), `overlap` (struct fields), repeat `spacing` / `clipRect`,
  objects-on-path `order` (number list): rows of the properties panel, like every other
  writable row of every kind (`DRAW_PANEL_FIELDS`; a spec holds it to the manifest).
- Graphic styles, symbols: `name` per row; the linked count and overridden flag are derived
  rows. Live paint: `name`; faces are read-only (painted through the command).
- Path Options: its sections are the args of the path-op and insert-shape typed commands, a
  command form rather than property fields.

## Limits of what is shipped

- **No construct updates itself.** Editing a source does not change a pattern, repeat,
  blend, symbol instance or live-paint fill; a command rebuilds it. Recipe and library
  writes made by a COMMAND are not undoable (a make or update records the ids its own batch
  minted, so the recipe can only be written after it); writes through the object model are
  (below). Both need a host with `storage.parts@1`.
- **Undo steps.** Almost every command is one batch and one undo step, however many items
  it creates or rebuilds (pattern, symbols, live paint, blend, repeat, compound path, brush
  strokes, SVG import). Two take two: appearance bake and image trace, because their
  records name the created items by id. A clipped repeat takes two as well.
- **Appearance.** An unbaked stack shows only its front fill and front stroke. Bake refuses
  a source with more than one contour.
- **Pattern** produces copies of the artwork, not a fill: at most 400, and no text frames.
  **Repeat** and **blend** stop at 200 instances or steps; a blend needs two paths with the
  same contour and anchor counts.
- **Symbols.** An instance is re-created geometry with flat paint: no text, gradient stops,
  image content or per-instance override. Redefine and reset give its items new ids.
- **Live paint** has no gap handling and cannot stroke edges. The engine refuses more than
  12 inputs or 256 faces. A fill is inserted above the paths that bound it.
- **Region tools** work in raw path space: results are exact only when the inputs share one
  item transform. An element moved far enough off its page cannot be measured.
- **Shape Builder.** A drag merges the faces it crosses into one path and an Alt-drag deletes
  them; every other face of a shape the gesture touched stays, as a piece in the paint of the
  shape on top of it there (an input keeps one piece in place, further pieces are new paths
  carrying fill, stroke colour and stroke weight only, at the top of the page and outside any
  group, as the Knife's are). The engine reads an oval as its bounding
  box, so over a selection with an oval no face is highlighted while hovering; the faces are
  resolved at release against the oval's real curve, and the oval is replaced by its pieces.
- **Pages away from their spread's origin** (a verso, every page of an InDesign document).
  On an engine that reads geometry in spread space, tools that map the pointer through an
  item's transform or insert artwork from its geometry land off by the page's origin there;
  core's page-space geometry corrects that. Transforms and re-tabled paths are written in
  spread space on either engine. Objects on a Path keeps objects on the page only on an
  engine that reports the page's origin. A symbol PLACED on such a page puts a piece with
  holes off by the page's origin, because nothing the placement reads reports it; reset and
  redefine read it from the instance. Create Outlines reads it from the text frame, so on an
  engine that reports no origin its glyphs with holes land off by it there.
- **Tools.** Width replaces the path with its outline. Eyedropper samples properties, not
  pixels. Measure's snap and the gradient annotator's stops use raw engine requests outside
  the host doors. Only Curvature snaps among this bundle's own tools.
- **Opacity mask and type on a path.** Options cannot be edited in place; release or detach
  and apply again. A masking object cannot be selected. No story is created: the text must
  already exist and be unflowed.
- **Image trace** is one-shot and fills only; images are downsampled to 1,048,576 pixels by default. It fits the result to
  the frame's bounds, so a cropped or offset image does not line up. It reads only what the
  browser can decode.
- **SVG** carries paths, basic shapes, group transforms and solid colours. Gradients, text,
  images, `<use>` and `<defs>`, clip paths, masks and stylesheets are not read. Export
  writes solid colours only.

## Not built

- A Pen tool, Direct Selection, Group and Ungroup, Delete, Nudge, clipping masks and a
  Layers panel: these are the host's
  ([ADR 352](adr/352-basic-operations-belong-to-the-host.md)). The host's Pen and Direct
  Selection drive `PenMachine` and `DirectSelectMachine` from `packages/draw-tools`.
- A content type or rendering of its own ([ADR 351](adr/351-shapes-are-native-page-items.md)).
- A pattern as a paint (a swatch), and a clipping mask over a group of items. Nesting into
  a container is used only for a repeat's clipping.
- Symbol sets and their tools, nine-slice scaling, per-instance override records (an
  instance's deviations are its items' own properties); merging,
  importing, exporting and organising graphic styles.
- Trace presets, re-tracing and centreline detection.
- Resampling two blend paths that do not match; readers for `.ai` and `.eps` files.

## Releases

What each published canary of `@paged-media/draw` added since 0.1.0-canary.13. A merge that
leaves the version unchanged publishes nothing.

| Version | Published | Added |
|---|---|---|
| 0.1.0-canary.20 | 2026-10-14 | Curvature and Pencil paint their path with the graphic default; Reflect writes a nested group's transform in its parent's frame; the link index follows `document.onDidChange` and `document.onDidOpen` and reads nothing off the raw client. Peers `>=0.2.55-canary.0`. Carries the engine 0.71.8 test pins, which change no runtime code. |
| 0.1.0-canary.19 | 2026-10-13 | Shape Builder keeps the faces a gesture does not cross and merges an oval by its curve; transforms and re-tabled paths are written in spread space on either engine; Create Outlines re-merges glyph runs on their page. |
| 0.1.0-canary.18 | 2026-10-11 | Messages a user sees (panel refusals, status bindings, panel and export notes) say what happens in plain words instead of naming internal gap ids. |
| 0.1.0-canary.17 | 2026-10-11 | The panel pass: one-sentence intros, "About" sections, own icons, a second click to delete a style or symbol, refusals shown in the panel. The Stroke and Fill panels are no longer contributed; the host's panels carry their rows. |
| 0.1.0-canary.16 | 2026-10-11 | The object model (ten kinds, 97 typed command twins) and a schema panel of its property rows (named Draw settings since canary.17); engine protocol 71 (canvas-wasm 0.71.1). Peers `>=0.2.45-canary.0`. |
| 0.1.0-canary.15 | 2026-10-05 | Curvature snaps through the engine (`document.snapPoint`, protocol 67), the plugin-side snapper as the fallback. |
| 0.1.0-canary.14 | 2026-10-05 | The published type declarations inline `draw-geometry` and `draw-tools`. |
