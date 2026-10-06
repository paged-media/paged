# Status

What `paged.draw` ships and what it does not, read from the code at the engine pin
`@paged-media/canvas-wasm` 0.66.0 (`@paged-media/draw` 0.1.0-canary.13, manifest version
0.5.0). Every shipped item is
registered by `activate(host)`. How the parts fit is in [`architecture.md`](architecture.md).

## Shipped

- **Anchor editing.** Add, Delete and Convert anchor tools on polygons, rectangles, text
  frames and graphic lines. A double-click on one of these enters the `vectorGraphic` edit
  context; on a host with the binding-provider door, the host's Layers panel then lists the
  entered object and its siblings.
- **Drawing tools.** Curvature and Pencil insert a path. Paintbrush sweeps a calligraphic
  outline, Blob Brush unites the sweep with a selected element of the same fill, Eraser
  subtracts one from the selected paths. Width outlines an open path at a varying width.
- **Other tools.** Gradient Annotator (with on-canvas gradient stops), Measure, Shape
  Builder, Corner Radius (on rotated and transformed shapes too), Eyedropper, Lasso Select
  (by intersection, or by centre), Live Paint Bucket and Live Paint Selection, Type on a
  Path, Repeat, Knife, and Scissors at any point on a path.
- **Tool options.** Pencil, Paintbrush, Blob Brush, Eraser, Width and Lasso Select publish
  their settings to the host's tool-options popover.
- **Snapping.** Curvature snaps to the page's edges, centre lines and corners and to its own
  placed anchors (6 screen px; Cmd turns it off). The geometry, `snapPoint` in
  `draw-geometry`, is exported for a host's own Pen and Direct Selection.
- **Stroke and Fill panels.** Weight, colour, cap, arrowheads and corner radii; fill colour,
  tint, gradient angle and length. Cap and arrowheads apply to paths drawn with the Pen too,
  and a path's gradient angle and length read back. Dash patterns (four presets) and linear or radial
  gradients are commands.
- **Path commands.** Outline stroke, Offset (with miter, round or bevel joins and a miter
  limit), Simplify, Join, Close, Average endpoints, Reverse path direction;
  Pathfinder Unite, Subtract, Intersect, Exclude, Divide, Trim, Merge, Crop, Outline and
  Minus back; Make and Release compound path; five corner presets for rectangles, polygons
  and text frames; Select same fill, stroke or stroke weight (with a tolerance); Insert arc,
  spiral, rectangular grid and polar grid; Reflect (horizontal, vertical, a typed axis, and
  a copy) and Transform again; a dash editor. Parameters are typed in a Path Options panel,
  which the menu's "…" entries open.
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
- **Menu.** 73 commands have menu entries on a host that offers the menu door.

## Object model (ADR 323)

`activate(host)` contributes ten object kinds through `host.contribute.objectModel`, so a data
binding, a script, the command-line tool and a schema-driven panel field reach draw's objects
through `host.objects` (code: `packages/draw-bundle/src/object-model/`). Addresses are
`plugin:media.paged.draw/<kind>/<id>`.

| Kind | Rows | Backing | One write = |
|---|---|---|---|
| `path` | 6 (points, contour starts, open flags, counts, transform) | core `framePath` | 1 undo step |
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
through `host.objects`: once paged.sheet contributes its chart kinds (series, options), a
graph-data variable is a data binding onto the sheet chart's series path, and the chart stays
paged.sheet's object. Nothing in paged.draw is needed for that.

### Panel fields for the shared PropertyField

The editor builds `PropertyField`; these are the fields that map onto a row today:

- Stroke panel (core rows): `frameStrokeWeight`, `frameStrokeColor`, `frameStrokeEndCap`,
  `frameStrokeStartArrowhead`, `frameStrokeEndArrowhead`, the four `frameCornerRadius*`.
- Fill panel (core rows): `frameFillColor`, `frameFillTint`, `frameGradientFillAngle`,
  `frameGradientFillLength`.
- Repeat, Blend, Pattern and Objects on Path options: every numeric, toggle and select field
  is a parameter row of its kind (`repeat.count`, `blend.spacing`, `pattern.overlap`, …).
- Appearance: the stack rows `appearance.fills` / `appearance.strokes` need a LIST field.
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
