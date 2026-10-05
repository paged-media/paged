# Status

What `paged.draw` ships and what it does not, read from the code at the engine pin
`@paged-media/canvas-wasm` 0.65.0 (`@paged-media/draw` 0.1.0-canary.12, manifest version
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
  tint, gradient angle and length. Dash patterns (four presets) and linear or radial
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
- **Image trace.** One command turns a placed raster image into grouped, filled paths. It
  runs in a host worker where the host offers one, and on the calling thread otherwise.
- **SVG.** An importer for `.svg` files and an exporter for the selection.
- **Menu.** 72 commands have menu entries on a host that offers the menu door.

## Limits of what is shipped

- **No construct updates itself.** Editing a source does not change a pattern, repeat,
  blend, symbol instance or live-paint fill; a command rebuilds it. Recipe and library
  writes are not undoable, and they need a host with `storage.parts@1`.
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
- Symbol sets and their tools, nine-slice scaling, per-instance overrides; merging,
  importing, exporting and organising graphic styles.
- Trace presets, re-tracing and centreline detection.
- Resampling two blend paths that do not match; readers for `.ai` and `.eps` files.
- Create outlines (text to paths) needs engine protocol 66, which is not yet published.
