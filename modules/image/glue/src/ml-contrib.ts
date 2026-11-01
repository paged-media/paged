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

// The ML features' editor reach (WP8.2, image ADR 485): the Select Subject
// and Select Sky commands and the Object Selection tool. Each is gated at
// the call by the host's ML doors; without a model the status line says
// what the registry said.

import type {
  BundleHost,
  CanvasPointerEvent,
  CommandContribution,
  Disposable,
  GestureHandler,
} from "@paged-media/plugin-api";
import { contributeTool } from "@paged-media/plugin-sdk";
import { defineMessages, t } from "@paged-media/strings";

import { pageToImage, imageToPage, resolveFrameFit } from "./frame-fit";
import type { FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";
import { dashedPath } from "./selection-tool";
import { modeFromModifiers } from "./selection-machine";

export const OBJECT_SELECTION_TOOL_ID =
  "media.paged.image.tool.objectSelection";

const CMD = defineMessages("image.command", {
  selectSubject: "Select subject (image)",
  selectSky: "Select sky (image)",
});

const TOOL = defineMessages("image.tool", {
  objectSelection: "Object selection",
});

/** A drag shorter than this many image pixels is a click (a point). */
const CLICK_RADIUS = 3;

export function makeObjectSelectionGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let start: [number, number] | null = null;
  let mode = modeFromModifiers({ shift: false, alt: false });

  const box = (a: [number, number], b: [number, number]) => ({
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  });
  const preview = (b: ReturnType<typeof box> | null) => {
    if (!b || !fit) {
      host.overlay.setToolPreview(null);
      return;
    }
    const corners: Array<[number, number]> = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
    ];
    host.overlay.setToolPreview(
      dashedPath(
        fit.pageId,
        corners.map((p) => imageToPage(fit!, p)),
      ),
    );
  };

  return {
    onActivate() {
      void resolveFrameFit(
        host,
        session.state().source,
        "object selection",
      ).then((f) => {
        fit = f;
      });
    },
    onDeactivate() {
      host.overlay.setToolPreview(null);
      fit = null;
      start = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!fit || !e.pagePoint) return;
      start = pageToImage(fit, e.pagePoint);
      mode = modeFromModifiers(e.modifiers);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!fit || !start || !e.pagePoint) return;
      preview(box(start, pageToImage(fit, e.pagePoint)));
    },
    onPointerUp(e: CanvasPointerEvent) {
      const from = start;
      start = null;
      preview(null);
      if (!fit || !from || !e.pagePoint) return;
      const to = pageToImage(fit, e.pagePoint);
      const b = box(from, to);
      void session.ml().selectObject(
        b.width < CLICK_RADIUS && b.height < CLICK_RADIUS
          ? { point: { x: Math.round(to[0]), y: Math.round(to[1]) } }
          : {
              box: {
                x: Math.round(b.x),
                y: Math.round(b.y),
                width: Math.max(1, Math.round(b.width)),
                height: Math.max(1, Math.round(b.height)),
              },
            },
        mode,
      );
    },
  };
}

export function contributeMl(
  host: BundleHost,
  session: ImageSession,
  command: (c: CommandContribution) => Disposable,
): Disposable {
  const handles: Disposable[] = [];
  handles.push(
    command({
      id: "media.paged.image.command.selectSubject",
      title: t(CMD.selectSubject),
      category: "Image",
      handler: () => {
        void session.ml().selectSubject();
      },
    }),
  );
  handles.push(
    command({
      id: "media.paged.image.command.selectSky",
      title: t(CMD.selectSky),
      category: "Image",
      handler: () => {
        void session.ml().selectSky();
      },
    }),
  );
  handles.push(
    contributeTool(host, {
      id: OBJECT_SELECTION_TOOL_ID,
      title: t(TOOL.objectSelection),
      icon: "tool-magic-wand",
      group: "media.paged.image.tool.magicWand",
      section: "selection",
      gesture: () => makeObjectSelectionGesture(host, session),
    }),
  );
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}
