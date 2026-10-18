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

// THE PROTOCOL-58 WIRE SEAM — one place for the four v58 ops (C-28
// opacity masks, C-29 type on a path), their capability probes and their
// refusal reader. Extracted the way `handlers/planar-regions.ts` was:
// two features reaching the same protocol generation through two copies
// of the same cast is exactly the drift the no-second-copy rule exists
// to prevent.
//
// ------------------------------------------- contract skew: CLOSED
// This block used to explain four `as unknown as Mutation` casts and
// promise a pure deletion at the next canary bump. The bump happened
// (`0.2.25-canary.0` → `0.2.28-canary.0`, which carries plugin-sdk
// `f00d6dd`), and the deletion is done. All four ops are typed in
// `@paged-media/plugin-api`'s protocol-ahead delta:
//
//   applyOpacityMask   { targetId, maskId, maskType?, invert? }
//   releaseOpacityMask { targetId }
//   attachTextToPath   { elementId, storyId, pathTypeAlignment?,
//                        flipPathEffect?, startBracket?, endBracket? }
//   detachTextFromPath { elementId }
//
// The builders return `PendingMutation`; `OpacityMaskMode` is now an
// alias of the contract's `OpacityMaskType` rather than a second
// declaration of the same two strings. Nothing else in this repo
// touches the v58 wire.
//
// ---------------------------------------------------- optional fields
// Every optional argument is OMITTED when the caller does not set it
// rather than sent as `null`. Both are accepted (core declares each
// `#[serde(default)] Option<…>`), but omission keeps the emitted wire
// minimal and the conformance assertions exact — the `closePath{
// subpath? }` precedent in `join-average.ts`.
//
// ------------------------------------------------- capability probing
// Version sniffing is not available to a bundle and would be wrong
// anyway; `engineOpVocabulary` (join-average.ts) asks the ENGINE what
// ops it knows by sending one deliberately-unknown variant and reading
// the op list out of the deserialize error. An unreadable vocabulary
// answers TRUE — optimistic, because the ATTEMPT then reports honestly.

import type {
  BundleHost,
  ElementId,
  OpacityMaskType,
  PendingMutation,
} from "@paged-media/plugin-api";

import { engineOpVocabulary } from "./join-average";

/** C-28 — how the mask artwork's coverage is read. `luminosity` is
 *  Illustrator's default and PDF's `/S /Luminosity`; `alpha` reads the
 *  artwork's alpha channel instead.
 *
 *  This is now an ALIAS of the contract's `OpacityMaskType`, kept only
 *  because it is part of this bundle's exported surface (`index.ts`)
 *  and six call sites in `opacity-mask.ts` name it. Renaming those is a
 *  separate, purely cosmetic change; what mattered — that the local
 *  declaration could drift from the contract's — is fixed. */
export type OpacityMaskMode = OpacityMaskType;

/** The `pathTypeAlignment` values core accepts — the glyph's vertical
 *  seat on the path. Baseline (the IDML default) and Center are the
 *  well-exercised pair; Ascender / Descender land too, and the
 *  renderer's own note says they are exercised less. */
export const PATH_TYPE_ALIGNMENTS = [
  "BaselinePathType",
  "CenterPathType",
  "AscenderPathType",
  "DescenderPathType",
] as const;

export type PathTypeAlignment = (typeof PATH_TYPE_ALIGNMENTS)[number];

/** The `flipPathEffect` values core accepts. `Flipped` reverses the path
 *  direction so the run reads the other way round. */
export const FLIP_PATH_EFFECTS = ["NotFlipped", "Flipped"] as const;

export type FlipPathEffect = (typeof FLIP_PATH_EFFECTS)[number];

/** The knobs `attachTextToPath` carries. Deliberately WITHOUT
 *  `PathEffect`: only `RainbowPathEffect` actually renders (Skew /
 *  3D-ribbon / stair-step / gravity parse and then draw as Rainbow), so
 *  core does not expose one and neither does this bundle. A control
 *  whose value is silently ignored is worse than no control. */
export interface TextPathSpec {
  pathTypeAlignment?: PathTypeAlignment | null;
  flipPathEffect?: FlipPathEffect | null;
  /** Arc-length window start, in pt along the tessellated path. */
  startBracket?: number | null;
  /** Arc-length window end. Glyphs past it are DROPPED and reported by
   *  the engine as overset — the run is not compressed to fit. */
  endBracket?: number | null;
}

// ------------------------------------------------------ wire builders
// Exported so the conformance spec asserts the EXACT shapes the live
// commands emit (no second copy to drift from).

/** `applyOpacityMask { targetId, maskId, maskType?, invert? }` — the
 *  item at `maskId` stops painting on its own and becomes the soft mask
 *  of the item at `targetId`. */
export function applyOpacityMaskMutationFor(args: {
  targetId: ElementId;
  maskId: ElementId;
  maskType?: OpacityMaskType;
  invert?: boolean;
}): PendingMutation {
  return {
    op: "applyOpacityMask",
    args: {
      targetId: args.targetId,
      maskId: args.maskId,
      ...(args.maskType === undefined ? {} : { maskType: args.maskType }),
      ...(args.invert === undefined ? {} : { invert: args.invert }),
    },
  };
}

/** `releaseOpacityMask { targetId }` — drop the relation; the artwork
 *  returns to top level with its geometry untouched. */
export function releaseOpacityMaskMutationFor(
  targetId: ElementId,
): PendingMutation {
  return {
    op: "releaseOpacityMask",
    args: { targetId },
  };
}

/** `attachTextToPath { elementId, storyId, … }` — flow an EXISTING
 *  story along an EXISTING path element. */
export function attachTextToPathMutationFor(
  elementId: ElementId,
  storyId: string,
  spec: TextPathSpec = {},
): PendingMutation {
  return {
    op: "attachTextToPath",
    args: {
      elementId,
      storyId,
      ...(spec.pathTypeAlignment === undefined ||
      spec.pathTypeAlignment === null
        ? {}
        : { pathTypeAlignment: spec.pathTypeAlignment }),
      ...(spec.flipPathEffect === undefined || spec.flipPathEffect === null
        ? {}
        : { flipPathEffect: spec.flipPathEffect }),
      ...(spec.startBracket === undefined || spec.startBracket === null
        ? {}
        : { startBracket: spec.startBracket }),
      ...(spec.endBracket === undefined || spec.endBracket === null
        ? {}
        : { endBracket: spec.endBracket }),
    },
  };
}

/** `detachTextFromPath { elementId }` — unlink the text from the path.
 *  THE STORY SURVIVES (core's deliberate choice: attach only ever
 *  linked an existing story, so unlinking is its exact inverse). */
export function detachTextFromPathMutationFor(
  elementId: ElementId,
): PendingMutation {
  return {
    op: "detachTextFromPath",
    args: { elementId },
  };
}

// ---------------------------------------------------- refusal reading
//
// Both op families refuse with a SENTENCE, and the sentences are the
// whole point (see `commands/opacity-mask.ts` / `commands/text-on-path.ts`
// for the lists). The engine wraps them twice —
//   "frame mutation failed: invalid value for FrameTransform on
//    Polygon(\"ua\"): C-28: an item cannot mask itself"
// — so this peels the envelope and hands back the clause a user can act
// on. The `C-28` / `C-29` tag is an internal RFI marker, so it is
// stripped too; the SENTENCE is what reaches the log and the binding.

/** The engine's own sentence for a refused v58 op, or null when the
 *  error carries no readable text. The `regionRefusalReason` precedent,
 *  with this op family's marker. */
export function v58RefusalReason(error: unknown): string | null {
  // `JSON.stringify(null)` is the STRING "null", which would otherwise
  // be reported to a user as the reason. An absent error has no reason.
  if (error === null || error === undefined) return null;
  let text: string;
  try {
    text = typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  } catch {
    return null;
  }
  if (!text) return null;
  const what = /"what"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const raw = (what ? what[1].replace(/\\"/g, '"') : text).trim();
  const marked = /C-2[89]:\s*([\s\S]*)$/.exec(raw);
  return (marked ? marked[1] : raw).trim() || null;
}

// ------------------------------------------------------- capabilities

/** Does this engine carry the C-28 opacity-mask ops (protocol ≥ 58)?
 *  An unreadable vocabulary answers TRUE (see the module header). */
export async function supportsOpacityMask(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  if (!vocab) return true;
  return vocab.has("applyOpacityMask") && vocab.has("releaseOpacityMask");
}

/** Does this engine carry the C-29 type-on-a-path ops (protocol ≥ 58)? */
export async function supportsTextOnPath(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  if (!vocab) return true;
  return vocab.has("attachTextToPath") && vocab.has("detachTextFromPath");
}
