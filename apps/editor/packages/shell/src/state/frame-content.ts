/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Frame, Content, Edit (editor ADR 1215; the UX strategy's §3.2; the
// interaction specification's D-05, UXI-CTX-005, UXI-CTX-008, UXI-CTX-013).
//
// A selected frame offers up to three levels of what is being edited:
//
//   Frame    move, resize, rotate, fit and style the frame itself;
//   Content  the picture inside it: move, scale or rotate the placed image
//            while the frame stays (the content grabber's gestures, Phase F
//            and W2.10, as a level of their own);
//   Edit     the module that edits what the frame holds: the image's
//            pixels (the context that declares `editsPlacedImages`), a
//            spreadsheet, a web frame — named as its module names it.
//
// A double-click on a picture frame enters Content first; "Edit image"
// enters the image module explicitly — its level in the context toolbar,
// Enter, or a second double-click (D-05). Content is a host context of its
// own (`IMAGE_CONTENT_CONTEXT`), so it sits on the edit-context stack like
// any other level: the breadcrumb shows it, Escape leaves it, a press
// outside the frame leaves it through the exit resolver (ADR 1214). Each
// drag inside it is one engine gesture and one undo step; the frame never
// moves. Nothing here moves the camera or resizes the canvas (UXI-CTX-008).

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
} from "@paged-media/client";
import { t } from "@paged-media/strings";

import { FRAME_CONTENT } from "../chrome/messages";
import {
  escapeArbiterOf,
  type EscapeArbiter,
} from "../interaction/escape-arbiter";
import { scoped, type EditorScope } from "./editor-scope";
import type { EditContextContribution } from "../registries/edit-context";
import { contextLabel, type EditContextFrame } from "./edit-context-store";

/** The host's content level of a picture frame: the placed image moves
 *  inside the frame. */
export const IMAGE_CONTENT_CONTEXT = "paged.imageContent";

export type FrameLevelId = "frame" | "content" | "edit";

export interface FrameLevel {
  id: FrameLevelId;
  /** The level as the user reads it ("Frame", "Content", "Edit image",
   *  "Spreadsheet"). */
  label: string;
  /** The edit-context type entered at this level (null: the frame). */
  contextType: string | null;
}

export interface FrameContentFacts {
  /** The frame holds a placed image. */
  hasImage: boolean;
  /** The registered context that edits a placed image's pixels. */
  imageEditor: Pick<EditContextContribution, "type" | "label"> | null;
  /** The module context that owns the frame's content (an object type's
   *  claim), when it is not the image editor. */
  owner: Pick<EditContextContribution, "type" | "label"> | null;
}

/** The registered context that edits placed images (D-05), if any. */
export function imageEditorOf(
  contexts: readonly EditContextContribution[],
): EditContextContribution | null {
  return contexts.find((c) => c.editsPlacedImages === true) ?? null;
}

/** The levels a frame offers. A frame with nothing inside to edit offers
 *  the frame alone. */
export function frameLevels(facts: FrameContentFacts): FrameLevel[] {
  const levels: FrameLevel[] = [
    { id: "frame", label: t(FRAME_CONTENT.frame), contextType: null },
  ];
  if (facts.owner) {
    levels.push({
      id: "edit",
      label: contextLabel(facts.owner),
      contextType: facts.owner.type,
    });
    return levels;
  }
  if (facts.hasImage) {
    levels.push({
      id: "content",
      label: t(FRAME_CONTENT.content),
      contextType: IMAGE_CONTENT_CONTEXT,
    });
    if (facts.imageEditor)
      levels.push({
        id: "edit",
        label: t(FRAME_CONTENT.editImage),
        contextType: facts.imageEditor.type,
      });
  }
  return levels;
}

function sameElement(a: ElementId, b: ElementId): boolean {
  const x = a as unknown as { kind?: string; id?: unknown };
  const y = b as unknown as { kind?: string; id?: unknown };
  return x.kind === y.kind && String(x.id) === String(y.id);
}

/** The level the stack is at for `frame`: the innermost entered context on
 *  it that is one of its levels, else the frame. */
export function currentFrameLevel(
  levels: readonly FrameLevel[],
  stack: readonly EditContextFrame[],
  frame: ElementId,
): FrameLevelId {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]!;
    if (!sameElement(entry.scopeRoot, frame)) continue;
    const level = levels.find((l) => l.contextType === entry.type);
    if (level) return level.id;
  }
  return "frame";
}

/** The stack depth at which `frame`'s own levels begin: leaving to it
 *  returns to the frame level. */
export function frameLevelDepth(
  stack: readonly EditContextFrame[],
  frame: ElementId,
): number {
  const at = stack.findIndex((entry) => sameElement(entry.scopeRoot, frame));
  return at < 0 ? stack.length : at;
}

// ── the content level of a picture frame ────────────────────────────

/** What the content level needs from the editor. */
export interface ImageContentDeps {
  client(): CanvasClient | null;
  /** The camera's scale now (CSS px per point). */
  cameraScale(): number;
  /** The editor's Escape arbiter: a drag registers its cancel there. */
  arbiter(): EscapeArbiter | null;
  /** Called after a drag committed, with the frame's fresh geometry. */
  onCommitted(geometry: ElementGeometryItem[]): void;
}

/** The descent `scope`'s content level offers (the controller's Enter: to
 *  Edit image), when `contribution` is that level. */
export function descendOf(
  scope: EditorScope,
  contribution: EditContextContribution | null,
): ((frame: ElementId) => void) | null {
  const level = imageContentLevelOf(scope);
  return contribution !== null && contribution === level.contribution
    ? (frame) => level.descend(frame)
    : null;
}

type ContentGesture = "translateContent" | "scaleContent" | "rotateContent";

/** How far (CSS px) a press travels before it is a drag: a click, or the
 *  double-click that asks for Edit image, moves no picture. */
const DRAG_THRESHOLD_PX = 3;

interface Drag {
  /** The engine gesture, once the press became a drag. */
  handle: Promise<number | null> | null;
  start: [number, number];
  delta: [number, number];
  modifiers: { shift: boolean; alt: boolean };
  release: () => void;
  ended: boolean;
}

/**
 * The content level of a picture frame as an edit-context contribution.
 * The canvas delivers presses inside the frame (K-1); the drag follows the
 * pointer anywhere on screen from there (window listeners), so the picture
 * can be pulled well past the frame's edge. Plain drag moves the picture,
 * Alt scales it, Shift rotates it (the content grabber's Cmd chords,
 * without Cmd). Escape during a drag puts it back.
 */
export function createImageContentContext(
  deps: ImageContentDeps,
): EditContextContribution {
  let drag: Drag | null = null;
  let entered: ElementId | null = null;
  let lastDown: { x: number; y: number } | null = null;
  let offDown: (() => void) | null = null;

  const pageDelta = (clientX: number, clientY: number): [number, number] => {
    const scale = deps.cameraScale() || 1;
    if (!lastDown) return [0, 0];
    return [(clientX - lastDown.x) / scale, (clientY - lastDown.y) / scale];
  };

  const end = (how: "commit" | "cancel", frame: ElementId) => {
    const d = drag;
    if (!d || d.ended) return;
    d.ended = true;
    drag = null;
    d.release();
    const client = deps.client();
    // A press that never travelled is a click: no gesture, no step.
    if (!d.handle) return;
    void d.handle.then(async (handle) => {
      if (handle === null || !client) return;
      if (how === "cancel") {
        await client.cancelGesture(handle).catch(() => {});
        return;
      }
      await client
        .updateGesture(handle, d.delta, d.modifiers, "json")
        .catch(() => {});
      await client.commitGesture(handle).catch(() => {});
      const geom = await client.elementGeometry([frame]).catch(() => []);
      deps.onCommitted(geom);
    });
  };

  const contribution: EditContextContribution = {
    type: IMAGE_CONTENT_CONTEXT,
    entry: "doubleClick",
    // Entered by the host's own frame levels, never by a module matcher.
    matches: () => false,
    label: t(FRAME_CONTENT.imageContent),
    // Every drag is its own committed gesture: nothing is ever in flight
    // when the level is left.
    exitPolicy: "commit-if-safe",
    onEnter: (ctx) => {
      entered = ctx.id;
      if (typeof window === "undefined") return;
      const onDown = (e: PointerEvent) => {
        lastDown = { x: e.clientX, y: e.clientY };
      };
      window.addEventListener("pointerdown", onDown, true);
      offDown = () => window.removeEventListener("pointerdown", onDown, true);
    },
    onExit: (ctx) => {
      offDown?.();
      offDown = null;
      end("cancel", ctx.id);
      entered = null;
    },
    onContentPointerDown: (e) => {
      const frame = entered;
      if (e.button !== 0 || drag || !lastDown || !frame) return;
      const client = deps.client();
      if (!client) return;
      const kind: ContentGesture = e.modifiers.alt
        ? "scaleContent"
        : e.modifiers.shift
          ? "rotateContent"
          : "translateContent";
      const modifiers = { shift: e.modifiers.shift, alt: e.modifiers.alt };
      const begin = async (): Promise<number | null> => {
        const geom = (await client.elementGeometry([frame]))[0];
        const anchor = geom?.pageId
          ? {
              pageId: geom.pageId,
              pointInPage: contentToPage(geom, e.contentPoint),
            }
          : null;
        return client.beginGesture([frame], { kind }, anchor, modifiers);
      };
      const down = lastDown;
      const onMove = (ev: PointerEvent) => {
        const d = drag;
        if (!d) return;
        if (!d.handle) {
          const far =
            Math.hypot(ev.clientX - down.x, ev.clientY - down.y) >=
            DRAG_THRESHOLD_PX;
          if (!far) return;
          d.handle = begin().catch(() => null);
        }
        d.delta = pageDelta(ev.clientX, ev.clientY);
        d.modifiers = { shift: ev.shiftKey, alt: ev.altKey };
        void d.handle.then((h) => {
          if (h !== null && drag === d)
            void client.updateGesture(h, d.delta, d.modifiers).catch(() => {});
        });
      };
      const onUp = () => end("commit", frame);
      const onCancel = () => end("cancel", frame);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      const offEscape =
        deps.arbiter()?.register({
          id: "paged.imageContent.drag",
          tier: "gesture",
          isActive: () => drag !== null,
          resolve: () => end("cancel", frame),
        }) ?? (() => {});
      drag = {
        handle: null,
        start: e.contentPoint,
        delta: [0, 0],
        modifiers,
        ended: false,
        release: () => {
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          offEscape();
        },
      };
    },
  };
  return contribution;
}

/** A frame-content point back on the page (the inverse of
 *  `pageToContentPoint`). */
export function contentToPage(
  geom: Pick<ElementGeometryItem, "bounds" | "itemTransform">,
  content: [number, number],
): [number, number] {
  const [top, left] = geom.bounds;
  const bx = content[0] + left;
  const by = content[1] + top;
  const m = geom.itemTransform;
  if (!m) return [bx, by];
  const [a, b, c, d, e, f] = m;
  return [a * bx + c * by + e, b * bx + d * by + f];
}

// ── one content level per editor ────────────────────────────────────

/** What the editor wires into its content level while it is mounted. */
export interface ContentLevelWiring {
  client: CanvasClient;
  onCommitted(geometry: ElementGeometryItem[]): void;
  descend(frame: ElementId): void;
}

/** An editor's picture-frame content level (ADR 277: per instance). */
export interface ContentLevel {
  readonly contribution: EditContextContribution;
  wire(wiring: ContentLevelWiring): void;
  /** Enter the Edit level of `frame` (Enter on the content level). */
  descend(frame: ElementId): void;
}

const CONTENT_LEVEL = scoped("imageContentLevel", (scope): ContentLevel => {
  let wired: ContentLevelWiring | null = null;
  const contribution = createImageContentContext({
    client: () => wired?.client ?? null,
    cameraScale: () => cameraScaleOf(wired?.client ?? null),
    arbiter: () => escapeArbiterOf(scope),
    onCommitted: (geometry) => wired?.onCommitted(geometry),
  });
  return {
    contribution,
    wire(next) {
      wired = next;
    },
    descend: (frame) => wired?.descend(frame),
  };
});

/** `scope`'s picture-frame content level. */
export function imageContentLevelOf(scope: EditorScope): ContentLevel {
  return scope.get(CONTENT_LEVEL);
}

function cameraScaleOf(client: CanvasClient | null): number {
  if (!client) return 1;
  try {
    return client.camera.read().scale || 1;
  } catch {
    return 1;
  }
}
