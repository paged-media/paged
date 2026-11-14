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

// The precision magnifier (the UX strategy's §7.1; paged.draw ADR 370): a
// loupe over the canvas while an anchor is placed or dragged. Held
// Control with a tool that places or drags anchors in hand (the Pen,
// Direct Selection, Curvature, the anchor tools) or path editing on, it
// shows the page around the pointer four times larger than the view,
// with a crosshair on the point and the path in progress drawn over it.
//
// It only READS: the pixels are an engine snapshot of the page region
// (the same one the eyedropper and the Info panel sample), so the
// magnifier never moves a point, never takes a key from the tool in
// hand and adds no undo step. One request is in flight at a time and the
// newest pointer position wins. Per editor: its key listener is the
// editor's own (`useEditorKeys`), its pointer the editor's
// `CANVAS_POINTER`.

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { docToViewport, type Camera } from "@paged-media/client";

import { useEditorKeys } from "../state/editor-root";
import { useEditorScope } from "../state/editor-scope";
import { CANVAS_POINTER, type CanvasPointer } from "../state/canvas-pointer";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useOptionalOverlaySignals } from "../state/overlay-signals-context";
import { useOptionalSelection } from "../state/selection-context";
import { useOptionalTool } from "../state/tool-context";
import {
  MAGNIFIER_FACTOR,
  MAGNIFIER_KEY,
  MAGNIFIER_SIZE_PX,
  PRECISION_TOOL_IDS,
  magnifierPlacement,
  magnifierRegion,
  pointInLoupe,
  type PageRegion,
} from "./precision-magnifier-geometry";

interface PrecisionMagnifierProps {
  camera: Camera;
  /** The canvas host's size, CSS px. */
  width: number;
  height: number;
}

/** The magnifier, mounted beside the overlay SVG. Renders nothing until
 *  the key is held with a precision tool in hand. */
export function PrecisionMagnifier(props: PrecisionMagnifierProps) {
  const keys = useEditorKeys();
  const tool = useOptionalTool();
  const selection = useOptionalSelection();
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === MAGNIFIER_KEY) setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === MAGNIFIER_KEY) setHeld(false);
    };
    const offDown = keys.listen("keydown", down);
    const offUp = keys.listen("keyup", up);
    // A key released while the window was elsewhere never reports its
    // keyup: a blur lets go.
    const lose = () => setHeld(false);
    window.addEventListener("blur", lose);
    return () => {
      offDown();
      offUp();
      window.removeEventListener("blur", lose);
    };
  }, [keys]);

  const inHand = tool?.effectiveTool ?? null;
  const eligible =
    (inHand !== null && PRECISION_TOOL_IDS.has(inHand)) ||
    Boolean(selection?.pathEditMode);
  if (!held || !eligible) return null;
  return <Loupe {...props} />;
}

type Shot = {
  pageId: string;
  region: PageRegion;
  bitmap: ImageBitmap;
};

function Loupe({ camera, width, height }: PrecisionMagnifierProps) {
  const scope = useEditorScope();
  const pointerStore = scope.get(CANVAS_POINTER);
  const pointer = useSyncExternalStore(
    pointerStore.subscribe,
    pointerStore.get,
    pointerStore.get,
  );
  const client = useOptionalCanvasClient();
  const signals = useOptionalOverlaySignals();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  // The pointer the next request is for, and the request loop's nudge:
  // one request in flight, the newest position wins, nothing is asked
  // twice for the same place.
  const latest = useRef<CanvasPointer | null>(null);
  const nudge = useRef<(() => void) | null>(null);
  const shown = useRef<ImageBitmap | null>(null);

  const scale = camera.scale;
  const pageId = pointer?.pageId ?? null;
  const at = pointer?.pagePoint ?? null;

  useEffect(() => {
    latest.current = pointer;
    nudge.current?.();
  }, [pointer]);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    let busy = false;
    let asked = "";
    const pump = () => {
      const p = latest.current;
      if (!alive || busy || !p?.pageId || !p.pagePoint) return;
      const key = `${p.pageId}:${p.pagePoint[0].toFixed(2)}:${p.pagePoint[1].toFixed(2)}`;
      if (key === asked) return;
      asked = key;
      busy = true;
      const region = magnifierRegion(p.pagePoint, scale);
      const dpr =
        typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1;
      const px = Math.max(16, Math.round(MAGNIFIER_SIZE_PX * dpr));
      const pid = p.pageId;
      void client
        .requestSnapshot(pid, px, undefined, {
          markers: true,
          clip: region,
          format: "rgba",
        })
        .then(async (snap) => {
          const rgba = snap.rgba;
          if (!alive || !rgba || snap.widthPx <= 0 || snap.heightPx <= 0)
            return;
          const bitmap = await createImageBitmap(
            new ImageData(
              new Uint8ClampedArray(rgba),
              snap.widthPx,
              snap.heightPx,
            ),
          );
          if (!alive) {
            bitmap.close();
            return;
          }
          shown.current?.close();
          shown.current = bitmap;
          setShot({ pageId: pid, region: snap.region ?? region, bitmap });
        })
        .catch(() => {
          /* a snapshot the worker could not answer: the loupe keeps the
             last one (the magnifier is a view, never a blocker) */
        })
        .finally(() => {
          busy = false;
          pump();
        });
    };
    // The page changed under the loupe (the Pen's own commit, an undo):
    // the same place is asked again.
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      ) {
        asked = "";
        pump();
      }
    });
    nudge.current = pump;
    pump();
    return () => {
      alive = false;
      nudge.current = null;
      off();
    };
  }, [client, scale]);

  // Release the last image with the loupe.
  useEffect(
    () => () => {
      shown.current?.close();
      shown.current = null;
    },
    [],
  );

  const preview = signals?.toolPreview ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = canvas.width / MAGNIFIER_SIZE_PX;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MAGNIFIER_SIZE_PX, MAGNIFIER_SIZE_PX);
    ctx.fillStyle = "#e9e9e9";
    ctx.fillRect(0, 0, MAGNIFIER_SIZE_PX, MAGNIFIER_SIZE_PX);
    const showing = shot && shot.pageId === pageId ? shot : null;
    if (showing) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(showing.bitmap, 0, 0, MAGNIFIER_SIZE_PX, MAGNIFIER_SIZE_PX);
      drawPreview(ctx, preview, pageId, showing.region);
    }
    // The crosshair on the point the pointer is over.
    const c =
      showing && at
        ? pointInLoupe(at, showing.region)
        : [MAGNIFIER_SIZE_PX / 2, MAGNIFIER_SIZE_PX / 2];
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    crosshair(ctx, c[0], c[1]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#d6007f";
    crosshair(ctx, c[0], c[1]);
  }, [shot, pageId, at, preview]);

  if (!pointer) return null;
  const screen = docToViewport(
    camera,
    pointer.docPoint[0],
    pointer.docPoint[1],
  );
  const place = magnifierPlacement(screen, { width, height });
  const dpr =
    typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1;
  return (
    <div
      aria-hidden
      data-precision-magnifier={pageId ? "page" : "pasteboard"}
      data-magnifier-factor={MAGNIFIER_FACTOR}
      style={{ ...frameStyle, left: place.left, top: place.top }}
    >
      <canvas
        ref={canvasRef}
        width={Math.round(MAGNIFIER_SIZE_PX * dpr)}
        height={Math.round(MAGNIFIER_SIZE_PX * dpr)}
        style={canvasStyle}
      />
      <span style={badgeStyle}>{`${MAGNIFIER_FACTOR}×`}</span>
    </div>
  );
}

function crosshair(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x - 9, y);
  ctx.lineTo(x - 3, y);
  ctx.moveTo(x + 3, y);
  ctx.lineTo(x + 9, y);
  ctx.moveTo(x, y - 9);
  ctx.lineTo(x, y - 3);
  ctx.moveTo(x, y + 3);
  ctx.lineTo(x, y + 9);
  ctx.stroke();
}

/** The tool's preview (the Pen's run) inside the loupe: its cubic and its
 *  anchors, so the point being placed is seen against its neighbours. */
function drawPreview(
  ctx: CanvasRenderingContext2D,
  preview: unknown,
  pageId: string | null,
  region: PageRegion,
) {
  const shapes = Array.isArray(preview) ? preview : preview ? [preview] : [];
  for (const shape of shapes as Array<Record<string, unknown>>) {
    if (shape.pageId !== pageId || !Array.isArray(shape.anchors)) continue;
    const anchors = shape.anchors as Array<{
      anchor: [number, number];
      left: [number, number];
      right: [number, number];
    }>;
    if (anchors.length === 0) continue;
    const at = (p: [number, number]) => pointInLoupe(p, region);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#d6007f";
    ctx.beginPath();
    const [x0, y0] = at(anchors[0].anchor);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < anchors.length; i++) {
      const a = at(anchors[i - 1].right);
      const b = at(anchors[i].left);
      const p = at(anchors[i].anchor);
      ctx.bezierCurveTo(a[0], a[1], b[0], b[1], p[0], p[1]);
    }
    if (shape.close === true) {
      const a = at(anchors[anchors.length - 1].right);
      const b = at(anchors[0].left);
      ctx.bezierCurveTo(a[0], a[1], b[0], b[1], x0, y0);
    }
    ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const a of anchors) {
      const [x, y] = at(a.anchor);
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeRect(x - 3, y - 3, 6, 6);
    }
  }
}

const frameStyle: CSSProperties = {
  position: "absolute",
  width: MAGNIFIER_SIZE_PX,
  height: MAGNIFIER_SIZE_PX,
  borderRadius: "50%",
  overflow: "hidden",
  pointerEvents: "none",
  boxShadow:
    "0 0 0 2px var(--pg-bg, #fff), 0 0 0 3px var(--pg-border, #888), 0 6px 18px rgba(0,0,0,0.35)",
  zIndex: 5,
};

const canvasStyle: CSSProperties = {
  width: MAGNIFIER_SIZE_PX,
  height: MAGNIFIER_SIZE_PX,
  display: "block",
};

const badgeStyle: CSSProperties = {
  position: "absolute",
  bottom: 14,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "0 5px",
  borderRadius: 6,
  font: "10px var(--font-mono, monospace)",
  background: "var(--pg-bg, #fff)",
  color: "var(--pg-fg, #111)",
  opacity: 0.85,
};
