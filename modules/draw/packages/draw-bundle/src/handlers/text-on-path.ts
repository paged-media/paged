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

// The TYPE ON A PATH tool — a CLICK tool on the `handlers/eyedropper.ts`
// pattern: click a path, and the resolved story flows along it.
//
//   · plain click on a Rectangle / GraphicLine / Polygon → ATTACH
//     (one batch ⇒ 1 undo step — `commands/text-on-path.ts` has the
//     measurements and the whole honest scope);
//   · ALT+click on a path that already carries text → DETACH, the exact
//     inverse, story preserved. Alt is the modifier this repo already
//     uses for "the other half of the gesture" (Shape Builder subtract,
//     eyedropper sample-only);
//   · click on empty canvas → a debug no-op.
//
// WHICH STORY: `resolveAttachStory` — the pending story a panel/command
// set, else the ONLY free story, else a refusal that NAMES the workflow
// producing one. It never guesses between several free stories: putting
// the wrong text on a path is silent damage, and there is no per-tool
// option surface in the v0 tool contract to disambiguate with.
//
// WHY THERE IS NO HOVER PREVIEW: previewing would mean laying the run
// out along the path, which is the RENDERER's text-path pass — the
// overlay tool-preview takes anchors, not shaped glyphs, so anything
// drawn here would be a decorative line that does not predict the
// result. The tool publishes the resolved story id on
// `media.paged.draw.textOnPathStory` instead, which is a claim it can
// actually keep.
//
// KIND GATE: a text frame under the click is REFUSED with the reason
// (its glyphs come from the story pass, so hosting a second flow would
// render a lie), and so is anything else core does not accept — but the
// gate that DECIDES is still the engine's: the tool only pre-explains
// the likely refusal for the kinds it can name locally, and every other
// case rides the op and reports the engine's own sentence.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";

import {
  BIND_TEXT_ON_PATH_STORY,
  TEXT_ON_PATH_KINDS,
  applyAttachTextToPath,
  applyDetachTextFromPath,
  resolveAttachStory,
  textOnPathOf,
} from "../commands/text-on-path";

/** The label every log line from this tool carries. */
export const TYPE_ON_PATH_LABEL = "typeOnPath";

/** Why a clicked element cannot host type on a path, or null when it
 *  can (or when only the engine can say). Pure — exported so the
 *  conformance spec pins the TextFrame wording without a round trip. */
export function pathHostRefusal(kind: string): string | null {
  if (TEXT_ON_PATH_KINDS.has(kind)) return null;
  if (kind === "textFrame") {
    return (
      "a text frame cannot host type on a path — its glyphs are emitted by the " +
      "STORY pass, so a second flow on the same frame would render a lie. " +
      "Click a rectangle, graphic line or polygon"
    );
  }
  if (kind === "oval") {
    return (
      "an oval cannot host type on a path — the model gives ovals no text_paths " +
      "field and the renderer's text-path pass never walks them, so the link " +
      "would draw nothing. Click a rectangle, graphic line or polygon"
    );
  }
  return (
    `a ${kind} cannot host type on a path (Rectangle / GraphicLine / Polygon ` +
    "only — those are the kinds the renderer's text-path pass walks)"
  );
}

/**
 * Build the Type-on-a-Path click handler (B-17: every engine touch
 * rides the `host.*` facades — hitTest / getMetadata / mutate).
 */
export function createTypeOnPathHandler(host: BundleHost): GestureHandler {
  let subs: Disposable[] = [];

  /** Publish what a click WOULD place, so the readout is honest before
   *  the click rather than after. One document read per refresh, so it
   *  runs on activate + on document change — never per pointermove. */
  const refreshStory = async (): Promise<void> => {
    const resolved = await resolveAttachStory(host);
    host.bindings.publish(
      BIND_TEXT_ON_PATH_STORY,
      resolved.storyId === null ? null : resolved.storyId,
    );
  };

  const act = async (e: CanvasPointerEvent): Promise<void> => {
    if (!e.pageId || !e.pagePoint) return;
    let hit: ElementId | null = null;
    try {
      hit = (await host.document.hitTest(e.pageId, e.pagePoint, "frame"))
        ?.element ?? null;
    } catch {
      hit = null;
    }
    if (!hit) {
      host.log.debug(`${TYPE_ON_PATH_LABEL}: nothing under the click — no-op`);
      return;
    }
    const refusal = pathHostRefusal(hit.kind);
    if (refusal) {
      host.log.warn(`${TYPE_ON_PATH_LABEL}: ${refusal}`);
      return;
    }
    const env = await host.document.getMetadata(hit).catch(() => null);
    const existing = textOnPathOf(env);
    if (e.modifiers.alt) {
      // ALT = the inverse half of the gesture.
      if (!existing) {
        host.log.debug(
          `${TYPE_ON_PATH_LABEL}: alt+click detaches, but this path carries no ` +
            "text — no-op",
        );
        return;
      }
      await applyDetachTextFromPath(host, { elementId: hit });
      await refreshStory();
      return;
    }
    if (existing) {
      host.log.warn(
        `${TYPE_ON_PATH_LABEL}: this path already carries story ` +
          `${existing.story} — one story per path here (the wire's detach ` +
          "takes slot 0, so a second entry would be unreachable). Alt+click to " +
          "detach it first",
      );
      return;
    }
    await applyAttachTextToPath(host, { elementId: hit });
    await refreshStory();
  };

  return {
    onActivate() {
      subs = [host.document.onDidChange(() => void refreshStory())];
      void refreshStory();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      for (const s of subs) s.dispose();
      subs = [];
      host.bindings.publish(BIND_TEXT_ON_PATH_STORY, null);
    },
    onPointerDown() {
      // The commit rides pointer UP, so a drag that starts on a path and
      // ends elsewhere is not a silent attach.
    },
    onPointerMove() {
      // No hover preview — see the module header.
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (e.button !== 0) return;
      void act(e);
    },
  };
}
