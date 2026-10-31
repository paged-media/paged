# ADR 363 — The distortion tools rewrite paths; their maths is pure warp geometry; the grid is a view setting

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/draw-geometry/src/warp/` (`liquify`, `triangulate`, `arap`,
  `homography`, `perspective-grid`), `packages/draw-tools/src/liquify-machine.ts`,
  `puppet-warp-machine.ts`, `perspective-machine.ts`, and in `packages/draw-bundle/src`
  `commands/{distort-shared,liquify,puppet-warp,perspective}.ts` and
  `handlers/{liquify,puppet-warp,perspective,preview-shapes}.ts`. Work package WP6.7 of the
  image/draw plan (gaps D-38, D-39, D-40).

## Context

Illustrator's distortion tools — the seven Liquify tools, Puppet Warp, the Perspective Grid and
Perspective Selection — were missing. The plan puts their shared maths in a future engine crate,
`paged-warp` (homographies, ARAP meshes, liquify displacement, the perspective grid), with one
API that maps points for vectors and samples backward for pixels, and the shared-capabilities
work (C8) moves draw-geometry out of this module. Neither exists yet, and none of these tools
needs an engine construct: every one of them ends in new path geometry.

## Decision

- **Every distortion is a path rewrite, one batch per gesture.** A liquify drag, a pin drag, a
  pin removal, an attach, a move along a plane and a shape drawn on a plane each write
  `framePath` + `frameBounds` (and, on the perspective verbs, the element's link) for every
  path it changed in ONE batch — one undo step. The kernels run in PAGE space; each path is
  mapped through its transform and back (an affine map is exact on Béziers).
- **The maths is pure warp geometry in draw-geometry, shaped for `paged-warp`.** Point maps over
  `[x, y]` tuples and anchor tables, no host types, no randomness (the detail kernels hash a
  stable anchor id and a seed), no globals; `warp/index.ts` documents the API module by module.
  It reuses draw-geometry's own contour ranges, polygon test, segment distance, polyline length,
  de Casteljau split, Simplify fit and SVG shape tables rather than new copies, so the C8 move
  and the Rust port carry one implementation each.
- **Liquify densifies, displaces, then re-fits only what it touched.** Segments under the brush
  are halved (exactly) to Detail's spacing; Warp/Twirl/Pucker/Bloat move every control point
  through their field, Scallop/Crystallize/Wrinkle move the anchor and/or its handles ("brush
  affects") along the path's outward normal; on release each run of touched anchors is
  re-fitted at the Simplify tolerance and every untouched anchor is kept byte-identical.
- **Puppet Warp is Igarashi et al. 2005 on a constrained Delaunay mesh.** The selection's
  outline is resampled, filled with a staggered lattice, triangulated (Bowyer–Watson on
  jittered predicates, Sloan edge-flip constraint recovery, even-odd interior), and solved in
  the paper's two linear steps, factored once per pin set. Every anchor and handle is located
  in the rest mesh once and follows its triangle. A pin carries an optional angle (its lever
  neighbour is pinned too); a mesh component without two constraints is held at rest.
- **The perspective grid is per page, in a container part, off the undo stack.** It is a view
  setting, like Illustrator's: `perspective-grid.json` (the eighth part) through the recipe
  store's command lane, drawn in a retained overlay layer while visible. Each plane is a
  homography built from the grid's vanishing points (an axis to a finite vanishing point
  foreshortens projectively, one plane point is one page point at the origin).
- **Artwork on a plane keeps its FLAT geometry.** The element's draw envelope carries
  `perspective { plane, page, flat }`; moving along the plane re-projects the flat geometry,
  so repeated moves never compound projection error; Release drops the link. Curves are
  subdivided until the projective error is under 0.1 pt (Illustrator maps an ellipse's four
  control points instead — recorded as a convention).
- **Tool keys are not taken.** Every new tool is keyless (the registers are full); the
  Liquify tools have their own flyout, Puppet Warp joins the host's Free Transform flyout,
  Object ▸ Puppet warp switches to it through the editor's command registry read
  structurally (no contract door activates a tool), and says so where that is absent.

## Consequences

- Illustrator is the oracle for the grid: `scripts/illustrator/probes/perspective-grid.jsx`
  records shapes drawn on each plane of its default grid, and the replay proves each plane is
  one homography with the two-point structure our construction spans. The Liquify tools and
  Puppet Warp have no scriptable Illustrator equivalent; their kernels are pinned by unit specs.
- Grid edits do not undo and, with no container writer, last for the session only.
- When `paged-warp` lands, `src/warp/` is its specification: the specs in
  `packages/draw-geometry/test/warp/` are the cross-implementation fixtures.
