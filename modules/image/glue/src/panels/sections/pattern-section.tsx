// PATTERN — Edit ▸ Define Pattern, Edit ▸ Fill ▸ Pattern, and Shape blur,
// which uses the same captured image as its shape. The engine had all
// three (`fillPattern`, `applyShapeBlur`) with no way in.

import type { ImageSession } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.pattern", {
  title: "Pattern",
  define: "Define pattern",
  none: "none",
  scale: "Scale",
  fill: "Fill",
  shapeBlur: "Shape blur",
  blur: "Blur",
  note:
    "Define pattern copies the selection's bounding box (the whole image " +
    "when nothing is selected). The fill tiles it into the selection; Shape " +
    "blur uses its alpha as the blur's shape.",
});

export function PatternSection({
  session,
  pattern,
  gpu,
  disabled,
  scale,
  onScale,
  radius,
  onRadius,
}: {
  session: ImageSession;
  pattern: { width: number; height: number } | null;
  gpu: boolean;
  disabled: boolean;
  scale: number;
  onScale: (v: number) => void;
  radius: number;
  onRadius: (v: number) => void;
}) {
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <button
          type="button"
          data-image-define-pattern
          disabled={disabled}
          onClick={() => session.definePattern()}
        >
          {t(M.define)}
        </button>
        <span style={mono} data-image-pattern-size>
          {pattern ? `${pattern.width}×${pattern.height}` : t(M.none)}
        </span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-pattern-scale">{t(M.scale)}</label>
        <input
          id="pg-image-pattern-scale"
          type="range"
          min={0.25}
          max={4}
          step={0.05}
          value={scale}
          onChange={(e) => onScale(Number(e.target.value))}
        />
        <span style={mono}>{scale.toFixed(2)}×</span>
        <button
          type="button"
          data-image-fill-pattern
          disabled={disabled || !gpu || !pattern}
          onClick={() => void session.fillWithPattern(scale)}
        >
          {t(M.fill)}
        </button>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-shape-blur">{t(M.shapeBlur)}</label>
        <input
          id="pg-image-shape-blur"
          type="range"
          min={1}
          max={32}
          step={1}
          value={radius}
          onChange={(e) => onRadius(Number(e.target.value))}
        />
        <span style={mono}>{radius} px</span>
        <button
          type="button"
          data-image-shape-blur
          disabled={disabled || !gpu || !pattern}
          onClick={() => void session.shapeBlurWithPattern(radius)}
        >
          {t(M.blur)}
        </button>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
