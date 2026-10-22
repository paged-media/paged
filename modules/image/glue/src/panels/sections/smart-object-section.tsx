// SMART OBJECT — convert the active layer, and re-render it at a new
// scale FROM ITS PRESERVED SOURCE (never from the already-scaled pixels).

import type { ImageSession } from "../../session";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.smartObject", {
  title: "Smart object",
  convert: "Convert active layer",
  smart: "smart",
  pixels: "pixels",
  scale: "Scale",
  render: "Render",
  note:
    "A smart object keeps its original pixels. Scaling re-renders from them, " +
    "so shrinking and then enlarging again loses nothing.",
});

export function SmartObjectSection({
  session,
  active,
  isSmart,
  gpu,
  disabled,
  scale,
  onScale,
}: {
  session: ImageSession;
  active: number;
  isSmart: boolean;
  gpu: boolean;
  disabled: boolean;
  scale: number;
  onScale: (v: number) => void;
}) {
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <button
          type="button"
          data-image-make-smart
          disabled={disabled || active < 0 || isSmart}
          onClick={() => void session.makeLayerSmart(active)}
        >
          {t(M.convert)}
        </button>
        <span style={mono}>{t(isSmart ? M.smart : M.pixels)}</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-smart-scale">{t(M.scale)}</label>
        <input
          id="pg-image-smart-scale"
          type="range"
          min={0.1}
          max={2}
          step={0.05}
          value={scale}
          disabled={!isSmart}
          onChange={(e) => onScale(Number(e.target.value))}
        />
        <span style={mono}>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          data-image-render-smart
          disabled={disabled || !isSmart || !gpu}
          onClick={() => void session.renderLayerSmart(active, scale)}
        >
          {t(M.render)}
        </button>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
