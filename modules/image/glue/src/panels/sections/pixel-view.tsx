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

// The pixel view (image ADR 487; the UX strategy's §7.2: "native
// pixel-resolution inspection"): the placed picture's OWN pixels, one
// image pixel to one screen pixel at 100 %, around the pointer while it
// is over the image (else around the last place, the image's centre at
// first), magnified to 200, 400 or 800 % with a pixel grid at 800 %. The
// canvas shows the picture at the layout's size, which is rarely its
// pixels' size; here the pixels themselves are seen, with the size and
// the resolution the layout gives them. A read: it changes nothing.

import { useEffect, useRef, useState } from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import type { ImageSession } from "../../session";
import { Section } from "./disclosure";
import { mono, note, row } from "./styles";

const M = defineMessages("image.pixelView", {
  title: "Pixels at 100 %",
  zoom: "Magnification",
  size: "{width} × {height} px",
  resolution: "{ppi} ppi in the layout",
  at: "x {x}, y {y}",
  note: "The image's own pixels, one to a screen pixel at 100 %, around the pointer while it is over the image. Nothing is changed.",
  empty: "Open or place an image to see its pixels.",
});

/** The view's size in CSS px. */
export const PIXEL_VIEW_W = 216;
export const PIXEL_VIEW_H = 132;
export const PIXEL_ZOOMS = [1, 2, 4, 8] as const;

/** The image rectangle (image px) the view shows around `center` at
 *  `zoom` (device px per image px), clamped inside the image. */
export function pixelViewRect(
  center: readonly [number, number],
  zoom: number,
  dpr: number,
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const w = Math.max(1, Math.floor((PIXEL_VIEW_W * dpr) / zoom));
  const h = Math.max(1, Math.floor((PIXEL_VIEW_H * dpr) / zoom));
  const x = Math.round(center[0] - w / 2);
  const y = Math.round(center[1] - h / 2);
  return {
    x: Math.max(0, Math.min(x, Math.max(0, image.width - w))),
    y: Math.max(0, Math.min(y, Math.max(0, image.height - h))),
    width: Math.min(w, image.width),
    height: Math.min(h, image.height),
  };
}

export function PixelViewSection({ session }: { session: ImageSession }) {
  const live = useLive(session, onDidChangeOf);
  const st = live.state();
  const cursor = live.workspace().state().cursor;
  const src = st.source;
  const [zoom, setZoom] = useState<number>(1);
  const [held, setHeld] = useState<[number, number] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const center: [number, number] | null = cursor
    ? [cursor.at[0], cursor.at[1]]
    : (held ?? (src ? [src.width / 2, src.height / 2] : null));
  // The place last pointed at stays in view when the pointer leaves
  // (state that follows the pointer, moved during render).
  const cx = cursor ? Math.floor(cursor.at[0]) : null;
  const cy = cursor ? Math.floor(cursor.at[1]) : null;
  if (cx !== null && cy !== null && (held?.[0] !== cx || held?.[1] !== cy))
    setHeld([cx, cy]);

  const width = src?.width ?? 0;
  const height = src?.height ?? 0;
  const centerX = center?.[0] ?? 0;
  const centerY = center?.[1] ?? 0;
  // Any session change may have changed the pixels (a stroke, a filter
  // preview): the view reads them again.
  const revision = st;
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width <= 0 || height <= 0) return;
    const dpr = canvas.width / PIXEL_VIEW_W;
    const rect = pixelViewRect([centerX, centerY], zoom, dpr, {
      width,
      height,
    });
    const px = session.readPixels(rect.x, rect.y, rect.width, rect.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!px) return;
    const tile = document.createElement("canvas");
    tile.width = px.width;
    tile.height = px.height;
    tile
      .getContext("2d")
      ?.putImageData(
        new ImageData(new Uint8ClampedArray(px.rgba), px.width, px.height),
        0,
        0,
      );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tile, 0, 0, px.width * zoom, px.height * zoom);
    if (zoom >= 8) {
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= px.width; i++) {
        ctx.moveTo(i * zoom + 0.5, 0);
        ctx.lineTo(i * zoom + 0.5, px.height * zoom);
      }
      for (let j = 0; j <= px.height; j++) {
        ctx.moveTo(0, j * zoom + 0.5);
        ctx.lineTo(px.width * zoom, j * zoom + 0.5);
      }
      ctx.stroke();
    }
  }, [session, width, height, centerX, centerY, zoom, revision]);

  const dpr =
    typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1;
  const ppi = st.ptPerPx && st.ptPerPx > 0 ? Math.round(72 / st.ptPerPx) : null;
  return (
    <Section title={t(M.title)} open={false} data-image-pixel-view>
      {!src ? (
        <div style={note}>{t(M.empty)}</div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            width={Math.round(PIXEL_VIEW_W * dpr)}
            height={Math.round(PIXEL_VIEW_H * dpr)}
            data-pixel-view-canvas
            data-pixel-zoom={zoom}
            data-pixel-center={
              center ? `${Math.floor(center[0])},${Math.floor(center[1])}` : ""
            }
            style={{
              width: PIXEL_VIEW_W,
              height: PIXEL_VIEW_H,
              display: "block",
              border: `1px solid ${color.border}`,
              imageRendering: "pixelated",
            }}
          />
          <div style={{ ...row, borderBottom: "none" }}>
            <label style={{ font: `11px ${font.sans}` }}>
              {t(M.zoom)}{" "}
              <select
                data-pixel-view-zoom
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ font: `11px ${font.sans}` }}
              >
                {PIXEL_ZOOMS.map((z) => (
                  <option key={z} value={z}>{`${z * 100} %`}</option>
                ))}
              </select>
            </label>
            <span style={mono} data-pixel-view-size>
              {t(M.size, { width: src.width, height: src.height })}
              {ppi !== null ? ` · ${t(M.resolution, { ppi })}` : ""}
            </span>
          </div>
          {cursor ? (
            <div
              style={{ ...mono, padding: `0 ${space[1]}` }}
              data-pixel-view-at
            >
              {t(M.at, {
                x: Math.floor(cursor.at[0]),
                y: Math.floor(cursor.at[1]),
              })}
              {cursor.rgba
                ? ` · ${cursor.rgba[0]} ${cursor.rgba[1]} ${cursor.rgba[2]}`
                : ""}
            </div>
          ) : null}
          <div style={note}>{t(M.note)}</div>
        </>
      )}
    </Section>
  );
}
