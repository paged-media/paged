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

// The two LIVE PAINT gesture tools, over ONE handler factory because
// they are one gesture with two commits:
//
//   · BUCKET (`"fill"`)  — hover highlights the face under the cursor
//     through the overlay tool-preview; a click paints it; a drag paints
//     every face it crosses. Commit = the shared `fillLivePaintFaces`
//     lane (2 batches ⇒ 2 undo steps), so the recipe and the artwork
//     always move together.
//   · FACE SELECTION (`"select"`) — the identical resolve/collect, but
//     the commit puts the MATERIALISED FILLS of those faces on the
//     selection so they can be restyled or deleted with the ordinary
//     tools. A face that carries no paint has NO ELEMENT to select — v0
//     has no face object — so the tool publishes the resolved face id on
//     `media.paged.draw.livePaintFace` and says so, rather than looking
//     like a dead click.
//
// EVERY engine touch goes through the shared seam
// (`handlers/planar-regions.ts`): one enumeration per gesture scope,
// cold-start + face-cap point queries, refusals surfaced with the
// engine's own words. This handler adds no round trip of its own.
//
// WHAT THE TOOL OPERATES ON: the RECIPE resolved from the selection (a
// selected member or fill names its group; a document with exactly one
// group falls back to it). That is deliberate — the arrangement is the
// recipe's ORDERED member list, and re-deriving from "whatever is
// selected right now" would silently change the signature basis and
// re-point every recorded face id.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";
import {
  LivePaintMachine,
  type LivePaintSnapshot,
} from "@paged-media/draw-tools";

import {
  BIND_LIVE_PAINT_FACE,
  LIVE_PAINT_DEFAULT_FILL,
  fillLivePaintFaces,
  livePaintInputs,
  livePaintLinks,
  selectedLivePaintGroup,
  type LivePaintRecipe,
} from "../commands/live-paint";
import { createRegionCache, type RegionCache } from "./planar-regions";

/** What a finished gesture does. */
export type LivePaintToolMode = "fill" | "select";

/** The swatch a bucket click paints with. Module state, the
 *  `handlers/eyedropper.ts` precedent: the v0 overlay/tool contract has
 *  no "current fill" to read, and a tool option surface does not exist
 *  yet, so the panel (and any command) sets it here and the tool reads
 *  it. Defaults to the engine's own black. */
let activeFill: string | null = LIVE_PAINT_DEFAULT_FILL;

/** The swatch the bucket will paint with. */
export function getLivePaintFill(): string | null {
  return activeFill;
}

/** Set the swatch the bucket paints with (`null` = no fill). */
export function setLivePaintFill(fill: string | null): void {
  activeFill = fill;
}

/** Build a Live Paint gesture handler bound to `host` (the B-17 factory
 *  shape — every engine touch is a `host.*` facade). */
export function createLivePaintHandler(
  host: BundleHost,
  mode: LivePaintToolMode,
): GestureHandler {
  const label =
    mode === "fill"
      ? "livePaintBucket"
      : "livePaintSelect";
  let machine: LivePaintMachine | null = null;
  let pageId: string | null = null;
  /** The recipe this gesture scope operates on. */
  let group: LivePaintRecipe | null = null;
  /** Its members, as the ordered arrangement basis. */
  let inputs: ElementId[] = [];
  let subs: Disposable[] = [];

  const cache: RegionCache = createRegionCache(host, {
    label,
    onFaces: (faces) => {
      if (machine) render(machine.setRegions(faces));
    },
    onPointFace: (id) => {
      if (machine) render(machine.handle({ type: "region", id }));
    },
  });

  const dropCache = () => {
    cache.drop();
    machine?.setRegions(null);
  };

  const render = (snapshot: LivePaintSnapshot) => {
    host.bindings.publish(BIND_LIVE_PAINT_FACE, snapshot.hovered);
    if (!pageId) {
      host.overlay.setToolPreview(null);
      return;
    }
    const face = snapshot.hovered
      ? cache.faces().find((f) => f.id === snapshot.hovered)
      : undefined;
    if (!face || face.anchors.length < 2) {
      host.overlay.setToolPreview(null);
      return;
    }
    // The face outline, closed — the same highlight the Shape Builder
    // draws, because it is the same cue: "this is the region you are
    // about to act on".
    host.overlay.setToolPreview({
      pageId,
      anchors: face.anchors.map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]] as [number, number],
        left: [a.left[0], a.left[1]] as [number, number],
        right: [a.right[0], a.right[1]] as [number, number],
      })),
      close: true,
    });
  };

  /** Re-resolve which recipe this scope paints. Costs one library read
   *  plus one metadata read per selected element, so it runs on ACTIVATE
   *  and on selection change — never per pointermove. */
  const refreshGroup = async (): Promise<void> => {
    const next = await selectedLivePaintGroup(host);
    if (next?.id === group?.id) return;
    group = next;
    inputs = next ? livePaintInputs(next) : [];
    dropCache();
    if (!next) {
      host.log.debug(
        `${label}: no Live Paint group resolved from the selection — ` +
          "make one (or select one of its members) first",
      );
    }
  };

  const sample = (point: [number, number]): void => {
    if (!machine || inputs.length < 2) return;
    cache.sample(inputs, point);
  };

  /** Paint the faces the gesture collected. */
  const commitFill = async (faces: readonly string[]): Promise<void> => {
    if (!group || faces.length === 0) return;
    const painted = await fillLivePaintFaces(
      host,
      group,
      faces,
      activeFill,
      label,
    );
    if (painted.length > 0) {
      // The arrangement itself did not change (the fills are new artwork
      // ABOVE the members, not new members), but the document did — and
      // the scene-tree diff the emit ran invalidates the cached ids.
      dropCache();
    }
  };

  /** Select the materialised fills of the faces the gesture collected. */
  const commitSelect = async (faces: readonly string[]): Promise<void> => {
    if (!group || faces.length === 0) return;
    const links = await livePaintLinks(host, group.id);
    const chosen = links.fills.filter((f) => faces.includes(f.ref.face));
    const missing = faces.filter(
      (face) => !links.fills.some((f) => f.ref.face === face),
    );
    if (missing.length > 0) {
      host.log.warn(
        `${label}: face(s) ${missing.join(", ")} carry no paint, so there is ` +
          "NOTHING TO SELECT — a face only becomes an element once it is " +
          "filled (v0 has no face object; RFI C-30)",
      );
    }
    await host.selection.set(chosen.map((f) => f.id));
  };

  return {
    onActivate() {
      machine = new LivePaintMachine();
      group = null;
      inputs = [];
      dropCache();
      subs = [
        host.selection.onDidChange(() => void refreshGroup()),
        host.document.onDidChange(() => dropCache()),
      ];
      void refreshGroup();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      for (const s of subs) s.dispose();
      subs = [];
      machine = null;
      pageId = null;
      group = null;
      inputs = [];
      dropCache();
      host.overlay.setToolPreview(null);
      host.bindings.publish(BIND_LIVE_PAINT_FACE, null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!machine || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      pageId = e.pageId;
      render(machine.handle({ type: "down", point: e.pagePoint }));
      sample(e.pagePoint);
    },
    onPointerMove(e: CanvasPointerEvent) {
      // A hover BEFORE any click still highlights — that is half the
      // interaction, so a move outside a gesture is not discarded.
      if (!machine || !e.pagePoint || !e.pageId) return;
      pageId = e.pageId;
      render(machine.handle({ type: "move", point: e.pagePoint }));
      sample(e.pagePoint);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      const snap = machine.handle({ type: "up", point: e.pagePoint });
      host.overlay.setToolPreview(null);
      const faces = [...snap.collected];
      if (faces.length === 0) {
        host.log.debug(`${label}: the gesture crossed no face — no-op`);
        return;
      }
      void (mode === "fill" ? commitFill(faces) : commitSelect(faces));
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && machine) {
        render(machine.handle({ type: "key", key: "Escape" }));
      }
    },
  };
}

/** The Live Paint Bucket handler. */
export const createLivePaintBucketHandler = (host: BundleHost): GestureHandler =>
  createLivePaintHandler(host, "fill");

/** The Live Paint Selection handler. */
export const createLivePaintSelectHandler = (host: BundleHost): GestureHandler =>
  createLivePaintHandler(host, "select");
