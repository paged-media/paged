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

// TYPE ON A PATH (InDesign's Type-on-a-Path tool; Illustrator's Type on
// a Path) over the C-29 protocol-58 ops.
//
// -------------------------------------------------- what this really is
// The engine has RENDERED `<TextPath>` since the parser learned it —
// alignment, flip, the bracket window, the overset report. What no
// mutation could ever do was CREATE one: every constructor initialised
// `text_paths: Vec::new()` and nothing pushed to it. `attachTextToPath`
// is exactly that gap closed, so unlike most rows in this repo there is
// no approximation here: the knobs on the op are the knobs the RENDERER
// HONOURS, and nothing else is offered.
//
// It FLOWS AN EXISTING STORY. There is no "create an empty story" op on
// the wire — `insertTextFrame` mints one, but it mints it BOUND to that
// frame, and a story that flows into a frame is refused by attach (one
// story, one flow). So the honest gesture is: pick a story that is not
// flowing anywhere, and put it on a path. Where a free story comes from
// is a real workflow, and the refusal below says it out loud: type into
// an ordinary text frame, delete the FRAME (the story survives — core's
// `RemoveNode` does not touch `doc.stories`), then attach. Detaching a
// path likewise leaves its story free for the next path.
//
// A "seed a new story for me" command would be `insertTextFrame` +
// `deleteFrame` + `insertText` — three ops of frame churn to fake a
// primitive the wire does not have. Named here as deliberately NOT
// built rather than smuggled in behind the tool.
//
// ------------------------------------------------------------- hosts
// Rectangle / GraphicLine / Polygon — the kinds that carry `text_paths`
// AND that the renderer's text-path pass walks.
//   · an OVAL is refused: `paged_model::Oval` has no `text_paths` field
//     and the pass never looks at ovals, so a link there would draw
//     nothing;
//   · a TEXT FRAME is refused: its glyphs come from the STORY pass, so
//     accepting one would render a lie.
// Neither gate is re-implemented here — the op is sent and the ENGINE'S
// OWN SENTENCE is surfaced (the `pathfinder-region.ts` refusal-reporting
// precedent). `TEXT_ON_PATH_KINDS` exists only so the TOOL can explain
// a likely refusal before spending a round trip.
//
// ------------------------------------------------------- what is live
// All four knobs are genuinely honoured — verified against
// `paged_renderer::pipeline::text_path`, not assumed:
//   · `pathTypeAlignment` — the glyph's vertical seat. Baseline (the
//     IDML default) and Center are the well-exercised pair; Ascender /
//     Descender land too (the renderer's own note says they are
//     exercised less).
//   · `flipPathEffect` — `Flipped` reverses the path direction so the
//     run reads the other way round.
//   · `startBracket` / `endBracket` — the arc-length window. The
//     renderer CLAMPS both to the tessellated path length, CENTRES the
//     run in the window when it fits, and DROPS glyphs past
//     `endBracket`, reporting them as overset. (An earlier claim that
//     the brackets were ignored was simply wrong.)
//
// `PathEffect` is deliberately absent from the op AND from this bundle:
// only `RainbowPathEffect` actually renders — Skew, 3D-ribbon,
// stair-step and gravity parse and then draw as Rainbow — so a control
// for it would be a knob whose value is silently ignored. Leaving the
// attribute unset IS Rainbow, the IDML default.
//
// ------------------------------------------------------ the metadata
// The plugin surface has no read door for "which story is on this
// path": `host.document.frameChain(storyId)` answers the FRAME chain,
// and a path-attached story has none — it reads exactly like an
// unflowed one. So the attach STAMPS the link on the host's own draw
// envelope (alongside `appearance` / `graphicStyle` / `symbolInstance` /
// `livePaint*` / `opacityMask`) and the detach clears it:
//
//   data.textOnPath = { story, pathTypeAlignment, flipPathEffect,
//                       startBracket, endBracket }
//
// That record is what makes "which stories are still free?" answerable
// (frame-chain empty AND not claimed by a stamp), and it rides INSIDE
// the same batch as the op so one undo reverts both together.
//
// MUTATION / UNDO SHAPE (MEASURED against the booted v58 engine — the
// repo rule, never "one" by assumption):
//   · attach = ONE batch ⇒ 1 undo step (op + stamp).
//   · detach = ONE batch ⇒ 1 undo step (op + unstamp).
// Nothing here MINTS an element, so the C-15 `bindCreated` two-batch
// floor that governs this repo's insert-then-style flows does not apply.
//
// ------------------------------------------------------------- limits
// · NO story creation (above).
// · NO in-place edit of the knobs: the wire has no "set text-path
//   options" op, so changing alignment / flip / brackets means detach +
//   re-attach. The commands expose that honestly rather than faking an
//   edit.
// · A host may carry SEVERAL `<TextPath>` entries in the model; the
//   wire's detach takes slot 0 (`index` is inverse-only), so this bundle
//   is a ONE-story-per-path lane and says so.
// · Overset (a run longer than its bracket window) is reported by the
//   ENGINE as a diagnostic; there is no plugin-surface door that reads
//   diagnostics, so this bundle cannot warn about it. Named, not
//   guessed at.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";

import { stampDrawMetadata } from "./appearance-bake";
import { leafIdsOf } from "./select-same";
import {
  attachTextToPathMutationFor,
  detachTextFromPathMutationFor,
  supportsTextOnPath,
  v58RefusalReason,
  FLIP_PATH_EFFECTS,
  PATH_TYPE_ALIGNMENTS,
  type FlipPathEffect,
  type PathTypeAlignment,
  type TextPathSpec,
} from "./v58-wire";

export const TEXT_ON_PATH_COMMAND_CATEGORY = "Type";

export const ATTACH_TEXT_TO_PATH_COMMAND_ID =
  "media.paged.draw.command.attachTextToPath";
export const DETACH_TEXT_FROM_PATH_COMMAND_ID =
  "media.paged.draw.command.detachTextFromPath";

/** The contributed command ids, in registration order. */
export const TEXT_ON_PATH_COMMAND_IDS = [
  ATTACH_TEXT_TO_PATH_COMMAND_ID,
  DETACH_TEXT_FROM_PATH_COMMAND_ID,
];

/** The binding a refusal (or the last success, as `null`) is published
 *  on, so a schema panel could show the engine's own words. */
export const BIND_TEXT_ON_PATH_STATUS = "media.paged.draw.textOnPathStatus";

/** The binding carrying the story id the tool would attach next (or
 *  null) — the tool's "what am I about to place?" readout. */
export const BIND_TEXT_ON_PATH_STORY = "media.paged.draw.textOnPathStory";

/** The kinds core accepts as a text-path HOST. Mirrored here only so the
 *  tool can explain a likely refusal before spending a round trip; the
 *  authority is the engine's own sentence, which is what a user sees. */
export const TEXT_ON_PATH_KINDS = new Set([
  "rectangle",
  "graphicLine",
  "polygon",
]);

/** The sentence a caller with no free story gets. Pinned by a
 *  conformance test: it must stay ACTIONABLE (it names the workflow that
 *  produces one) rather than degrade into "nothing happened". */
export const NO_FREE_STORY_NOTE =
  "Type on a Path FLOWS AN EXISTING STORY — the wire has no create-story op, " +
  "and a story that already flows into a text frame is refused (one story, " +
  "one flow). To get one: type into an ordinary text frame, delete the FRAME " +
  "(the story survives), then run this again — or detach another path";

// ---------------------------------------------------------- the model

/** The link recorded on the HOST's own draw envelope. */
export interface TextOnPathRef {
  story: string;
  pathTypeAlignment: PathTypeAlignment | null;
  flipPathEffect: FlipPathEffect | null;
  startBracket: number | null;
  endBracket: number | null;
}

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Coerce a caller-supplied alignment to one core accepts, or null. */
export function pathTypeAlignmentOf(raw: unknown): PathTypeAlignment | null {
  const s = strOrNull(raw);
  return s && (PATH_TYPE_ALIGNMENTS as readonly string[]).includes(s)
    ? (s as PathTypeAlignment)
    : null;
}

/** Coerce a caller-supplied flip to one core accepts, or null. A boolean
 *  `true` reads as `Flipped` (the natural payload for a checkbox). */
export function flipPathEffectOf(raw: unknown): FlipPathEffect | null {
  if (raw === true) return "Flipped";
  if (raw === false) return "NotFlipped";
  const s = strOrNull(raw);
  return s && (FLIP_PATH_EFFECTS as readonly string[]).includes(s)
    ? (s as FlipPathEffect)
    : null;
}

/** The knob set a payload asks for. Pure. */
export function textPathSpecOf(payload?: {
  pathTypeAlignment?: unknown;
  flipPathEffect?: unknown;
  startBracket?: unknown;
  endBracket?: unknown;
}): TextPathSpec {
  return {
    pathTypeAlignment: pathTypeAlignmentOf(payload?.pathTypeAlignment),
    flipPathEffect: flipPathEffectOf(payload?.flipPathEffect),
    startBracket: numOrNull(payload?.startBracket),
    endBracket: numOrNull(payload?.endBracket),
  };
}

/** Read the text-path link out of an envelope, or null. Tolerant of
 *  partial / foreign shapes (the `livePaintFillOf` convention). */
export function textOnPathOf(
  env: PluginMetadataEnvelope | null,
): TextOnPathRef | null {
  const raw = (env?.data as { textOnPath?: unknown } | undefined)?.textOnPath;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const story = strOrNull(r.story);
  if (!story) return null;
  return {
    story,
    pathTypeAlignment: pathTypeAlignmentOf(r.pathTypeAlignment),
    flipPathEffect: flipPathEffectOf(r.flipPathEffect),
    startBracket: numOrNull(r.startBracket),
    endBracket: numOrNull(r.endBracket),
  };
}

/** Merge (or, with `null`, DROP) the `textOnPath` key in an envelope,
 *  preserving every other draw metadata key — detaching must leave
 *  appearance / graphic-style / symbol / live-paint / opacity-mask
 *  records exactly as they are. */
export function withTextOnPathKey(
  prev: PluginMetadataEnvelope | null,
  ref: TextOnPathRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data.textOnPath;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.textOnPath = ref;
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

/** THE attach batch — the op plus the host's stamp. ONE batch ⇒ 1 undo
 *  step, so the recorded link can never outlive the engine's. */
export function textOnPathAttachBatchFor(args: {
  element: ElementId;
  storyId: string;
  spec: TextPathSpec;
  /** The host's CURRENT envelope, so every other draw key survives. */
  envelope: PluginMetadataEnvelope | null;
}): Mutation {
  const ref: TextOnPathRef = {
    story: args.storyId,
    pathTypeAlignment: args.spec.pathTypeAlignment ?? null,
    flipPathEffect: args.spec.flipPathEffect ?? null,
    startBracket: args.spec.startBracket ?? null,
    endBracket: args.spec.endBracket ?? null,
  };
  return {
    op: "batch",
    args: {
      ops: [
        attachTextToPathMutationFor(args.element, args.storyId, args.spec),
        stampDrawMetadata(args.element, withTextOnPathKey(args.envelope, ref)),
      ],
    },
  };
}

/** THE detach batch — the op plus the unstamp. ONE batch ⇒ 1 undo
 *  step. */
export function textOnPathDetachBatchFor(args: {
  element: ElementId;
  envelope: PluginMetadataEnvelope | null;
}): Mutation {
  return {
    op: "batch",
    args: {
      ops: [
        detachTextFromPathMutationFor(args.element),
        stampDrawMetadata(
          args.element,
          withTextOnPathKey(args.envelope, null),
        ),
      ],
    },
  };
}

// --------------------------------------------------------- host reads

/** One story as `host.document.collection("stories")` reports it (the
 *  engine's `StorySummary`; typed structurally so a summary field added
 *  later is not a break). */
export interface StorySummaryLike {
  selfId: string;
  characterCount?: number;
  paragraphCount?: number;
  overset?: boolean;
}

/** Every story in the document, or `[]` when the collection is
 *  unreadable (logged at debug, never thrown). */
export async function documentStories(
  host: BundleHost,
): Promise<StorySummaryLike[]> {
  try {
    const raw = await host.document.collection<StorySummaryLike>("stories");
    return raw.filter((s) => typeof s?.selfId === "string" && s.selfId.length > 0);
  } catch {
    host.log.debug("text on path: the stories collection is unreadable");
    return [];
  }
}

/** Every path host carrying a text-path stamp, with its link. One scene
 *  walk plus one metadata read per leaf (the `livePaintLinks`
 *  precedent). */
export async function textOnPathLinks(
  host: BundleHost,
): Promise<{ id: ElementId; ref: TextOnPathRef }[]> {
  const found: { id: ElementId; ref: TextOnPathRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const ref = textOnPathOf(env);
    if (ref) found.push({ id, ref });
  }
  return found;
}

/**
 * The stories that are FREE to be attached: no frame chain (so they do
 * not flow into a text frame) and not already claimed by a path stamp.
 *
 * Both halves are load-bearing. `frameChain` alone cannot answer this —
 * a story already flowing along a PATH reports an empty chain too
 * (measured), so without the stamps this would happily offer a story
 * the engine is about to refuse.
 */
export async function freeStories(
  host: BundleHost,
): Promise<StorySummaryLike[]> {
  const claimed = new Set(
    (await textOnPathLinks(host)).map((link) => link.ref.story),
  );
  const free: StorySummaryLike[] = [];
  for (const story of await documentStories(host)) {
    if (claimed.has(story.selfId)) continue;
    const chain = await host.document.frameChain(story.selfId).catch(() => []);
    if (chain.length === 0) free.push(story);
  }
  return free;
}

const idOf = (raw: unknown): ElementId | null => {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { kind?: unknown; id?: unknown };
  if (typeof e.kind !== "string" || e.kind.length === 0) return null;
  if (typeof e.id !== "string" || e.id.length === 0) return null;
  return { kind: e.kind, id: e.id } as ElementId;
};

/** The host element an invocation acts on: the payload's `elementId`,
 *  else the first selected element. Null = nothing to act on. */
export function resolvePathHost(
  host: BundleHost,
  payload?: { elementId?: unknown },
): ElementId | null {
  return idOf(payload?.elementId) ?? host.selection.get()[0] ?? null;
}

/** The story an attach should flow: the payload's `storyId`, else the
 *  module-level pending story when it is still free, else the ONLY free
 *  story. `null` when the choice is not unambiguous — never a guess
 *  between several stories (attaching the wrong text is silent damage). */
export async function resolveAttachStory(
  host: BundleHost,
  payload?: { storyId?: unknown },
): Promise<{ storyId: string } | { storyId: null; reason: string }> {
  const named = strOrNull(payload?.storyId);
  if (named) return { storyId: named };
  const free = await freeStories(host);
  const pending = getTextOnPathStory();
  if (pending && free.some((s) => s.selfId === pending)) {
    return { storyId: pending };
  }
  if (free.length === 1) return { storyId: free[0]!.selfId };
  if (free.length === 0) return { storyId: null, reason: NO_FREE_STORY_NOTE };
  return {
    storyId: null,
    reason:
      `${free.length} stories are free (${free
        .map((s) => s.selfId)
        .join(", ")}) — name one in the payload's storyId, or set it as the ` +
      "pending story, rather than have the wrong text land on the path",
  };
}

// ------------------------------------------------- the pending story
//
// Module state, the `handlers/eyedropper.ts` / `handlers/live-paint.ts`
// precedent: the v0 tool contract has no per-tool option surface, so a
// panel or a command sets which story the TOOL will place and the tool
// reads it. Defaults to null = "resolve it from the document".

let pendingStory: string | null = null;

/** The story the tool will attach next (null = auto-resolve). */
export function getTextOnPathStory(): string | null {
  return pendingStory;
}

/** Set the story the tool will attach next (`null` = auto-resolve). */
export function setTextOnPathStory(storyId: string | null): void {
  pendingStory = storyId;
}

// ------------------------------------------------------------ appliers

function reportRefusal(
  host: Pick<BundleHost, "log" | "bindings">,
  label: string,
  error: unknown,
): string {
  const reason =
    v58RefusalReason(error) ?? "the engine refused the text-on-a-path operation";
  host.log.warn(`${label}: ${reason}`);
  host.bindings.publish(BIND_TEXT_ON_PATH_STATUS, reason);
  return reason;
}

/**
 * ATTACH — flow an existing story along an existing path.
 *
 * Payload: `{ elementId?, storyId?, pathTypeAlignment?, flipPathEffect?,
 * startBracket?, endBracket? }`.
 *
 * ONE batch ⇒ 1 undo step (measured). Every core-side refusal (oval /
 * text-frame host, missing story, a story already flowing) is surfaced
 * with the engine's own sentence rather than pre-guessed.
 */
export async function applyAttachTextToPath(
  host: BundleHost,
  payload?: {
    elementId?: unknown;
    storyId?: unknown;
    pathTypeAlignment?: unknown;
    flipPathEffect?: unknown;
    startBracket?: unknown;
    endBracket?: unknown;
  },
): Promise<TextOnPathRef | null> {
  const label = ATTACH_TEXT_TO_PATH_COMMAND_ID;
  if (!(await supportsTextOnPath(host))) {
    host.log.warn(
      `${label}: this host's engine carries no attachTextToPath op (it predates ` +
        "protocol 58) — type on a path is unavailable here",
    );
    return null;
  }
  const element = resolvePathHost(host, payload);
  if (!element) {
    host.log.warn(
      `${label}: nothing selected and no elementId in the payload — no-op`,
    );
    return null;
  }
  const story = await resolveAttachStory(host, payload);
  if (story.storyId === null) {
    host.log.warn(`${label}: ${story.reason}`);
    host.bindings.publish(BIND_TEXT_ON_PATH_STATUS, story.reason);
    return null;
  }
  const spec = textPathSpecOf(payload);
  const envelope = await host.document.getMetadata(element).catch(() => null);
  const outcome = await host.document.mutate(
    textOnPathAttachBatchFor({
      element,
      storyId: story.storyId,
      spec,
      envelope,
    }),
  );
  if (!outcome.applied) {
    reportRefusal(host, label, outcome.error);
    return null;
  }
  host.bindings.publish(BIND_TEXT_ON_PATH_STATUS, null);
  // The story just stopped being free; drop it as the pending pick so
  // the next click does not aim at a story the engine will refuse.
  if (pendingStory === story.storyId) setTextOnPathStory(null);
  host.log.info(
    `${label}: story ${story.storyId} now flows along ${element.kind} ` +
      `${String((element as { id: unknown }).id)}` +
      `${spec.pathTypeAlignment ? ` (${spec.pathTypeAlignment})` : ""}`,
  );
  return {
    story: story.storyId,
    pathTypeAlignment: spec.pathTypeAlignment ?? null,
    flipPathEffect: spec.flipPathEffect ?? null,
    startBracket: spec.startBracket ?? null,
    endBracket: spec.endBracket ?? null,
  };
}

/**
 * DETACH — unlink the text from the path. THE STORY SURVIVES (core's
 * deliberate choice, and the reason this is the exact inverse of attach
 * rather than InDesign's "Delete Type from Path", which also deletes the
 * text). The freed story can be attached to another path.
 *
 * ONE batch ⇒ 1 undo step (measured).
 */
export async function applyDetachTextFromPath(
  host: BundleHost,
  payload?: { elementId?: unknown },
): Promise<boolean> {
  const label = DETACH_TEXT_FROM_PATH_COMMAND_ID;
  if (!(await supportsTextOnPath(host))) {
    host.log.warn(
      `${label}: this host's engine carries no detachTextFromPath op (it ` +
        "predates protocol 58) — type on a path is unavailable here",
    );
    return false;
  }
  const element = resolvePathHost(host, payload);
  if (!element) {
    host.log.warn(
      `${label}: nothing selected and no elementId in the payload — no-op`,
    );
    return false;
  }
  const envelope = await host.document.getMetadata(element).catch(() => null);
  const outcome = await host.document.mutate(
    textOnPathDetachBatchFor({ element, envelope }),
  );
  if (!outcome.applied) {
    reportRefusal(host, label, outcome.error);
    return false;
  }
  host.bindings.publish(BIND_TEXT_ON_PATH_STATUS, null);
  const freed = textOnPathOf(envelope)?.story ?? null;
  host.log.info(
    `${label}: ${element.kind} ${String((element as { id: unknown }).id)} no ` +
      `longer carries text${freed ? ` — story ${freed} is free again` : ""} ` +
      "(the story itself survives; detach unlinks, it does not delete)",
  );
  return true;
}

// ------------------------------------------------------------ commands

const payloadOf = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

/** Register the two type-on-a-path commands. Payloads:
 *  attach `{ elementId?, storyId?, pathTypeAlignment?, flipPathEffect?,
 *  startBracket?, endBracket? }`, detach `{ elementId? }`. */
export function contributeTextOnPathCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: ATTACH_TEXT_TO_PATH_COMMAND_ID,
      title: "Type: Attach story to path (flows an EXISTING story — no story is created)",
      category: TEXT_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyAttachTextToPath(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: DETACH_TEXT_FROM_PATH_COMMAND_ID,
      title: "Type: Detach text from path (the story survives, unflowed)",
      category: TEXT_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDetachTextFromPath(host, payloadOf(payload)).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
