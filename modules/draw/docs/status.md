# Status

What `paged.draw` ships and what it does not, read from the code on `main`, 2026-10-24, at
`@paged-media/draw` 0.1.0-canary.20 (a private workspace package; manifest version 0.5.0). The
bundle takes `@paged-media/plugin-api` and `@paged-media/plugin-sdk` from the workspace as peers;
its tests run against the in-tree `@paged-media/canvas-wasm` (`0.<protocol>.0-dev`, built by
`moon run core:wasm-pkg`). Every shipped item is registered by
`activate(host)`. How the parts fit is in [`architecture.md`](architecture.md); what each
canary added is under [Releases](#releases).

## Shipped

- **Anchor editing.** Add, Delete and Convert anchor tools on polygons, rectangles, text
  frames and graphic lines. A double-click on one of these enters the `vectorGraphic` edit
  context; on a host with the binding-provider door, the host's Layers panel then lists the
  entered object and its siblings.
- **Drawing tools.** Curvature inserts a path. (The Pencil is the host's `paged.tool.pencil`,
  a shim over this repo's `PencilMachine`, ADR 359.) Paintbrush sweeps a calligraphic
  outline, Blob Brush unites the sweep with a selected element of the same fill, Eraser
  subtracts one from the selected paths. Width outlines an open path at a varying width; the
  `widthProfile` command does the same with the widths given as data (below).
- **The graphic default.** A path drawn with Curvature wears the document's
  `[Normal Graphics Frame]` object style (fill, stroke colour and stroke weight), or
  InDesign's own values for it (no fill, a 1 pt `Color/Black` stroke) when the document has
  no such style. The paint is written in the insert's batch, so drawing stays one undo step.
  When the document has creation defaults of its own, the engine applies them and the tools
  add nothing (`handlers/graphic-default.ts`). The brushes paint their own sweep.
- **Other tools.** Gradient Annotator (with on-canvas gradient stops), Measure, Shape
  Builder, Corner Radius (on rotated and transformed shapes too), Eyedropper, Lasso Select
  (by intersection, or by centre), Live Paint Bucket and Live Paint Selection, Type on a
  Path, Repeat, Knife, and Scissors at any point on a path.
- **WP6.1 tools (keyless, in the host's flyouts).** In the Transform flyout: **Reflect**
  (a click sets the axis point, a drag turns the axis with a live preview and reflects the
  selection, Alt at release reflects a copy, Shift snaps to 45°; Alt+click opens the Path
  Options Reflect section about that point) and **Reshape** (press on a path, on an anchor or
  on a segment, where an anchor is added, and drag: the contour follows with a cosine falloff
  along the path, the radius a tool option). In the Pencil flyout: **Shaper** (a freehand
  line, rectangle, ellipse, triangle or regular polygon is recognised and drawn clean; a
  scribble over overlapping shapes merges the regions it crosses, or punches out the one
  region it stays inside, through the Shape Builder's commit), **Path Eraser** (removes the
  part of a stroke the drag covers; a closed path opens, the far pieces become separate
  paths painted like it, a path erased whole is deleted) and **Join** (a scrub over the gap
  between two open ends joins them with a straight segment, over one path's two ends closes
  it, over the overhangs of two crossing paths trims both at the crossing and joins them
  there). In the Shape flyout: **Star** (Radius 1 to the pointer, Radius 2 by a ratio, Arrow
  Up and Down change the points during the drag, a click opens the Star section at that
  centre) and **Flare** (two drags: size, then the rings' end; centre, halo, rays and rings
  as one group). Each is one undo step. The pure halves are draw-geometry (`simplify-fit`,
  `path-locate`, `path-erase`, `reshape`, `star`, `shaper`) and draw-tools (`ScrubMachine`,
  `ReflectMachine`, `ReshapeMachine`, `StarMachine`, `FlareMachine`).
- **Tool options.** Paintbrush, Blob Brush, Eraser, Width, Lasso Select, Reshape (falloff
  radius) and Star (points, Radius 2 as a percentage) publish their settings to the host's
  tool-options popover.
- **Snapping.** Curvature asks the engine through `host.document.snapPoint`: the point
  snaps against every visible element's anchors, centres and outlines, the page, ruler
  guides and the grid, with the session's tolerance. It uses the snapper the host's Pen
  uses (`createSnapper` in `draw-tools`), so both tools snap alike. Cmd turns snapping off.
  An engine that does not answer leaves the point unsnapped; there is no TypeScript
  fallback resolver (ADR 358). `snapPoint` in `draw-geometry` stays for the editor's
  Direct Selection, which snaps a dragged anchor locally before the engine answers.
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
  and text frames; Select same fill, stroke, stroke weight (with a tolerance), opacity,
  blending mode, appearance, graphic style, symbol instance or shape kind, and Global Edit
  (select every object of the same shape, optionally at any size); Insert arc,
  spiral, rectangular grid, polar grid, star and flare; Reflect (horizontal, vertical, a typed axis, and
  a copy) and Transform again; a dash editor; a width profile (start, middle and end widths)
  that replaces each selected open path with its outline. Parameters are typed in a Path
  Options panel, which the menu's "…" entries open. Reflect writes a group's transform in the frame of the
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
  objects on a path moves the selected objects and creates none. Since WP6.6 a blend takes
  keys with different anchor or contour counts (the intermediates get a matched structure,
  the keys keep theirs), two groups (member to member by order; the groups stay groups) and
  gradient fills (stop for stop, each intermediate its own gradient).
- **Opacity mask and type on a path.** Make and release a mask from the top selected object;
  attach an existing story to a path and detach it.
- **Create outlines.** Type ▸ Create outlines turns a text frame's glyphs into compound
  paths, one per fill colour, grouped when there are several, in one undo step.
- **Image trace.** One command turns a placed raster image into grouped paths. It
  runs in a host worker where the host offers one, and on the calling thread otherwise.
  The paths land where the image is displayed: the trace follows the image's own placement
  in its frame, and only the part the frame shows is traced. Since WP6.6: Illustrator's
  twelve **presets** (Default, High and Low Fidelity Photo, 3 / 6 / 16 Colors, Shades of
  Gray, Black and White Logo, Sketched Art, Silhouettes, Line Art, Technical Drawing) map onto
  the kernel's options, and the colour counts snap the raster to that many colours first (a
  deterministic k-means in `crates/draw-trace`); **centreline** tracing (Line Art, Technical
  Drawing) thins the ink to its skeleton (Zhang–Suen) and lowers it to OPEN stroked paths at
  the ink's mean width; **Re-trace** traces again with new options and replaces the previous
  result in one undo step (the record keeps the options, every region names its image);
  a trace made **live** is traced again inside the edit that changes its image's link or
  bytes, over the recipe auto-update's step amend. An Image Trace panel holds the preset, the
  options, Live, Trace and Re-trace; Draw ▸ Image trace… raises it.
- **Recolor Artwork and the Color Guide (WP6.5).** Edit ▸ Edit colors ▸ Recolor artwork…
  raises a panel that reads the selection's colours (fills, strokes, gradient stops and
  appearance layers, heaviest first, at their display colours) and recolours them by a
  harmony rule (complementary, analogous, triad, split complementary, tetrad,
  monochromatic, shades, tints) on an HSB wheel whose handles turn the whole harmony, by
  reduction to N colours (Lab k-means, deterministic, onto existing colours), or onto the
  nearest swatches of a colour group. Apply is one batch: new swatches (a spot colour's
  replacement is a spot), new gradients where stops change, the selection's refs
  re-pointed; an object's tint is kept, so a tint of a spot stays a tint. The Color Guide
  panel shows the fill's harmony and its shades / tints, warm / cool and vivid / muted
  variations; a click fills the selection (Alt-click strokes). The colour math is
  draw-geometry's `color-harmony.ts`.
- **SVG.** An importer for `.svg` files and an exporter for the selection.
- **Simplify with a live preview.** While the Path Options Simplify section is open, the
  simplified selection is drawn dashed over the canvas with its anchor counts, following
  every edit and selection change. A corner angle (0–180°) keeps anchors at least that sharp
  as corners; with one set, Simplify writes exactly the previewed fit (`framePath`), with
  none it is the engine's `simplifyPath` as before and the preview is the same fit, which can
  keep a slightly different number of anchors (the panel says so). A simplify never adds
  anchors.
- **Menu.** 94 menu entries on a host that offers the menu door.
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
[`DESIGN.md`](https://github.com/paged-media/paged/blob/main/platform/extensions/DESIGN.md) §21 (§21.8 the
first consumers' fix-ups, §12.7 the panel property row). It is on `main` and published since
`@paged-media/draw` 0.1.0-canary.16.

| Kind             | Rows                                                                                                            | Backing                 | One write =                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `path`           | 10 (points, one point `points[]` and its anchor and two handles, contour starts, open flags, counts, transform) | core `framePath`        | 1 undo step                            |
| `appearance`     | 5 (fills, strokes, graphic style, overridden, baked)                                                            | element envelope + bake | 1 undo step                            |
| `graphicStyle`   | 10 (name, fills, strokes, 6 base paints, linked count)                                                          | library, document label | 1 undo step, followers re-applied      |
| `symbol`         | 6                                                                                                               | library, document label | 1 undo step (delete unlinks instances) |
| `symbolInstance` | 4                                                                                                               | per-leaf links          | 1 undo step                            |
| `pattern`        | 11                                                                                                              | recipe, document label  | 1 undo step                            |
| `repeat`         | 20                                                                                                              | recipe, document label  | 1 undo step                            |
| `blend`          | 15                                                                                                              | recipe, document label  | 1 undo step                            |
| `livePaint`      | 4                                                                                                               | recipe, document label  | 1 undo step                            |
| `objectsOnPath`  | 11                                                                                                              | recipe, document label  | 1 undo step                            |

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
- **Typed commands.** 117 of the 127 commands have a typed twin with the same id; ten
  Path Options "…" commands, which only raise a panel, are the untyped remainder. The
  Knife, Scissors and Shape Builder, tools before, are commands too, their gesture given as
  data: `knife { page, cut }`, `scissorsAt { point, tolerance }` and
  `shapeBuild { path, mode }` act on their `targets` as the tool would, in one undo step,
  and so are the WP6.1 tools: `joinScrub { page, path, tolerance }`,
  `pathErase { page, path, width }`, `reshapeAt { point, to, radius, tolerance }`,
  `shaperStroke { page, path }`, `insertStar` and `insertFlare` (every parameter);
  `simplifyPath` takes `cornerAngle` and the Reflect commands a page-space `pivot`,
  and a cut that does nothing fails with its reason (`commands/cut-commands.ts`). A
  scripted Shape Builder refuses ovals (the tool reads them through stand-ins).
- **Width profile.** `widthProfile { targets, widths }` is the Width tool's bake with the
  profile as data: `widths` are full stroke widths at evenly spaced stops along the path by
  arc length (one width is uniform, `[0, 8, 0]` swells in the middle and tapers to points).
  Each selected single-contour open path is replaced by its outline in one batch, one undo
  step; closed and compound paths are skipped, and a call that outlines nothing fails with
  the reason (`commands/width-profile.ts`). In the editor the Path Options panel's Width
  profile section types a three-stop profile; the command run bare (the Draw ▸ Stroke ▸ Width
  profile… row) raises that section.
- **Updating the recipes a source feeds.** `updateLinkedRecipes { targets, all }` runs, for
  every recipe whose sources are among the targets (or, with `all`, every recipe in the
  document), the update its own panel runs (`updateRepeat`, `updateBlend`,
  `editPatternField`, `updateObjectsOnPath`, `regenerateLivePaint`), and answers the
  addresses of the recipes it rebuilt. A source is what the make linked as one: a repeat's or
  a pattern's source items, a blend's keys and spine, the objects and the path of an
  objects-on-path, a live-paint group's inputs. A script or `paged-node invoke` that edits a
  path calls it afterwards with that path (`commands/recipe-update.ts`; the menu row is Draw ▸
  Update linked recipes).
- **Recipes follow their sources.** An edit that changes a source of a pattern, repeat,
  blend, objects-on-path or live-paint recipe (a mutation, a panel field, a drag of its
  handles) rebuilds that recipe as part of the edit's undo step: one undo restores the source
  and the old artwork, one redo replays both, and an undo or redo never starts a rebuild. The
  rebuild sends its mutations with `mutate(…, { amend })` (engine ADR 1004, extensions ADR
  337), so it neither clears the redo stack nor adds a step. Which recipes: the update keeps a
  fingerprint of each recipe's sources (path anchors and properties) and rebuilds those whose
  fingerprint moved; it runs once per commit, never per pointer move. When the edit is no
  longer the last step by the time the rebuild writes, the engine refuses it and the log says
  to run Update linked recipes. It needs `supports("document.mutate.amend@1")`; it is on by
  default. The checkbox "Update automatically when a source changes" at the top of the
  Pattern, Repeat, Blend, Objects on path and Live paint panels turns it off and on (the
  bundle's storage key `recipes.autoUpdate`, `setRecipeAutoUpdate`; one per-user setting, so
  every panel shows the same value; hidden on a host that cannot amend). A script's edits are
  followed too: a run is one undo step and its reply names it (`document.mutate.amend@2`,
  engine ADR 1004 amendment), so the rebuild joins the script's step; a rebuild that loses the
  race to the script's next write is retried on the script's reply, and a run that called
  `paged.undo()` is only fingerprinted. The recipe record a rebuild writes is a container
  part, outside the step, as every command-lane recipe write is
  (`commands/recipe-auto-update.ts`).
- **A recipe parameter write rebuilds the artwork in the same undo step.** The write commits
  the parameters (the document label), and its follow-up (`ObjectWrite.followUp`, extensions
  ADR 337 amendment) runs the recipe's update with every mutation amending that step: one undo
  restores the old parameters and the old artwork. A name write rebuilds nothing. With the
  automatic update off, or on a host that cannot amend, the write changes the recipe only and
  the artwork follows on the typed update command (`updateRepeat`, `updateBlend`,
  `editPatternField`, `regenerateLivePaint`, `updateObjectsOnPath`) as a step of its own.
- **Two libraries in one batch are refused**: they share the one document label.

### Template fields

A template can open four parts of a drawing to a filler (extensions ADR 335; code:
`packages/draw-bundle/src/object-model/template-fields.ts`). A field is the
`x-paged:template` label of one page item; the engine grants the filler that item's
`select`, `document.metadata` and the kind's grants, and checks every write.

| Kind                            | Definition                       | Value     | Grants                                                       |
| ------------------------------- | -------------------------------- | --------- | ------------------------------------------------------------ |
| `media.paged.draw.paint`        | `{ channel, allowed?, target? }` | swatch id | `appearance.fill`, `appearance.stroke`                       |
| `media.paged.draw.graphicStyle` | `{ allowed?, targets? }`         | style id  | `appearance.fill`, `appearance.stroke`, `appearance.opacity` |
| `media.paged.draw.textOnPath`   | `{ path? }`                      | text      | `text.edit`                                                  |
| `media.paged.draw.symbolChoice` | `{ allowed? }`                   | symbol id | `item.resize`, `appearance.fill`, `appearance.stroke`        |

- `allowed` lists ids or names; without it every swatch, style or symbol is a choice. A
  value outside the list is refused with one sentence.
- **paint** writes the frame's fill or stroke, or, when the item has an appearance stack,
  its top layer (the layer that bakes to the frame).
- **symbolChoice** re-shapes the instance leaf in place (path, paint and link, one batch),
  so the element and its field label survive. Only one-piece symbols can be chosen: a
  rebuild would mint new elements, which a filler may not, and drop the field's label.
- **textOnPath** reads and writes the story on the path. A story on a path has no text frame;
  the engine decides it by the item that carries the path, so the field's `text.edit` reaches
  it (engine ADR 1000, amendment of 2026-10-23).

### Illustrator variables

| Variable    | Where it maps                                                      |
| ----------- | ------------------------------------------------------------------ |
| Text        | core `story:<id>` `content` (or a story range)                     |
| Linked file | core image placement (`placeImage`); not yet a `host.objects` path |
| Visibility  | core `elementVisible` on the page item                             |
| Graph data  | not built — paged.draw has no chart engine (see below)             |

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

- **The WP6.1 tools.** Simplify's preview is exact only with a corner angle; without one
  the engine simplifies and no engine door answers its result before writing. Join welds
  through the engine's `joinPaths`, which joins the two paths' own coordinates, so paths
  with different transforms are refused by name, only open single-contour paths take part,
  and a gap is closed with a straight segment (no extension along the paths' tangents). The
  Path Eraser skips compound paths and erases a fixed 10 px band. Reshape's falloff is
  measured along the anchor polygon. Star, Flare and the Shaper's shapes are plain paths, not
  live shapes (that is WP6.2); a flare is artwork, not a re-editable flare object, painted
  white (`Color/Paper`) with opacity and a radial gradient feather on the halo, in Normal
  blending and without Illustrator's tints. The Shaper's scribble acts on polygons and
  rectangles (ovals take part only through the Shape Builder tool). A click with Star or
  Flare, and an Alt+click with Reflect, open their Path Options section; on a host that
  cannot raise a panel they insert or reflect with the last-used values instead.
- **What updates itself.** Editing a source rebuilds the patterns, repeats, blends,
  objects on a path and live-paint fills it feeds, in the edit's undo step (above). Symbol
  instances do not follow a changed definition until Redefine or Reset. A script's edits are
  followed unless the run called `paged.undo()` / `paged.redo()` or an edit split it (run
  `updateLinkedRecipes` then). Recipe and library
  writes made by a COMMAND are not undoable (a make or update records the ids its own batch
  minted, so the recipe can only be written after it); writes through the object model are
  (below). Both need a host with `storage.parts@1`.
- **Undo steps.** Almost every command is one batch and one undo step, however many items
  it creates or rebuilds (pattern, symbols, live paint, blend, repeat, compound path, brush
  strokes, SVG import, image trace and re-trace, recolour). A clipped repeat takes two.
- **Appearance.** An unbaked stack shows only its front fill and front stroke. Bake refuses
  a source with more than one contour.
- **Pattern** produces copies of the artwork, not a fill: at most 400, and no text frames.
  **Repeat** and **blend** stop at 200 instances or steps. A blend refuses an open key
  against a closed one, groups of different sizes, a linear gradient against a radial one,
  and stops in different places when a midpoint other than 50 % would have to be resampled.
- **Symbols.** An instance is re-created geometry with flat paint: no text, gradient stops,
  image content or per-instance override. Redefine and reset give its items new ids.
- **Live paint** has no gap handling and cannot stroke edges (WP6.6 leaves both to the
  engine's arrangement work, WP2.4). The engine refuses more than
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
- **Tools.** Width (and `widthProfile`) replaces the path with its outline; the profile is not
  kept as an editable stroke. Eyedropper samples properties, not
  pixels. Measure's snap and the gradient annotator's stops use raw engine requests outside
  the host doors. Only Curvature snaps among this bundle's own tools.
- **Opacity mask and type on a path.** Options cannot be edited in place; release or detach
  and apply again. A masking object cannot be selected. No story is created: the text must
  already exist and be unflowed.
- **Global Edit** selects the matching objects; it is not Illustrator's editing mode. An
  edit that applies to a selection (paint, opacity, a transform) reaches all of them, but a
  point edit on one path does not propagate. A rotated or mirrored copy does not match.
  Select same compares colours by swatch, so two swatches holding the same colour differ.
- **Image trace** is one-shot and fills only; images are downsampled to 1,048,576 pixels by default. A placement the
  engine resolves at render time from a named fit or fitting crops, with no inner transform
  in the document, is not reported to plugins, so that image is fitted to the frame's bounds
  and may not line up. A rotated or skewed placement, or an oval or polygon frame, is cropped
  to the box around what is visible, so traced paths can extend past a non-rectangular clip.
  It reads only what the browser can decode.
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
- A variable-width centreline (a traced stroke has the ink's mean width); a Color Guide
  "save group"; Recolor Artwork's per-row colour editing in the panel (the `map` payload
  does it).
- Readers for `.ai` and `.eps` files.

## Releases

What each published canary of `@paged-media/draw` added since 0.1.0-canary.13. A merge that
leaves the version unchanged publishes nothing.

| Version         | Published  | Added                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0-canary.20 | 2026-10-14 | Curvature and Pencil paint their path with the graphic default; Reflect writes a nested group's transform in its parent's frame; the link index follows `document.onDidChange` and `document.onDidOpen` and reads nothing off the raw client. Peers `>=0.2.55-canary.0`. Carries the engine 0.71.8 test pins, which change no runtime code. |
| 0.1.0-canary.19 | 2026-10-13 | Shape Builder keeps the faces a gesture does not cross and merges an oval by its curve; transforms and re-tabled paths are written in spread space on either engine; Create Outlines re-merges glyph runs on their page.                                                                                                                    |
| 0.1.0-canary.18 | 2026-10-11 | Messages a user sees (panel refusals, status bindings, panel and export notes) say what happens in plain words instead of naming internal gap ids.                                                                                                                                                                                          |
| 0.1.0-canary.17 | 2026-10-11 | The panel pass: one-sentence intros, "About" sections, own icons, a second click to delete a style or symbol, refusals shown in the panel. The Stroke and Fill panels are no longer contributed; the host's panels carry their rows.                                                                                                        |
| 0.1.0-canary.16 | 2026-10-11 | The object model (ten kinds, 97 typed command twins) and a schema panel of its property rows (named Draw settings since canary.17); engine protocol 71 (canvas-wasm 0.71.1). Peers `>=0.2.45-canary.0`.                                                                                                                                     |
| 0.1.0-canary.15 | 2026-10-05 | Curvature snaps through the engine (`document.snapPoint`, protocol 67), the plugin-side snapper as the fallback.                                                                                                                                                                                                                            |
| 0.1.0-canary.14 | 2026-10-05 | The published type declarations inline `draw-geometry` and `draw-tools`.                                                                                                                                                                                                                                                                    |
