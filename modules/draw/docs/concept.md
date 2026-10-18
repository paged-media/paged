# paged.draw Capability Specification

June 2026. Concept paper. Sections describe intent; where the implementation differs, `status.md` and the ADRs in `adr/` are authoritative.

Sections not relevant outside the original planning context have been removed; numbering is unchanged.

---

## 13. What a Modern Vector Illustration Application Must Do

*Status note (2026-10-02): this section predates the implementation; the tiers and the v1/v2 labels record the original plan, not what ships (see `status.md`). Per-element plugin state is stored in one metadata envelope under the key `x-paged:media.paged.draw`, not under the `x-paged-draw:*` keys named below ([ADR 354](adr/354-multi-paint-bakes-to-a-group.md), with the general rule in [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md)); document-level libraries are stored in container parts ([ADR 355](adr/355-libraries-in-container-parts.md)). Capabilities that the host provides instead of this plugin are recorded in [ADR 352](adr/352-basic-operations-belong-to-the-host.md).*

This section specifies the full capability surface expected of a professional vector illustration tool in 2026. Each capability is assigned an implementation tier:

- **Tier A — IDML-native (paged.draw v1).** Representable directly as IDML constructs; lossless InDesign round-trip.
- **Tier B — Extension layer (paged.draw v2).** Requires `x-paged-draw:*` metadata + baked IDML fallback.
- **Tier C — Host responsibility.** Belongs to the Paged core / other plugins, not paged.draw (e.g., typography engine, document management).
- **Tier D — Out of scope / not planned.** Documented for completeness, deliberately excluded.

### 13.1 Drawing & Path Creation

*Status note (2026-10-02): this section predates the implementation; see [ADR 352](adr/352-basic-operations-belong-to-the-host.md) (the Pen that authors new paths is a host tool; this plugin contributes the anchor-editing companions) and `status.md` (the Blob Brush, listed below as Tier B, is built).*

| Capability | Tier | Notes |
|---|---|---|
| Pen tool (Bézier) | **A** | Core v1 tool. Full modifier parity (Alt = convert/break handle, Shift = constrain 45°). |
| Curvature tool | **A** | Significantly lowers the entry barrier; high priority alongside classic pen. |
| Freehand drawing | **A** | Input smoothing (1€ filter or similar) + Ramer–Douglas–Peucker simplification on commit. |
| Path smoothing | **A** | Simplify as Operation with live preview Gesture. |
| Path erasing/cutting | **A** | Scissors v1; knife can follow. |
| Blob brush | **B** | Output is plain paths (A), but the live merge behavior warrants v2. |
| Shape recognition | **B** | Candidate for later; pairs with stylus/touch support. |
| Perspective drawing | **D** | Niche; perspective-correct artwork can be imported. Revisit on demand. |

### 13.2 Geometric Primitives ("Live Shapes")

*Status note (2026-10-02): this section predates the implementation; see `status.md`. Corner editing, listed below as Tier B, is built on the engine's native corner properties, with a marker in the plugin's metadata envelope (`packages/draw-bundle/src/commands/live-corners.ts`).*

| Capability | Tier | Notes |
|---|---|---|
| Rectangle / Rounded rectangle | **A** | IDML stores baked path; live parameters in `x-paged-draw:shape` → **A for geometry, B for liveness**. v1 ships live shapes with metadata from the start — the baked path is always valid IDML. |
| Ellipse, incl. pie/arc | **A/B** | Same pattern: baked path A, live parameters B-metadata. |
| Polygon, Star | **A/B** | Same pattern. |
| Line, Arc, Spiral, Grids | **A** | Spiral/grids generate plain paths; no liveness needed in v1. |
| Corner editing | **B** | Requires corner metadata + baked geometry. |

### 13.3 Path Editing

*Status note (2026-10-02): this section predates the implementation; see [ADR 353](adr/353-path-algebra-runs-in-the-engine.md) (offset, outline stroke, simplify and join are engine operations invoked by this plugin's commands).*

| Capability | Tier | Notes |
|---|---|---|
| Direct selection | **A** | Core v1. Includes segment dragging (reshapes adjacent curves). |
| Anchor management | **A** | |
| Handle editing | **A** | |
| Join & average | **A** | |
| Offset path | **A** | Computed via Rust geometry (kurbo); commit as Operation. |
| Outline stroke | **A** | Already in v1 scope; also the bake path for variable-width strokes. |
| Reshape & warp-drag | Reshape **B**, Puppet Warp **D** | Puppet Warp is raster-era mesh tech; low priority for a DTP-adjacent tool. |
| Path direction & winding | **A** | IDML/PDF semantics require this anyway. |

### 13.4 Boolean & Combinatorial Geometry

*Status note (2026-10-02): this section predates the implementation; see [ADR 353](adr/353-path-algebra-runs-in-the-engine.md) (boolean and region operations run in the engine), [ADR 124](https://github.com/paged-media/core/blob/main/docs/adr/124-opacity-masks-native.md) (opacity masks, listed below as provisionally Tier B, are a native engine construct), and `status.md` (Shape Builder, listed below as Tier B, is built).*

| Capability | Tier | Notes |
|---|---|---|
| Pathfinder operations | **A** | Applied (destructive) booleans in v1. Full Pathfinder matrix is table stakes. |
| Shape Builder | **B** | The modern interaction model for booleans; pure Gesture/Operation showcase. High-priority v2. |
| Compound paths | **A** | Native IDML concept. |
| Compound shapes (live booleans) | **B** | Live stack in `x-paged-draw:bool`; baked result in IDML. |
| Clipping masks | **A** | IDML-representable; doubles as the InDesign "paste inside" semantic. |
| Opacity masks | **B** | PDF supports it; IDML mapping needs verification — provisionally B. |

### 13.5 Fills, Strokes & Appearance

*Status note (2026-10-02): this section predates the implementation; see [ADR 354](adr/354-multi-paint-bakes-to-a-group.md) (multiple fills and strokes, as built), [ADR 355](adr/355-libraries-in-container-parts.md) (the graphic-style library), [ADR 356](adr/356-live-constructs-are-recipes.md) (patterns and blends are stored recipes plus artwork that can be regenerated; a pattern is a tile field, not a fill), and `status.md` (variable-width strokes are baked on release, with no live profile).*

| Capability | Tier | Notes |
|---|---|---|
| Solid fills | **A** | |
| Linear/radial gradients | **A** | IDML gradients map directly. On-canvas annotator is a v1 overlay-layer showcase. |
| Gradient on stroke | **B** | Bakes to outlined geometry. |
| Freeform gradients | **B** | Vello-friendly (mesh rendering); bakes to a rasterized or heavily subdivided fallback — fidelity policy needed. |
| Gradient mesh | **D→B** | Freeform gradients cover most modern use. Revisit. |
| Stroke model | **A** | Complete stroke panel in v1. IDML carries all of it. |
| Variable-width strokes | **B** | Live profile in metadata; baked outline in IDML. Major expressive feature — early v2. |
| Brushes | **B** (Calligraphic, Art, Pattern), **D** (Scatter, Bristle) | Brushes are stored definitions applied to paths; baking = expand appearance. Bristle is raster-painterly — out. |
| Pattern fills | **B** | IDML/InDesign has no native pattern-fill equivalent — bake to clipped tile group. |
| Multiple fills/strokes | **B** | The Appearance model is Illustrator's deepest concept; metadata stack + baked group. |
| Opacity & blend modes | **A** | IDML transparency model covers this. |
| Graphic styles | **B** | Depends on Appearance model. |
| Live effects | **B** (vector effects), **D** (raster effects) | Effect stack in metadata, baked geometry in IDML. Raster effects (gaussian blur as pixels, etc.) conflict with the resolution-independent model — defer indefinitely. |
| Envelope distort | **B** | Bakes to distorted paths. |
| Blends | **B** | Generates intermediate paths; bake = expand. |

### 13.6 Color Management

| Capability | Tier | Notes |
|---|---|---|
| Swatches | **A** | Maps directly to IDML `Colors`/`Swatches` — and must share the host document's swatch list (one source of truth across DTP and draw contexts). |
| Spot colors / Pantone | **A** | IDML-native; print heritage demands it. |
| Color models | **A** | Host-level color management (profiles, rendering intents) is **C** — paged.draw consumes it. |
| Color picker & harmony tools | **A** (picker), **B** (harmony guide) | |
| Recolor artwork | **B** | Extremely high-value for production work; pure algorithmic feature over the swatch graph. |

### 13.7 Typography in Drawings

| Capability | Tier | Notes |
|---|---|---|
| Point/area type, type on path | **C** | **Paged's own text engine is the typography authority.** paged.draw embeds host text objects rather than re-implementing type. One text model across document and drawing. |
| Convert text to outlines | **A** | paged.draw operation consuming host glyph outlines (read-broad capability showcase). |
| Touch Type (per-glyph transform) | **C/B** | Host text feature with draw-context affordances; decide jointly with core text roadmap. |

### 13.8 Organization & Structure

*Status note (2026-10-02): this section predates the implementation; see [ADR 352](adr/352-basic-operations-belong-to-the-host.md) (grouping and the Layers panel belong to the host; this plugin supplies the values the host's panel shows, per [ADR 023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md)), and [ADR 355](adr/355-libraries-in-container-parts.md) with [ADR 356](adr/356-live-constructs-are-recipes.md) (symbols and repeats, listed below as Tier B, are built: definitions and recipes in container parts, instances as artwork that can be regenerated).*

| Capability | Tier | Notes |
|---|---|---|
| Layers & sublayers | **A** | v1 layers panel scoped to edit context; maps to IDML layer + group structure. |
| Groups & isolation mode | **A** | Isolation mode = nested edit context — we get it from the platform for free. |
| Symbols / components | **B** | Definition in metadata + each instance baked as group. Foundation for asset reuse. |
| Global editing | **B** | Convenience layer over symbols/selection. |
| Repeat objects | **B** | Generative + parametric, bakes cleanly. High demo value. |
| Artboards | **C** | Pages are Paged's artboards. Inside an edit context, the drawing bounds are the frame. |
| Asset libraries | **C** | Platform-level concern (future paged.assets), not paged.draw. |

### 13.9 Precision, Transformation & Productivity

| Capability | Tier | Notes |
|---|---|---|
| Transform suite | **A** | |
| Align & distribute | **A** | |
| Smart guides & snapping | **A** | Built on the host hit-testing/snapping service; table stakes for 2026. |
| Rulers, guides, grids | **A** | Shared with host where the context allows. |
| Measurement | **A** | |
| Keyboard-first operation | **A** | Expression-capable numeric fields are already in the panel schema. |
| Select-same | **A** | |
| History | **C** | Single shared Operations history. |

### 13.10 Raster Integration

*Status note (2026-10-02): this section predates the implementation; see [ADR 357](adr/357-image-trace-rust-lane.md) (Image Trace, listed below as Tier B, is built as a one-shot trace over the `visioncortex` crate compiled to WASM).*

| Capability | Tier | Notes |
|---|---|---|
| Place/link images | **A** | IDML image frames; host asset pipeline. |
| Image trace | **B** | Algorithmic, sandbox-friendly (potrace-class in Rust/WASM). Strong differentiator for a web tool. |
| Rasterize | **C** | Host/export concern. |
| Crop image | **A** | Frame-based cropping is native DTP behavior. |

### 13.11 Import / Export & Interchange

*Status note (2026-10-02): this section predates the implementation; see [ADR 351](adr/351-shapes-are-native-page-items.md) (SVG import lowers each shape to a native path; SVG export serialises the selection).*

| Capability | Tier | Notes |
|---|---|---|
| SVG import | **A** | v1: bake to IDML constructs on import; document unsupported SVG features (filters, animations) explicitly. |
| SVG export | **A** | Emit minimal, semantic SVG. |
| Clipboard interchange | **A** | `clipboard: "vector"` capability. |
| PDF/EPS/AI import | **B/D** | PDF-page-to-paths import is plausible (B); native `.ai` parsing is a rabbit hole (D — `.ai` is PDF-with-private-data; support the PDF stream subset only). |
| Export for screens / asset export | **C** | Host export pipeline; paged.draw contributes exportable nodes. |

### 13.12 Web-Era Expectations

*Status note (2026-10-02): this section predates the implementation; see `status.md` (pen pressure, listed below as Tier B, drives the stroke width of the Pencil and the Paintbrush).*

These define "modern" in 2026:

| Capability | Tier | Notes |
|---|---|---|
| Zero-install, instant open | **A** | Inherent to Paged. |
| Real-time collaboration | **C** | Platform roadmap item; the Operations channel is designed for it. paged.draw must simply not break it. |
| Performance at scale | **A/C** | Vello/WebGPU is our structural answer; incremental document saves are a host concern. |
| Stylus & touch | **B** | Pointer Events expose pressure/tilt; feeds variable-width strokes. |
| Version history | **C** | Host concern; Operations log enables semantic diffing later. |
| Accessibility | **A** | Declarative panels give panel accessibility for free; canvas a11y is a research item. |
| AI-assisted creation | **D for v1/v2** | Deliberately excluded from this paper's scope. Our position: nail the deterministic tool first; AI assistance is a separate, later concept. |
| Open format honesty | **A** | Everything paged.draw makes is IDML (or clearly-marked metadata + baked IDML). Format honesty is a positioning pillar. |

### 13.13 Deliberate Exclusions (Tier D summary)

For clarity, capabilities we consciously do not pursue: perspective grid drawing, bristle/scatter brushes, gradient mesh (superseded by freeform gradients), Photoshop-style raster effects, puppet warp, native `.ai` file parsing beyond its PDF stream, 3D extrude/revolve/materials, and all generative-AI features (separate future concept). Each exclusion is revisitable; none blocks the architecture.

---

## 14. paged.draw Release Slices

*Status note (2026-10-02): this section predates the implementation, and the slices do not describe what ships; see `status.md`. From the first slice, the Pen that authors new paths, grouping and the Layers panel are provided by the host ([ADR 352](adr/352-basic-operations-belong-to-the-host.md)). From the second and third slices, Shape Builder, live corners, variable-width strokes, a calligraphic paintbrush, the Appearance model with graphic styles, pattern fields, blends, symbols, repeats, image trace, stylus pressure, opacity masks and the blob brush are built ([ADR 354](adr/354-multi-paint-bakes-to-a-group.md), [ADR 356](adr/356-live-constructs-are-recipes.md), [ADR 357](adr/357-image-trace-rust-lane.md)); art and pattern brushes, vector live effects, envelope distort, recolor artwork, freeform gradients, shaper, global editing, the color harmony guide and PDF import are not part of this plugin.*

The tiers translate into shippable slices:

**v1 — "Honest Bézier" (Tier A core):**
Pen + Curvature + Pencil tools, full anchor/handle editing, scissors, join/average, simplify, live shape primitives, complete stroke/fill model (solid + linear/radial gradients with on-canvas annotator), full Pathfinder set (applied), compound paths, clipping masks, swatches incl. spot colors, layers panel, align/distribute/transform suite, smart guides & snapping, select-same, outline stroke, text-to-outlines, offset path, SVG import/export, vector clipboard, place/crop images. *Everything lossless IDML.*

**v2 — "Expressive Layer" (Tier B, first wave):**
Shape Builder, live corners, variable-width strokes, calligraphic/art/pattern brushes, pattern fills, Appearance model (multiple fills/strokes) + graphic styles, vector live effects + envelope distort, blends, symbols, repeat (radial/grid/mirror), recolor artwork, freeform gradients, image trace, stylus pressure. *Each feature ships with its baked-IDML fallback and visible-boundary UX.*

**v3 — candidates by demand:**
Opacity masks, blob brush, shaper, global editing, color harmony guide, PDF import.

Every slice doubles as a plugin-API proof: v1 exercises edit contexts, overlays, hit-testing, panels, and Operations; v2 exercises the metadata/extension layer, custom-canvas widgets (width-profile and gradient editors), and the appearance pipeline.

---

## 15. Roadmap

*Status note (2026-10-02): this section predates the implementation. The plugin lives in this repository (`paged-media/plugin-draw`) and takes the plugin contract as published packages ([ADR 307](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/307-contract-as-peer-dependency.md)). The breakage log, the list of places where the public plugin API fell short, was a file in this repository until 2026-06-12 and remains in its git history. The baking that was built is recorded in [ADR 354](adr/354-multi-paint-bakes-to-a-group.md) and [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md).*

| Phase | Milestone | Exit criterion |
|---|---|---|
| **P3** | **paged.draw v1** ("Honest Bézier") built in `paged-media/draw` against published packages only | Clean-checkout build passes; breakage log drained; §13 Tier-A matrix green |
| **P6** | paged.draw v2 ("Expressive Layer") + extension-layer/baking infrastructure | First Tier-B features ship with verified InDesign round-trip of baked output |

---

## 16. Open Questions

*Status note (2026-10-02): this section predates the implementation. Question 7 is answered by [ADR 124](https://github.com/paged-media/core/blob/main/docs/adr/124-opacity-masks-native.md) (opacity masks are a native engine construct, and this plugin ships Make and Release commands over it). Question 8 is answered by [ADR 004](https://github.com/paged-media/core/blob/main/docs/adr/004-kurbo-geometry-kernel.md) and [ADR 353](adr/353-path-algebra-runs-in-the-engine.md) (the boolean kernel is in the engine; this plugin ships none). On question 6, the plugin stores no live shape parameters; corner editing writes the engine's native corner properties plus a marker in the plugin's metadata envelope (`packages/draw-bundle/src/commands/live-corners.ts`).*

6. **Live-shape liveness policy** — §13.2 proposes shipping live shapes in v1 with metadata + baked path. Confirm this doesn't violate the "v1 = pure Tier A" principle, or accept it as the single sanctioned exception (the metadata is trivially discardable).
7. **Opacity-mask IDML mapping** — verify what IDML/InDesign transparency can represent before classifying §13.4 opacity masks as B vs. A.
8. **Boolean geometry kernel** — robust 2D booleans in Rust: evaluate kurbo/usvg ecosystem options vs. porting a proven kernel; numerical robustness here makes or breaks §13.4.

---

## 17. Summary

This specification is an auditable matrix: every professional vector capability named, tiered against IDML fidelity, and sequenced into release slices that double as plugin-API proof points.

**Paged: where documents are built. Plugins: where Paged grows.**
