// COLOUR — foreground / background, swap (X) and reset (D), and a
// picker. The picker is the host's colour-picker widget where the host
// offers one (`widgets.colorPicker@1`), else the browser's own colour
// input; Alt-click with a paint tool samples the image into the
// foreground.

import { GRADIENT_KINDS, type GradientKind, type Rgba01 } from "../../engine";
import {
  fromHex,
  SAMPLE_SIZES,
  toHex,
  type ColorPair,
  type ColorSamplerInfo,
  type EyedropperOptions,
  type SampleSize,
} from "../../color-state";
import type { ImageSession } from "../../session";
import { mono, note, row, sectionTitle } from "./styles";
import { color } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

import { gradientKindLabel } from "../../words";

const M = defineMessages("image.color", {
  title: "Colour",
  foreground: "Foreground",
  background: "Background",
  foregroundColour: "Foreground colour",
  backgroundColour: "Background colour",
  swap: "Swap",
  blackWhite: "Black / white",
  fill: "Fill",
  gradientTool: "Gradient tool",
  note:
    "The brush and pencil paint the foreground. Alt-click with either takes " +
    "the image's colour under the pointer (a 3×3 average) as the new " +
    "foreground.",
  eyedropper: "Eyedropper",
  sampleSize: "Sample size",
  pointSample: "Point sample",
  average: "{n} by {n} average",
  sample: "Sample",
  currentLayer: "Current layer",
  allLayers: "All layers",
  samplers: "Colour samplers",
  noSamplers:
    "None placed. The Color Sampler tool fixes up to four points; their colours show here.",
  samplerAt: "#{id} at {x}, {y}",
  offImage: "off the image",
  removeSampler: "Remove sampler {id}",
  clearSamplers: "Clear samplers",
  samplersNote:
    "Listed here because the host Info panel has no door for a plugin's readouts yet.",
});

const swatch = (c: Rgba01) => ({
  width: 28,
  height: 20,
  border: `1px solid ${color.border}`,
  background: `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(
    c[2] * 255,
  )}, ${c[3]})`,
});

/** `data-image-<which>` (built outside the component: the React Compiler
 *  does not lower a computed template-literal key, editor ADR 229). */
function colorAttr(which: string): Record<string, boolean> {
  return { [`data-image-${which}`]: true };
}
export function ColorSection({
  session,
  colors,
  gradientKind,
  eyedropper,
  samplers,
}: {
  session: ImageSession;
  colors: ColorPair;
  /** The gradient tool's shape. */
  gradientKind: GradientKind;
  /** WP4.10 — the Eyedropper's options and the colour samplers. */
  eyedropper?: EyedropperOptions;
  samplers?: readonly ColorSamplerInfo[];
}) {
  const pick = (which: "fg" | "bg") => (hex: string) => {
    const c = fromHex(hex);
    if (!c) return;
    if (which === "fg") session.setForeground(c);
    else session.setBackground(c);
  };
  const HostPicker = session.colorPicker();
  const picker = (which: "fg" | "bg", value: Rgba01) =>
    HostPicker ? (
      <span data-image-host-picker={which}>
        <HostPicker
          value={toHex(value)}
          onChange={pick(which)}
          ariaLabel={t(
            which === "fg" ? M.foregroundColour : M.backgroundColour,
          )}
        />
      </span>
    ) : (
      <input
        id={`pg-image-${which}`}
        type="color"
        {...colorAttr(which)}
        value={toHex(value)}
        onChange={(e) => pick(which)(e.target.value)}
      />
    );
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <label htmlFor="pg-image-fg">{t(M.foreground)}</label>
        <span style={swatch(colors.fg)} data-image-fg-swatch />
        {picker("fg", colors.fg)}
        <span style={mono}>{toHex(colors.fg)}</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-bg">{t(M.background)}</label>
        <span style={swatch(colors.bg)} data-image-bg-swatch />
        {picker("bg", colors.bg)}
        <span style={mono}>{toHex(colors.bg)}</span>
      </div>
      <div style={row}>
        <button
          type="button"
          data-image-swap-colors
          onClick={() => session.swapColors()}
        >
          {t(M.swap)}
        </button>
        <button
          type="button"
          data-image-reset-colors
          onClick={() => session.resetColors()}
        >
          {t(M.blackWhite)}
        </button>
        <button
          type="button"
          data-image-fill-fg
          onClick={() => void session.fillForeground()}
        >
          {t(M.fill)}
        </button>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-gradient-kind">{t(M.gradientTool)}</label>
        <select
          id="pg-image-gradient-kind"
          data-image-gradient-kind
          value={gradientKind}
          onChange={(e) =>
            session.setGradientKind(e.target.value as GradientKind)
          }
        >
          {GRADIENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {gradientKindLabel(k)}
            </option>
          ))}
        </select>
      </div>
      <div style={note}>{t(M.note)}</div>
      {eyedropper && (
        <>
          <div style={sectionTitle}>{t(M.eyedropper)}</div>
          <div style={row}>
            <label htmlFor="pg-image-sample-size">{t(M.sampleSize)}</label>
            <select
              id="pg-image-sample-size"
              data-image-sample-size
              value={String(eyedropper.size)}
              onChange={(e) =>
                session.setEyedropperOptions({
                  size: Number(e.target.value) as SampleSize,
                })
              }
            >
              {SAMPLE_SIZES.map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? t(M.pointSample) : t(M.average, { n })}
                </option>
              ))}
            </select>
          </div>
          <div style={row}>
            <label htmlFor="pg-image-sample-source">{t(M.sample)}</label>
            <select
              id="pg-image-sample-source"
              data-image-sample-source
              value={eyedropper.source}
              onChange={(e) =>
                session.setEyedropperOptions({
                  source: e.target.value === "layer" ? "layer" : "all",
                })
              }
            >
              <option value="layer">{t(M.currentLayer)}</option>
              <option value="all">{t(M.allLayers)}</option>
            </select>
          </div>
        </>
      )}
      {samplers && (
        <>
          <div style={sectionTitle}>{t(M.samplers)}</div>
          {samplers.length === 0 ? (
            <div style={note} data-image-samplers-empty>
              {t(M.noSamplers)}
            </div>
          ) : (
            samplers.map((sm) => (
              <div key={sm.id} style={row} data-image-sampler={sm.id}>
                <span style={mono}>
                  {t(M.samplerAt, { id: sm.id, x: sm.at[0], y: sm.at[1] })}
                </span>
                {sm.colour ? (
                  <>
                    <span style={swatch(sm.colour)} />
                    <span style={mono} data-image-sampler-value>
                      {toHex(sm.colour)}{" "}
                      {sm.colour
                        .slice(0, 3)
                        .map((v) => Math.round(v * 255))
                        .join(" ")}
                    </span>
                  </>
                ) : (
                  <span style={mono}>{t(M.offImage)}</span>
                )}
                <button
                  type="button"
                  aria-label={t(M.removeSampler, { id: sm.id })}
                  data-image-sampler-remove={sm.id}
                  onClick={() => session.removeColorSampler(sm.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}
          {samplers.length > 0 && (
            <div style={row}>
              <button
                type="button"
                data-image-samplers-clear
                onClick={() => session.clearColorSamplers()}
              >
                {t(M.clearSamplers)}
              </button>
            </div>
          )}
          <div style={note}>{t(M.samplersNote)}</div>
        </>
      )}
    </>
  );
}
