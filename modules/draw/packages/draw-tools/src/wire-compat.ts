/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Compile-time proof that the machines' output feeds the engine wire
// types directly — the reason `@paged-media/plugin-api` is a real
// (type-only) dependency of this package. If a protocol change breaks
// structural compatibility, `pnpm typecheck` fails HERE, in the
// plugin repo, hours after the change — the §12.3 "loud during
// dogfooding" property.

import type {
  Mutation,
  MutationInput,
  PathAnchorSpec,
  PathAnchorTriple,
  PathPointRole as WirePathPointRole,
} from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";
import type {
  ClosePathWire,
  InsertPathWire,
  JoinPathsWire,
  PathEditBatchWire,
  PathPointCurveTypeWire,
  PathPointInsertWire,
  PathPointRemoveWire,
  PathPointRole,
  PathPointSetWire,
} from "./path-edit-ops";
import type { RegionFace } from "./shape-builder-machine";

type Extends<A, B> = A extends B ? true : false;
type Assert<T extends true> = T;

/** `AnchorTriple` assigns directly to `PathAnchorSpec` (insertPath,
 *  pathPointInsert anchors). */
export type AnchorTripleFeedsWire = Assert<Extends<AnchorTriple, PathAnchorSpec>>;

/** B-22 — a planar FACE's anchors, as the `requestPlanarRegions` read
 *  door reports them (`PathAnchorTriple`), install into the Shape
 *  Builder machine's `RegionFace` verbatim. The face's OWN wire type
 *  (`PlanarFaceWire`, protocol v57) is not in the vendored contract
 *  yet, so this asserts the part that IS: the anchor triple. */
export type PlanarFaceAnchorsFeedMachine = Assert<
  Extends<{ id: string; anchors: PathAnchorTriple[] }, RegionFace>
>;

// ---- PATH EDITING (Direct Selection + Pen v2) --------------------------
//
// Every op shape the two machines' plans lower to, asserted against the
// EXACT variant of the vendored `Mutation` union it names — not against
// the union as a whole. `X extends Mutation` would still hold if a
// shape happened to satisfy some OTHER variant; `Extract<…>` pins the
// one whose `op` it carries, and collapses to `never` (failing the
// assertion) the day that variant is renamed or removed.

type WireOp<K extends Mutation["op"]> = Extract<Mutation, { op: K }>;

/** `pathPointSet` — one control point (an anchor, which drags its
 *  handles, or one handle). The Direct Selection plan's only op besides
 *  remove; the Pen writes a picked-up endpoint's new handle with it. */
export type PathPointSetFeedsWire = Assert<
  Extends<PathPointSetWire, WireOp<"pathPointSet">>
>;

/** `pathPointInsert` — the Pen's continue / extend / join appends, with
 *  the post-insert contour starts when the contour is not the last. */
export type PathPointInsertFeedsWire = Assert<
  Extends<PathPointInsertWire, WireOp<"pathPointInsert">>
>;

/** `pathPointRemove` — Direct Selection's Delete, the Pen's
 *  delete-anchor click. */
export type PathPointRemoveFeedsWire = Assert<
  Extends<PathPointRemoveWire, WireOp<"pathPointRemove">>
>;

/** `pathPointCurveType` — an `AnchorEditPlan` convert through the shared
 *  lowering (`anchorEditOps`). */
export type PathPointCurveTypeFeedsWire = Assert<
  Extends<PathPointCurveTypeWire, WireOp<"pathPointCurveType">>
>;

/** `closePath` — the Pen closing a continued path onto its own other
 *  endpoint. */
export type ClosePathFeedsWire = Assert<
  Extends<ClosePathWire, WireOp<"closePath">>
>;

/** `joinPaths` — the Pen ending on another open path's endpoint. */
export type JoinPathsFeedsWire = Assert<
  Extends<JoinPathsWire, WireOp<"joinPaths">>
>;

/** `insertPath` — the Pen's new-path commit (`penPlanMutation`). */
export type InsertPathFeedsWire = Assert<
  Extends<InsertPathWire, WireOp<"insertPath">>
>;

/** The batch itself — the ONE mutation a plan lowers to — is a settled
 *  `batch` (its children are all `Mutation`s, so it needs no
 *  protocol-ahead cast) and is what `host.document.mutate` accepts. */
export type PathEditBatchFeedsWire = Assert<
  Extends<PathEditBatchWire, WireOp<"batch">> extends true
    ? Extends<PathEditBatchWire, MutationInput>
    : false
>;

/** The role vocabulary is the wire's, in BOTH directions: a role the
 *  engine adds must show up here, and one it drops must fail here. */
export type PathPointRoleIsWire = Assert<
  Extends<PathPointRole, WirePathPointRole> extends true
    ? Extends<WirePathPointRole, PathPointRole>
    : false
>;
