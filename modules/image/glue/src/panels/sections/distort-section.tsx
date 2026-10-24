// FILTER ▸ Distort — the parametric distortions (geom.warp_backward:
// pinch, spherize, twirl, wave) and Glass (gallery.glass), each with its
// own parameters. Every one lands like a fill: into the active layer,
// journaled and selection-masked. Amount 0 is the identity for every
// warp kind, so the sliders need no special cases.

import { WARP_KINDS, type WarpKindName } from "../../engine";
import type { ImageSession } from "../../session";
import { warpKindLabel } from "../../words";
import { defineMessages, t } from "@paged-media/strings";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.distort", {
  title: "Distort",
  amount: "Amount",
  frequency: "Frequency",
  apply: "Apply {kind}",
  applyTitle: "Apply the {kind} distortion (amount 0 is the identity)",
  glass: "Glass",
  glassScale: "Glass size",
  glassDistortion: "Glass distortion",
  applyGlass: "Apply glass",
  glassTitle:
    "Refraction-style displacement through a procedural normal field.",
  note:
    "Each distortion resamples through one backward map, so they share a " +
    "reconstruction filter and edge rule with the crop straighten. Pinch " +
    "and spherize push outward at a negative amount; twirl's amount is " +
    "its angle at the centre in radians.",
});

/** One kind's slider range. */
interface Range {
  min: number;
  max: number;
  step: number;
}

/** Per kind: twirl's amount is an angle (radians), wave's a fraction of
 *  the radius; pinch and spherize are normalized to ±1. */
export const WARP_RANGES: Record<WarpKindName, Range> = {
  pinch: { min: -1, max: 1, step: 0.05 },
  spherize: { min: -1, max: 1, step: 0.05 },
  twirl: { min: -6.28, max: 6.28, step: 0.05 },
  wave: { min: -2, max: 2, step: 0.05 },
};

export interface DistortParams {
  kind: WarpKindName;
  /** Each kind keeps its own amount. */
  amount: Record<WarpKindName, number>;
  /** Wave periods across the radius (wave only). */
  frequency: number;
  /** Glass surface feature size (px). */
  glassScale: number;
  /** Glass maximum displacement (px). */
  glassDistortion: number;
}

export const DISTORT_DEFAULTS: DistortParams = {
  kind: "pinch",
  amount: { pinch: 0.4, spherize: 0.4, twirl: 1.5, wave: 0.4 },
  frequency: 1,
  glassScale: 24,
  glassDistortion: 6,
};

export function DistortSection({
  session,
  params,
  onParams,
  disabled,
}: {
  session: ImageSession;
  params: DistortParams;
  onParams: (p: DistortParams) => void;
  disabled: boolean;
}) {
  const { kind } = params;
  const range = WARP_RANGES[kind];
  const amount = params.amount[kind];
  const label = warpKindLabel(kind);
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row} role="group" aria-label={t(M.title)}>
        {WARP_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            data-image-warp-kind={k}
            aria-pressed={k === kind}
            onClick={() => onParams({ ...params, kind: k })}
          >
            {warpKindLabel(k)}
          </button>
        ))}
      </div>
      <div style={row}>
        <label htmlFor="pg-image-warp-amount">{t(M.amount)}</label>
        <input
          id="pg-image-warp-amount"
          data-image-warp-amount
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={amount}
          onChange={(e) =>
            onParams({
              ...params,
              amount: { ...params.amount, [kind]: Number(e.target.value) },
            })
          }
        />
        <span style={mono}>{amount.toFixed(2)}</span>
      </div>
      {kind === "wave" && (
        <div style={row}>
          <label htmlFor="pg-image-warp-frequency">{t(M.frequency)}</label>
          <input
            id="pg-image-warp-frequency"
            data-image-warp-frequency
            type="range"
            min={0.5}
            max={12}
            step={0.5}
            value={params.frequency}
            onChange={(e) =>
              onParams({ ...params, frequency: Number(e.target.value) })
            }
          />
          <span style={mono}>{params.frequency}</span>
        </div>
      )}
      <div style={row}>
        <button
          type="button"
          data-image-warp={kind}
          disabled={disabled}
          title={t(M.applyTitle, { kind: label })}
          onClick={() =>
            void session.applyWarp(
              kind,
              amount,
              kind === "wave" ? params.frequency : 1,
            )
          }
        >
          {t(M.apply, { kind: label })}
        </button>
      </div>

      <div style={row}>
        <label htmlFor="pg-image-glass-scale">{t(M.glassScale)}</label>
        <input
          id="pg-image-glass-scale"
          data-image-glass-scale
          type="range"
          min={4}
          max={96}
          step={1}
          value={params.glassScale}
          onChange={(e) =>
            onParams({ ...params, glassScale: Number(e.target.value) })
          }
        />
        <span style={mono}>{params.glassScale} px</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-glass-distortion">
          {t(M.glassDistortion)}
        </label>
        <input
          id="pg-image-glass-distortion"
          data-image-glass-distortion
          type="range"
          min={0}
          max={32}
          step={0.5}
          value={params.glassDistortion}
          onChange={(e) =>
            onParams({ ...params, glassDistortion: Number(e.target.value) })
          }
        />
        <span style={mono}>{params.glassDistortion} px</span>
      </div>
      <div style={row}>
        <button
          type="button"
          data-image-glass
          disabled={disabled}
          title={t(M.glassTitle)}
          onClick={() =>
            void session.galleryGlass(
              1,
              params.glassScale,
              params.glassDistortion,
              1,
            )
          }
        >
          {t(M.applyGlass)}
        </button>
      </div>
      <div style={note}>{t(M.note)}</div>
    </>
  );
}
