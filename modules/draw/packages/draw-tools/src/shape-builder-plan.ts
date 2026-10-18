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

// What a finished Shape Builder gesture DOES to the document — host-agnostic
// and PURE: the planar arrangement's faces (id + which inputs cover each), the
// faces the gesture crossed, the mode; out comes, per input, what becomes of
// it. The handler turns the plan into one batch.
//
// THE RULE (Illustrator's Shape Builder):
//   · a plain drag MERGES the faces it crossed into ONE path;
//   · an Alt-drag DELETES the faces it crossed;
//   · every other face of a shape the gesture touched STAYS — as its own
//     piece, painted like the shape on top of it there (Illustrator divides
//     what the gesture touched at every crossing);
//   · a shape the gesture did not touch is left exactly as it was.
//
// WHY THIS IS NOT ONE ENGINE OP. The engine's `pathfinderFaces { faces,
// mode }` keeps the named faces and builds ONE result from them — every
// other face of every input is dropped (`keep`), or every remaining face is
// united into one element (`remove`). On two bars crossing, dragging from the
// left arm into the top arm left only those two arms: the centre and the
// other two arms vanished (found filming the editor). So the faces come from
// the engine's arrangement and the result is built here, the way the Knife
// builds its pieces: an input that keeps a piece is REWRITTEN to it (it keeps
// its id, effects, metadata and slot), every further piece is INSERTED and
// painted like its owner, and the merged faces are united by the engine
// itself — `pathfinderFaces` over the carrier and the merged faces' pieces
// only, with nothing named and `remove`, which unites everything it is given.
//
// OWNERSHIP: `signature` lists the inputs covering a face, top-to-bottom
// indices into the request (index 0 is frontmost), so a face's owner — the
// shape you see there — is its smallest index. The merged path belongs to
// the topmost input covering any merged face, the engine's own rule.
//
// AN INPUT THAT CANNOT BE REWRITTEN (`canRewrite` false — an oval, which has
// no path to rewrite) keeps nothing in place: its pieces are inserted and it
// is deleted, and a merge it owns is carried by a fresh piece instead.

/** One face of the arrangement, as the plan needs it. */
export interface PlanarFaceRef {
  /** The engine's stable face id (`"<signature>#<component>"`). */
  id: string;
  /** Indices of the inputs whose interior contains the face (top-to-bottom
   *  request order, index 0 frontmost). */
  signature: readonly number[];
}

/** `keep` = a plain drag (merge what it crossed), `remove` = Alt (delete it). */
export type ShapeBuildFaceMode = "keep" | "remove";

/** What a finished gesture does, per input and per face. Indices are into
 *  the request's input list; faces are arrangement face ids. */
export interface ShapeBuildPlan {
  /** Inputs rewritten IN PLACE to one face's outline (keeping their id and
   *  appearance) — one per input that keeps at least one piece. */
  rewrites: { input: number; face: string }[];
  /** Faces inserted as new pieces, painted like input `paintFrom` (the
   *  face's owner). */
  inserts: { face: string; paintFrom: number }[];
  /** `keep` only: the crossed faces, united into one path owned by input
   *  `owner`. `carrier: "input"` — the owner itself is rewritten to
   *  `faces[0]` and the rest are united onto it; `"piece"` — the owner
   *  cannot be rewritten, so `faces[0]` is inserted (painted like the owner)
   *  and the rest are united onto that. */
  merge: { faces: string[]; owner: number; carrier: "input" | "piece" } | null;
  /** Inputs left holding nothing — deleted. */
  deletes: number[];
  /** Inputs the gesture never touched — left exactly as they are. */
  untouched: number[];
}

/** The owner of a face: the topmost input covering it. */
export function faceOwner(face: PlanarFaceRef): number {
  let owner = Number.POSITIVE_INFINITY;
  for (const i of face.signature) owner = Math.min(owner, i);
  return owner;
}

/**
 * Plan a finished Shape Builder gesture (see the module header for the rule).
 * `inputCount` inputs, `faces` the whole arrangement, `swept` the face ids the
 * gesture crossed (any order; ids the arrangement does not hold are ignored).
 * Null when the gesture crossed no face of the arrangement — nothing to do.
 * PURE.
 */
export function planShapeBuild(
  inputCount: number,
  faces: readonly PlanarFaceRef[],
  swept: readonly string[],
  mode: ShapeBuildFaceMode,
  canRewrite: (input: number) => boolean = () => true,
): ShapeBuildPlan | null {
  const sweptSet = new Set(swept);
  const crossed = faces.filter((f) => sweptSet.has(f.id) && f.signature.length > 0);
  if (crossed.length === 0) return null;

  // The inputs the gesture touched: every input covering a crossed face.
  const touched = new Set<number>();
  for (const f of crossed) for (const i of f.signature) touched.add(i);

  // Every face that stays, grouped by its owner — only for touched owners:
  // an untouched owner keeps its whole shape, which already covers it.
  const pieces = new Map<number, string[]>();
  for (const f of faces) {
    if (sweptSet.has(f.id)) continue;
    const owner = faceOwner(f);
    if (!touched.has(owner)) continue;
    pieces.set(owner, [...(pieces.get(owner) ?? []), f.id]);
  }

  const plan: ShapeBuildPlan = {
    rewrites: [],
    inserts: [],
    merge: null,
    deletes: [],
    untouched: [],
  };
  const mergeOwner =
    mode === "keep" ? Math.min(...crossed.map((f) => faceOwner(f))) : null;

  for (let i = 0; i < inputCount; i++) {
    if (!touched.has(i)) {
      plan.untouched.push(i);
      continue;
    }
    const own = pieces.get(i) ?? [];
    if (i === mergeOwner) {
      // The owner carries the merge: it IS the merged path, so every piece of
      // its own that stays is a fresh element painted like it.
      const carrier = canRewrite(i) ? "input" : "piece";
      plan.merge = { faces: crossed.map((f) => f.id), owner: i, carrier };
      for (const face of own) plan.inserts.push({ face, paintFrom: i });
      if (carrier === "piece") plan.deletes.push(i);
      continue;
    }
    if (own.length > 0 && canRewrite(i)) {
      plan.rewrites.push({ input: i, face: own[0] });
      for (const face of own.slice(1)) plan.inserts.push({ face, paintFrom: i });
      continue;
    }
    for (const face of own) plan.inserts.push({ face, paintFrom: i });
    plan.deletes.push(i);
  }
  return plan;
}
