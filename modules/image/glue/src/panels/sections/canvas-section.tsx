// IMAGE ▸ Rotate / Flip / Canvas Size — over the whole layer stack (every
// layer, mask and smart source moves together). Exact pixel moves, each
// one undo step (ADR 463: the history before it is kept).

import type { CanvasOpKind } from "../../engine";
import type { ImageSession } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.canvas", {
  title: "Canvas",
  rotateCcw: "⟲ 90°",
  rotateCw: "⟳ 90°",
  rotate180: "180°",
  flipH: "Flip ↔",
  flipV: "Flip ↕",
  size: "Size",
  anchor: "Anchor",
  applySize: "Apply size",
  note:
    "Rotate, flip and Canvas Size move every layer and mask exactly. Added " +
    "canvas is transparent; cut-off canvas is gone. Each is one undo step.",
});

/** The operations and their message keys (read through `t` at render). */
const OPS: Array<[CanvasOpKind, string]> = [
  ["rotate-ccw", M.rotateCcw],
  ["rotate-cw", M.rotateCw],
  ["rotate-180", M.rotate180],
  ["flip-h", M.flipH],
  ["flip-v", M.flipV],
];

export interface CanvasSize {
  width: number;
  height: number;
  /** 0 = left/top, 1 = centre, 2 = right/bottom. */
  anchorX: number;
  anchorY: number;
}

export function CanvasSection({
  session,
  size,
  onSize,
  disabled,
}: {
  session: ImageSession;
  size: CanvasSize;
  onSize: (s: CanvasSize) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        {OPS.map(([op, label]) => (
          <button
            key={op}
            type="button"
            data-image-canvas-op={op}
            disabled={disabled}
            onClick={() => void session.canvasOp(op)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div style={row}>
        <label htmlFor="pg-image-canvas-w">{t(M.size)}</label>
        <input
          id="pg-image-canvas-w"
          type="number"
          min={1}
          style={{ width: "5em" }}
          value={size.width}
          onChange={(e) => onSize({ ...size, width: Number(e.target.value) })}
        />
        <span style={mono}>×</span>
        <input
          type="number"
          min={1}
          style={{ width: "5em" }}
          value={size.height}
          onChange={(e) => onSize({ ...size, height: Number(e.target.value) })}
        />
      </div>
      <div style={row}>
        <span>{t(M.anchor)}</span>
        <span
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 18px)",
            gap: 2,
          }}
        >
          {[0, 1, 2].flatMap((ay) =>
            [0, 1, 2].map((ax) => (
              <button
                key={`${ax}${ay}`}
                type="button"
                data-image-anchor={`${ax},${ay}`}
                aria-pressed={size.anchorX === ax && size.anchorY === ay}
                style={{ width: 18, height: 18, padding: 0 }}
                onClick={() => onSize({ ...size, anchorX: ax, anchorY: ay })}
              >
                {size.anchorX === ax && size.anchorY === ay ? "●" : ""}
              </button>
            )),
          )}
        </span>
        <button
          type="button"
          data-image-canvas-size
          disabled={disabled || size.width < 1 || size.height < 1}
          onClick={() => void session.canvasOp("canvas", size)}
        >
          {t(M.applySize)}
        </button>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
