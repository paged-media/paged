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

// OPACITY MASKS (Illustrator's Transparency panel row: "create/release
// opacity masks; clip/invert masks") over the C-28 protocol-58 ops.
//
// ====================================================================
// READ THIS FIRST — THE MASK IS NOT VISIBLE ON CANVAS.
// ====================================================================
// The engine honours the mask in the CPU rasterizer and in PDF EXPORT.
// It does NOT honour it in the Vello/WebGPU backend the editor canvas
// draws through, because Vello's `push_layer` takes a SHAPE, not a
// coverage buffer — there is nowhere to hand it a continuous alpha
// field. So today, applying a mask makes the mask ARTWORK disappear
// (it leaves the page's z-order — that part IS visible) and the masked
// artwork is modulated on screen exactly as it is in the exported PDF.
//
// HISTORY, kept because it is the more useful part: this module shipped
// with the opposite claim in three user-reachable places — the command
// title, the success log and `OPACITY_MASK_CANVAS_NOTE` — stating the
// canvas drew UNMASKED, and with no panel or overlay, on the reasoning
// that any on-canvas affordance would imply a WYSIWYG the backend could
// not deliver. The premise was false: vello v0.9.0 already had
// `Scene::push_luminance_mask_layer`, and the "no coverage buffer"
// belief traced to a misread `Cargo.lock` carrying a second, unrelated
// vello 0.3.0 for a spike crate. One unverified reading produced five
// wrong artifacts across four repos, including a conformance test that
// PINNED the wrong sentence. An honesty note is load-bearing precisely
// because people build on it — so it is worth being as sure of a stated
// limitation as of a stated feature.
//
// --------------------------------------------------------- the shape
// `applyOpacityMask { targetId, maskId, maskType?, invert? }` moves the
// MASK item out of `frames_in_order` and into the target's mask slot;
// `releaseOpacityMask { targetId }` pops it back to top level with its
// geometry untouched. Geometry is never rewritten on either side — the
// mask covers whatever it geometrically overlaps, exactly like
// Illustrator's Make Opacity Mask.
//
// SELECTION CONVENTION: the TOPMOST selected item is the mask, the one
// below it is the target — Illustrator's rule, and the reason the
// ordering is read from the SCENE TREE's paint order rather than click
// order (the `pathfinder-region.ts` finding: a selection made bottom-up
// would silently invert the roles).
//
// ----------------------------------------------------- the refusals
// Core gates BOTH sides to Rectangle / Oval / GraphicLine / Polygon and
// refuses, each with its own sentence:
//   · a TextFrame on either side ("a text frame's glyphs are emitted by
//     the story pass, outside the mask bracket");
//   · self-masking;
//   · the two items living on different spreads;
//   · a target that already carries a mask (release it first — an
//     implicit replace would lose the old mask item's z slot);
//   · an item already serving as some other target's mask;
//   · a PASTED-IN item (B-18 nested child) as the mask;
//   · a GROUPED item as the mask.
// None of those are re-implemented here. The command sends the op and
// hands the ENGINE'S OWN SENTENCE to the log and to
// `media.paged.draw.opacityMaskStatus` — the `pathfinder-region.ts`
// refusal-reporting precedent. Pre-filtering would mean maintaining a
// second copy of core's gate, and a local guess about "why" is exactly
// the thing that goes stale.
//
// ------------------------------------------------------ the metadata
// The engine exposes no READ door for the relation: once applied, the
// mask item is gone from the scene tree and nothing on the plugin
// surface reports "this element carries a mask, in this mode". So the
// apply STAMPS the relation on the target's own draw envelope
// (alongside `appearance` / `graphicStyle` / `symbolInstance` /
// `livePaint*`), and the release clears it:
//
//   data.opacityMask = { mask: { kind, id }, maskType, invert }
//
// The stamp rides INSIDE the same batch as the op, so it can never drift
// from the engine state: one undo reverts both together.
//
// MUTATION / UNDO SHAPE (MEASURED against the booted v58 engine, not
// assumed — the repo rule):
//   · make    = ONE batch ⇒ 1 undo step (op + stamp).
//   · release = ONE batch ⇒ 1 undo step (op + unstamp).
// Both are genuinely one, unlike this repo's insert-then-style flows:
// nothing here MINTS an element, so the C-15 `bindCreated` two-batch
// floor does not apply.
//
// ------------------------------------------------------------- limits
// · NO on-canvas rendering (above).
// · NO mask EDITING in place. Changing mode/invert means release +
//   re-apply, because the wire carries no "set mask options" op. The
//   commands expose that honestly rather than faking an edit.
// · The mask item is NOT SELECTABLE while it masks: it is out of
//   `frames_in_order`, so it is not in the scene tree and cannot be
//   hit-tested. Release to get it back. Illustrator's "edit the mask"
//   mode is a document-resident isolation state this engine has no
//   concept of.
// · A GROUP cannot be a mask (core refuses), so Illustrator's usual
//   "mask a whole group with a gradient rectangle" needs the group to be
//   the TARGET side only.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import { stampDrawMetadata } from "./appearance-bake";
import { selectionTopToBottom } from "./pathfinder-region";
import { leafIdsOf } from "./select-same";
import {
  applyOpacityMaskMutationFor,
  releaseOpacityMaskMutationFor,
  supportsOpacityMask,
  v58RefusalReason,
  type OpacityMaskMode,
} from "./v58-wire";

export const OPACITY_MASK_COMMAND_CATEGORY = "Transparency";

export const MAKE_OPACITY_MASK_COMMAND_ID =
  "media.paged.draw.command.makeOpacityMask";
export const RELEASE_OPACITY_MASK_COMMAND_ID =
  "media.paged.draw.command.releaseOpacityMask";

/** The contributed command ids, in registration order. */
export const OPACITY_MASK_COMMAND_IDS = [
  MAKE_OPACITY_MASK_COMMAND_ID,
  RELEASE_OPACITY_MASK_COMMAND_ID,
];

/** The binding a refusal (or the last success, as `null`) is published
 *  on, so a schema panel could show the engine's own words. */
export const BIND_OPACITY_MASK_STATUS = "media.paged.draw.opacityMaskStatus";

/** What the mask does, now that it renders everywhere. Pinned by a
 *  conformance test.
 *
 *  This constant previously carried a renderer-gap warning: that the mask
 *  was honoured by the CPU rasterizer and PDF but NOT by the Vello/WebGPU
 *  backend, because "Vello's push_layer takes a shape, not a coverage
 *  buffer". That was RETRACTED — the pinned vello (v0.9.0) has
 *  `Scene::push_luminance_mask_layer`, and alpha masks never needed a
 *  mask layer at all (`Compose::DestIn` IS `dst · src.a`). The belief
 *  came from misreading a second, unrelated vello 0.3.0 entry in core's
 *  Cargo.lock. Vello output is now byte-identical to the CPU rasterizer
 *  across luminosity, alpha and both inverted forms. */
export const OPACITY_MASK_CANVAS_NOTE =
  "the mask renders on canvas and in the exported PDF alike — the Vello " +
  "backend matches the CPU rasterizer byte-for-byte across luminosity, " +
  "alpha and both inverted forms";

/** The kinds core accepts on EITHER side of a mask. Mirrored here only
 *  so a caller can explain a likely refusal BEFORE spending a round
 *  trip; the authority is still the engine's own sentence, which is what
 *  a user sees. */
export const OPACITY_MASK_KINDS = new Set([
  "rectangle",
  "oval",
  "graphicLine",
  "polygon",
]);

/** The mask mode used when a payload names none — Illustrator's default
 *  and PDF's `/S /Luminosity`. */
export const DEFAULT_OPACITY_MASK_MODE: OpacityMaskMode = "luminosity";

// ---------------------------------------------------------- the model

/** The relation recorded on the TARGET's own draw envelope. */
export interface OpacityMaskRef {
  /** The artwork now serving as the mask (out of the scene tree). */
  mask: { kind: string; id: string };
  maskType: OpacityMaskMode;
  invert: boolean;
}

/** Read the mask relation out of an envelope, or null. Tolerant of
 *  partial / foreign shapes (the `livePaintFillOf` convention). */
export function opacityMaskOf(
  env: PluginMetadataEnvelope | null,
): OpacityMaskRef | null {
  const raw = (env?.data as { opacityMask?: unknown } | undefined)?.opacityMask;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { mask?: unknown; maskType?: unknown; invert?: unknown };
  const m = (r.mask ?? {}) as { kind?: unknown; id?: unknown };
  if (typeof m.kind !== "string" || m.kind.length === 0) return null;
  if (typeof m.id !== "string" || m.id.length === 0) return null;
  return {
    mask: { kind: m.kind, id: m.id },
    maskType: r.maskType === "alpha" ? "alpha" : "luminosity",
    invert: r.invert === true,
  };
}

/** Merge (or, with `null`, DROP) the `opacityMask` key in an envelope,
 *  preserving every other draw metadata key — releasing a mask must
 *  leave appearance / graphic-style / symbol / live-paint records
 *  exactly as they are. */
export function withOpacityMaskKey(
  prev: PluginMetadataEnvelope | null,
  ref: OpacityMaskRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data.opacityMask;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.opacityMask = ref;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ------------------------------------------------------ wire builders
// Exported so the conformance spec asserts the EXACT wire shape the live
// commands emit (no second copy to drift from).

/** THE make batch — the op plus the target's stamp. ONE batch ⇒ 1 undo
 *  step, so the recorded relation can never outlive the engine's. */
export function opacityMaskApplyBatchFor(args: {
  target: ElementId;
  mask: ElementId;
  maskType: OpacityMaskMode;
  invert: boolean;
  /** The target's CURRENT envelope, so every other draw key survives. */
  envelope: PluginMetadataEnvelope | null;
}): Mutation {
  const ref: OpacityMaskRef = {
    mask: { kind: args.mask.kind, id: String((args.mask as { id: unknown }).id) },
    maskType: args.maskType,
    invert: args.invert,
  };
  return {
    op: "batch",
    args: {
      ops: [
        applyOpacityMaskMutationFor({
          targetId: args.target,
          maskId: args.mask,
          maskType: args.maskType,
          invert: args.invert,
        }),
        stampDrawMetadata(args.target, withOpacityMaskKey(args.envelope, ref)),
      ],
    },
  };
}

/** THE release batch — the op plus the unstamp. ONE batch ⇒ 1 undo
 *  step. */
export function opacityMaskReleaseBatchFor(args: {
  target: ElementId;
  envelope: PluginMetadataEnvelope | null;
}): Mutation {
  return {
    op: "batch",
    args: {
      ops: [
        releaseOpacityMaskMutationFor(args.target),
        stampDrawMetadata(args.target, withOpacityMaskKey(args.envelope, null)),
      ],
    },
  };
}

// --------------------------------------------------------- host reads

const idOf = (raw: unknown): ElementId | null => {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { kind?: unknown; id?: unknown };
  if (typeof e.kind !== "string" || e.kind.length === 0) return null;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  return { kind: e.kind, id: e.id } as ElementId;
};

/** The target a release should act on: the payload's `targetId`, else
 *  the first selected element whose envelope records a mask, else the
 *  first selected element (so the engine's "carries no opacity mask"
 *  sentence is what a mistaken invocation shows). Null = nothing to
 *  act on. */
export async function resolveMaskTarget(
  host: BundleHost,
  payload?: { targetId?: unknown },
): Promise<ElementId | null> {
  const named = idOf(payload?.targetId);
  if (named) return named;
  const selection = host.selection.get();
  for (const id of selection) {
    const env = await host.document.getMetadata(id).catch(() => null);
    if (opacityMaskOf(env)) return id;
  }
  return selection[0] ?? null;
}

/** Every element whose envelope records a mask, with the relation. One
 *  scene walk plus one metadata read per leaf (the `livePaintLinks`
 *  precedent). The MASK items themselves are not in the tree while they
 *  mask, which is exactly why the record lives on the target. */
export async function opacityMaskLinks(
  host: BundleHost,
): Promise<{ id: ElementId; ref: OpacityMaskRef }[]> {
  const found: { id: ElementId; ref: OpacityMaskRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const ref = opacityMaskOf(env);
    if (ref) found.push({ id, ref });
  }
  return found;
}

// ------------------------------------------------------------ appliers

/** Report a refusal the same way everywhere: the engine's own sentence,
 *  at WARN and on the shared status binding. Returns the sentence. */
function reportRefusal(
  host: Pick<BundleHost, "log" | "bindings">,
  label: string,
  error: unknown,
): string {
  const reason =
    v58RefusalReason(error) ?? "the engine refused the opacity-mask operation";
  host.log.warn(`${label}: ${reason}`);
  host.bindings.publish(BIND_OPACITY_MASK_STATUS, reason);
  return reason;
}

const modeOf = (raw: unknown): OpacityMaskMode =>
  raw === "alpha" || raw === "Alpha" ? "alpha" : DEFAULT_OPACITY_MASK_MODE;

/**
 * MAKE — the TOPMOST selected item becomes the mask of the one below.
 *
 * Payload: `{ targetId?, maskId?, maskType?: "luminosity" | "alpha",
 * invert?: boolean }`. Named ids win over the selection.
 *
 * ONE batch ⇒ 1 undo step (measured). Every core-side refusal is
 * surfaced with the engine's own sentence rather than pre-guessed.
 */
export async function applyMakeOpacityMask(
  host: BundleHost,
  payload?: {
    targetId?: unknown;
    maskId?: unknown;
    maskType?: unknown;
    invert?: unknown;
  },
): Promise<OpacityMaskRef | null> {
  const label = MAKE_OPACITY_MASK_COMMAND_ID;
  if (!(await supportsOpacityMask(host))) {
    host.log.warn(
      `${label}: this host's engine carries no applyOpacityMask op (it predates ` +
        "protocol 58) — opacity masks are unavailable here",
    );
    return null;
  }
  let target = idOf(payload?.targetId);
  let mask = idOf(payload?.maskId);
  if (!target || !mask) {
    // Illustrator's rule: the TOPMOST object is the mask. Read the real
    // stacking order from the scene tree — selection order would invert
    // the roles for a bottom-up selection.
    const ordered = await selectionTopToBottom(host);
    if (ordered.length !== 2) {
      host.log.warn(
        `${label}: needs exactly 2 selected items (have ${ordered.length}) — the ` +
          "TOPMOST becomes the mask and the one below it is masked. Core takes " +
          "one mask and one target; there is no group-the-rest step on the wire",
      );
      return null;
    }
    mask = mask ?? ordered[0]!;
    target = target ?? ordered[1]!;
  }
  const maskType = modeOf(payload?.maskType);
  const invert = payload?.invert === true;
  const envelope = await host.document.getMetadata(target).catch(() => null);
  const outcome = await host.document.mutate(
    opacityMaskApplyBatchFor({ target, mask, maskType, invert, envelope }),
  );
  if (!outcome.applied) {
    reportRefusal(host, label, outcome.error);
    return null;
  }
  host.bindings.publish(BIND_OPACITY_MASK_STATUS, null);
  host.log.info(
    `${label}: ${mask.kind} ${String((mask as { id: unknown }).id)} now masks ` +
      `${target.kind} ${String((target as { id: unknown }).id)} ` +
      `(${maskType}${invert ? ", inverted" : ""}). NOTE: ${OPACITY_MASK_CANVAS_NOTE}`,
  );
  return {
    mask: { kind: mask.kind, id: String((mask as { id: unknown }).id) },
    maskType,
    invert,
  };
}

/**
 * RELEASE — drop the relation; the mask artwork returns to top level
 * with its geometry untouched (it stacks on TOP, not at its original
 * slot: `restore_slot` is inverse-only on the wire, so only UNDO puts
 * it back exactly where it was).
 *
 * ONE batch ⇒ 1 undo step (measured).
 */
export async function applyReleaseOpacityMask(
  host: BundleHost,
  payload?: { targetId?: unknown },
): Promise<boolean> {
  const label = RELEASE_OPACITY_MASK_COMMAND_ID;
  if (!(await supportsOpacityMask(host))) {
    host.log.warn(
      `${label}: this host's engine carries no releaseOpacityMask op (it ` +
        "predates protocol 58) — opacity masks are unavailable here",
    );
    return false;
  }
  const target = await resolveMaskTarget(host, payload);
  if (!target) {
    host.log.warn(
      `${label}: nothing selected and no targetId in the payload — no-op`,
    );
    return false;
  }
  const envelope = await host.document.getMetadata(target).catch(() => null);
  const outcome = await host.document.mutate(
    opacityMaskReleaseBatchFor({ target, envelope }),
  );
  if (!outcome.applied) {
    reportRefusal(host, label, outcome.error);
    return false;
  }
  host.bindings.publish(BIND_OPACITY_MASK_STATUS, null);
  host.log.info(
    `${label}: ${target.kind} ${String((target as { id: unknown }).id)} released ` +
      "— the mask artwork is back on the page, stacked on top (undo restores " +
      "its original z slot exactly; a release does not)",
  );
  return true;
}

// ------------------------------------------------------------ commands

const payloadOf = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

/** Register the two opacity-mask commands.
 *
 *  The TITLES carry the renderer gap, the way `pattern.ts`'s title
 *  carries "copies, not a live fill": a command palette entry is the one
 *  surface a user reads BEFORE invoking. */
export function contributeOpacityMaskCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_OPACITY_MASK_COMMAND_ID,
      title:
        "Transparency: Make opacity mask from top object (renders on canvas and in export)",
      category: OPACITY_MASK_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeOpacityMask(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_OPACITY_MASK_COMMAND_ID,
      title: "Transparency: Release opacity mask (the artwork comes back on top)",
      category: OPACITY_MASK_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleaseOpacityMask(host, payloadOf(payload)).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
