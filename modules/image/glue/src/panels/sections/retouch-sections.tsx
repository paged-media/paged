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

// WP5.8 — the retouching surfaces: the Content-Aware Fill workspace (a
// dialog on the image panel, with its preview), the Content-Aware Move
// and healing option sections, and the Clone Source panel.
//
// Every component here is PURE over the state it is handed; the panel
// factories read the session through a live view (react-live).

import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t } from "@paged-media/strings";

import type {
  CafWorkspace,
  CloneSourceState,
  HealOptions,
  MoveOptions,
  PendingMove,
  CloneSourceSlot,
  CloneOverlayOptions,
} from "../../retouch";
import { CLONE_SOURCE_COUNT } from "../../retouch";
import {
  CAF_OUTPUTS,
  COLOUR_ADAPTATIONS,
  ROTATION_ADAPTATIONS,
  SAMPLE_MODES,
  SPOT_TYPES,
  type CafOutput,
  type CafPreview,
  type ColourAdaptation,
  type FillSettings,
  type RotationAdaptation,
  type SampleMode,
  type SpotType,
} from "../../retouch-engine";
import type { ImageSession } from "../../session";
import { mono, note, panelTitle, row, sectionTitle } from "./styles";

const M = defineMessages("image.caf", {
  title: "Content-Aware Fill",
  samplingArea: "Sampling area",
  auto: "Auto",
  rectangular: "Rectangular",
  custom: "Custom",
  showSampling: "Show sampling area",
  opacity: "Opacity",
  sampled: "{pct} % of the image is sampled",
  sampleAll: "Sample all layers",
  fillSettings: "Fill settings",
  colourAdaptation: "Colour adaptation",
  rotationAdaptation: "Rotation adaptation",
  scale: "Scale",
  mirror: "Mirror",
  output: "Output to",
  preview: "Preview",
  noPreview: "No preview yet.",
  previewNote:
    "The preview is computed on a reduced copy around the selection; OK " +
    "fills at full resolution.",
  brushNote:
    "Paint the sampling area with the Sampling brush (in the healing tools); " +
    "Alt erases.",
  reset: "Reset",
  ok: "OK",
  cancel: "Cancel",
  about:
    "PatchMatch over the sampling area, coarse to fine: the search reaches " +
    "every part of the area, a patch may be rotated, scaled or mirrored as " +
    "allowed, and the same settings give the same fill.",
});

const COLOUR_LABEL = defineMessages("image.cafColour", {
  none: "None",
  default: "Default",
  high: "High",
  "very-high": "Very high",
});
const ROTATION_LABEL = defineMessages("image.cafRotation", {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  full: "Full",
});
const OUTPUT_LABEL = defineMessages("image.cafOutput", {
  current: "Current layer",
  "new-layer": "New layer",
  duplicate: "Duplicate layer",
});
const SAMPLE_LABEL = defineMessages("image.sampleMode", {
  current: "Current layer",
  below: "Current & below",
  all: "All layers",
});
const SPOT_LABEL = defineMessages("image.spotType", {
  "content-aware": "Content-aware",
  "create-texture": "Create texture",
  proximity: "Proximity match",
});

/** Paint a preview into a canvas element (a ref callback). */
function drawPreview(el: HTMLCanvasElement | null, p: CafPreview | null) {
  if (!el || !p) return;
  el.width = p.width;
  el.height = p.height;
  const ctx = el.getContext?.("2d");
  if (!ctx || typeof ImageData === "undefined") return;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height),
    0,
    0,
  );
}

export interface CafPatch {
  sampling?: CafWorkspace["sampling"];
  showSampling?: boolean;
  overlayOpacity?: number;
  sampleAll?: boolean;
  output?: CafOutput;
  fill?: Partial<FillSettings>;
}

/** THE CONTENT-AWARE FILL WORKSPACE — sampling area, fill settings,
 *  output and the preview, with OK / Cancel. */
export function ContentAwareFillWorkspace({
  caf,
  busy,
  onChange,
  onReset,
  onOk,
  onCancel,
}: {
  caf: CafWorkspace;
  busy: boolean;
  onChange: (patch: CafPatch) => void;
  onReset: () => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div data-image-caf-workspace>
      <div style={panelTitle}>{t(M.title)}</div>
      <div style={sectionTitle}>{t(M.samplingArea)}</div>
      <div style={row} role="radiogroup">
        {(
          [
            ["auto", M.auto],
            ["rect", M.rectangular],
            ["custom", M.custom],
          ] as const
        ).map(([v, label]) => (
          <label key={v}>
            <input
              type="radio"
              name="pg-image-caf-sampling"
              data-image-caf-sampling={v}
              checked={caf.sampling === v}
              disabled={busy}
              onChange={() => onChange({ sampling: v })}
            />
            {t(label)}
          </label>
        ))}
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-show">{t(M.showSampling)}</label>
        <input
          id="pg-image-caf-show"
          type="checkbox"
          data-image-caf-show
          checked={caf.showSampling}
          onChange={(e) => onChange({ showSampling: e.target.checked })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-opacity">{t(M.opacity)}</label>
        <input
          id="pg-image-caf-opacity"
          type="range"
          min={0}
          max={100}
          data-image-caf-opacity
          value={Math.round(caf.overlayOpacity * 100)}
          onChange={(e) =>
            onChange({ overlayOpacity: Number(e.target.value) / 100 })
          }
        />
      </div>
      <div style={note} data-image-caf-sampled>
        {t(M.sampled, { pct: Math.round(caf.sampledFraction * 1000) / 10 })}
      </div>
      <div style={note}>{t(M.brushNote)}</div>
      <div style={row}>
        <label htmlFor="pg-image-caf-all">{t(M.sampleAll)}</label>
        <input
          id="pg-image-caf-all"
          type="checkbox"
          data-image-caf-sample-all
          checked={caf.sampleAll}
          onChange={(e) => onChange({ sampleAll: e.target.checked })}
        />
      </div>

      <div style={sectionTitle}>{t(M.fillSettings)}</div>
      <div style={row}>
        <label htmlFor="pg-image-caf-colour">{t(M.colourAdaptation)}</label>
        <select
          id="pg-image-caf-colour"
          data-image-caf-colour
          value={caf.fill.colour}
          onChange={(e) =>
            onChange({ fill: { colour: e.target.value as ColourAdaptation } })
          }
        >
          {COLOUR_ADAPTATIONS.map((v) => (
            <option key={v} value={v}>
              {t(COLOUR_LABEL[v])}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-rotation">{t(M.rotationAdaptation)}</label>
        <select
          id="pg-image-caf-rotation"
          data-image-caf-rotation
          value={caf.fill.rotation}
          onChange={(e) =>
            onChange({
              fill: { rotation: e.target.value as RotationAdaptation },
            })
          }
        >
          {ROTATION_ADAPTATIONS.map((v) => (
            <option key={v} value={v}>
              {t(ROTATION_LABEL[v])}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-scale">{t(M.scale)}</label>
        <input
          id="pg-image-caf-scale"
          type="checkbox"
          data-image-caf-scale
          checked={caf.fill.scale}
          onChange={(e) => onChange({ fill: { scale: e.target.checked } })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-mirror">{t(M.mirror)}</label>
        <input
          id="pg-image-caf-mirror"
          type="checkbox"
          data-image-caf-mirror
          checked={caf.fill.mirror}
          onChange={(e) => onChange({ fill: { mirror: e.target.checked } })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-caf-output">{t(M.output)}</label>
        <select
          id="pg-image-caf-output"
          data-image-caf-output
          value={caf.output}
          onChange={(e) => onChange({ output: e.target.value as CafOutput })}
        >
          {CAF_OUTPUTS.map((v) => (
            <option key={v} value={v}>
              {t(OUTPUT_LABEL[v])}
            </option>
          ))}
        </select>
      </div>

      <div style={sectionTitle}>{t(M.preview)}</div>
      {caf.preview ? (
        <canvas
          data-image-caf-preview
          data-width={caf.preview.width}
          data-height={caf.preview.height}
          style={{ maxWidth: "100%", imageRendering: "auto" }}
          ref={(el) => drawPreview(el, caf.preview)}
        />
      ) : (
        <div style={note} data-image-caf-no-preview>
          {caf.previewNote ?? t(M.noPreview)}
        </div>
      )}
      <div style={note}>{t(M.previewNote)}</div>

      <div style={row}>
        <button
          type="button"
          data-image-caf-reset
          disabled={busy}
          onClick={onReset}
        >
          {t(M.reset)}
        </button>
        <span>
          <button
            type="button"
            data-image-caf-cancel
            disabled={busy}
            onClick={onCancel}
          >
            {t(M.cancel)}
          </button>
          <button
            type="button"
            data-image-caf-ok
            disabled={busy}
            onClick={onOk}
          >
            {t(M.ok)}
          </button>
        </span>
      </div>
      <div style={note}>{t(M.about)}</div>
    </div>
  );
}

// ── Content-Aware Move and healing options ───────────────────────────

const MV = defineMessages("image.caMove", {
  title: "Content-Aware Move",
  mode: "Mode",
  move: "Move",
  extend: "Extend",
  structure: "Structure",
  colour: "Colour",
  transformOnDrop: "Transform on drop",
  sampleAll: "Sample all layers",
  pending: "Moved by {dx}, {dy} px",
  scale: "Scale (%)",
  angle: "Angle (°)",
  commit: "Commit",
  cancel: "Cancel",
  note:
    "Drag the selection with the Content-Aware Move tool. Structure 7 keeps " +
    "the moved pixels exactly and re-synthesises only the seam; 1 blends a " +
    "wide band. Colour adapts the moved pixels' tone to their new place.",
});

const HL = defineMessages("image.heal", {
  title: "Healing",
  diffusion: "Diffusion",
  spotType: "Spot healing type",
  sample: "Sample",
  note:
    "Diffusion sets how far the tone correction spreads into the healed " +
    "area: low keeps grain and fine detail, high suits smooth areas.",
});

export function RetouchOptionsSection({
  move,
  pending,
  heal,
  busy,
  onMove,
  onTransform,
  onCommit,
  onCancel,
  onHeal,
}: {
  move: MoveOptions;
  pending: PendingMove | null;
  heal: HealOptions;
  busy: boolean;
  onMove: (patch: Partial<MoveOptions>) => void;
  onTransform: (patch: Partial<PendingMove>) => void;
  onCommit: () => void;
  onCancel: () => void;
  onHeal: (patch: Partial<HealOptions>) => void;
}) {
  return (
    <div data-image-retouch-options>
      <div style={sectionTitle}>{t(MV.title)}</div>
      <div style={row}>
        <label htmlFor="pg-image-cam-mode">{t(MV.mode)}</label>
        <select
          id="pg-image-cam-mode"
          data-image-cam-mode
          value={move.mode}
          onChange={(e) =>
            onMove({ mode: e.target.value === "extend" ? "extend" : "move" })
          }
        >
          <option value="move">{t(MV.move)}</option>
          <option value="extend">{t(MV.extend)}</option>
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-cam-structure">{t(MV.structure)}</label>
        <input
          id="pg-image-cam-structure"
          type="number"
          min={1}
          max={7}
          data-image-cam-structure
          value={move.structure}
          onChange={(e) => onMove({ structure: Number(e.target.value) })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-cam-colour">{t(MV.colour)}</label>
        <input
          id="pg-image-cam-colour"
          type="number"
          min={0}
          max={10}
          data-image-cam-colour
          value={move.colour}
          onChange={(e) => onMove({ colour: Number(e.target.value) })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-cam-tod">{t(MV.transformOnDrop)}</label>
        <input
          id="pg-image-cam-tod"
          type="checkbox"
          data-image-cam-transform-on-drop
          checked={move.transformOnDrop}
          onChange={(e) => onMove({ transformOnDrop: e.target.checked })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-cam-all">{t(MV.sampleAll)}</label>
        <input
          id="pg-image-cam-all"
          type="checkbox"
          data-image-cam-sample-all
          checked={move.sampleAll}
          onChange={(e) => onMove({ sampleAll: e.target.checked })}
        />
      </div>
      {pending ? (
        <div data-image-cam-pending>
          <div style={{ ...row, ...mono }}>
            {t(MV.pending, { dx: pending.dx, dy: pending.dy })}
          </div>
          <div style={row}>
            <label htmlFor="pg-image-cam-scale">{t(MV.scale)}</label>
            <input
              id="pg-image-cam-scale"
              type="number"
              min={5}
              max={2000}
              data-image-cam-scale
              value={pending.scale}
              onChange={(e) => onTransform({ scale: Number(e.target.value) })}
            />
          </div>
          <div style={row}>
            <label htmlFor="pg-image-cam-angle">{t(MV.angle)}</label>
            <input
              id="pg-image-cam-angle"
              type="number"
              min={-180}
              max={180}
              data-image-cam-angle
              value={pending.angle}
              onChange={(e) => onTransform({ angle: Number(e.target.value) })}
            />
          </div>
          <div style={row}>
            <button
              type="button"
              data-image-cam-cancel
              disabled={busy}
              onClick={onCancel}
            >
              {t(MV.cancel)}
            </button>
            <button
              type="button"
              data-image-cam-commit
              disabled={busy}
              onClick={onCommit}
            >
              {t(MV.commit)}
            </button>
          </div>
        </div>
      ) : null}
      <div style={note}>{t(MV.note)}</div>

      <div style={sectionTitle}>{t(HL.title)}</div>
      <div style={row}>
        <label htmlFor="pg-image-heal-diffusion">{t(HL.diffusion)}</label>
        <input
          id="pg-image-heal-diffusion"
          type="range"
          min={1}
          max={7}
          step={1}
          data-image-heal-diffusion
          value={heal.diffusion}
          onChange={(e) => onHeal({ diffusion: Number(e.target.value) })}
        />
        <span style={mono}>{heal.diffusion}</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-heal-spot">{t(HL.spotType)}</label>
        <select
          id="pg-image-heal-spot"
          data-image-heal-spot
          value={heal.spotType}
          onChange={(e) => onHeal({ spotType: e.target.value as SpotType })}
        >
          {SPOT_TYPES.map((v) => (
            <option key={v} value={v}>
              {t(SPOT_LABEL[v])}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-heal-sample">{t(HL.sample)}</label>
        <select
          id="pg-image-heal-sample"
          data-image-heal-sample
          value={heal.sample}
          onChange={(e) => onHeal({ sample: e.target.value as SampleMode })}
        >
          {SAMPLE_MODES.map((v) => (
            <option key={v} value={v}>
              {t(SAMPLE_LABEL[v])}
            </option>
          ))}
        </select>
      </div>
      <div style={note}>{t(HL.note)}</div>
    </div>
  );
}

// ── the Clone Source panel ───────────────────────────────────────────

const CS = defineMessages("image.cloneSource", {
  title: "Clone Source",
  source: "Source {n}",
  notSet: "not set",
  offset: "Offset",
  offsetAuto: "at the first dab",
  width: "W (%)",
  height: "H (%)",
  angle: "Angle (°)",
  flipH: "Flip horizontal",
  flipV: "Flip vertical",
  reset: "Reset transform",
  frameOffset: "Frame offset",
  frameOffsetNa: "not applicable (no video frames)",
  showOverlay: "Show overlay",
  opacity: "Opacity",
  clipped: "Clipped",
  autoHide: "Auto hide",
  invert: "Invert",
  sample: "Sample",
  aligned: "Aligned",
  note:
    "Alt-click with the Clone stamp or the Healing brush sets the active " +
    "source. Each source keeps its own offset, scale, angle and flip.",
});

export function CloneSourceBody({
  cs,
  aligned,
  busy,
  onSelect,
  onSlot,
  onReset,
  onOverlay,
  onSample,
  onAligned,
}: {
  cs: CloneSourceState;
  aligned: boolean;
  busy: boolean;
  onSelect: (i: number) => void;
  onSlot: (i: number, patch: Partial<CloneSourceSlot>) => void;
  onReset: (i: number) => void;
  onOverlay: (patch: Partial<CloneOverlayOptions>) => void;
  onSample: (s: SampleMode) => void;
  onAligned: (a: boolean) => void;
}) {
  const i = cs.active;
  const slot = cs.slots[i];
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return (
    <div data-image-clone-source-panel>
      <div style={panelTitle}>{t(CS.title)}</div>
      <div style={row} role="radiogroup">
        {Array.from({ length: CLONE_SOURCE_COUNT }, (_, k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === i}
            data-image-clone-slot={k}
            data-active={k === i}
            data-set={cs.slots[k].anchor !== null}
            title={t(CS.source, { n: k + 1 })}
            onClick={() => onSelect(k)}
          >
            {k + 1}
          </button>
        ))}
      </div>
      <div style={row}>
        <span>{t(CS.source, { n: i + 1 })}</span>
        <span style={mono} data-image-clone-slot-anchor>
          {slot.anchor
            ? `${Math.round(slot.anchor[0])}, ${Math.round(slot.anchor[1])}`
            : t(CS.notSet)}
        </span>
      </div>
      <div style={row}>
        <span>{t(CS.offset)}</span>
        <span>
          <input
            type="number"
            aria-label="X"
            data-image-clone-offset-x
            style={{ width: "5em" }}
            value={slot.offset?.[0] ?? ""}
            placeholder={t(CS.offsetAuto)}
            onChange={(e) =>
              onSlot(i, {
                offset:
                  e.target.value === "" && !slot.offset?.[1]
                    ? null
                    : [num(e.target.value, 0), slot.offset?.[1] ?? 0],
              })
            }
          />
          <input
            type="number"
            aria-label="Y"
            data-image-clone-offset-y
            style={{ width: "5em" }}
            value={slot.offset?.[1] ?? ""}
            onChange={(e) =>
              onSlot(i, {
                offset:
                  e.target.value === "" && !slot.offset?.[0]
                    ? null
                    : [slot.offset?.[0] ?? 0, num(e.target.value, 0)],
              })
            }
          />
        </span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-w">{t(CS.width)}</label>
        <input
          id="pg-image-clone-w"
          type="number"
          data-image-clone-scale-w
          value={Math.abs(slot.scaleW)}
          onChange={(e) =>
            onSlot(i, {
              scaleW:
                Math.sign(slot.scaleW || 1) *
                Math.max(1, num(e.target.value, 100)),
            })
          }
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-h">{t(CS.height)}</label>
        <input
          id="pg-image-clone-h"
          type="number"
          data-image-clone-scale-h
          value={Math.abs(slot.scaleH)}
          onChange={(e) =>
            onSlot(i, {
              scaleH:
                Math.sign(slot.scaleH || 1) *
                Math.max(1, num(e.target.value, 100)),
            })
          }
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-angle">{t(CS.angle)}</label>
        <input
          id="pg-image-clone-angle"
          type="number"
          data-image-clone-angle
          value={slot.angle}
          onChange={(e) => onSlot(i, { angle: num(e.target.value, 0) })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-flip-h">{t(CS.flipH)}</label>
        <input
          id="pg-image-clone-flip-h"
          type="checkbox"
          data-image-clone-flip-h
          checked={slot.scaleW < 0}
          onChange={() => onSlot(i, { scaleW: -slot.scaleW })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-flip-v">{t(CS.flipV)}</label>
        <input
          id="pg-image-clone-flip-v"
          type="checkbox"
          data-image-clone-flip-v
          checked={slot.scaleH < 0}
          onChange={() => onSlot(i, { scaleH: -slot.scaleH })}
        />
      </div>
      <div style={row}>
        <span>{t(CS.frameOffset)}</span>
        <span style={note} data-image-clone-frame-offset>
          {t(CS.frameOffsetNa)}
        </span>
      </div>
      <div style={row}>
        <button
          type="button"
          data-image-clone-reset
          disabled={busy}
          onClick={() => onReset(i)}
        >
          {t(CS.reset)}
        </button>
      </div>

      <div style={row}>
        <label htmlFor="pg-image-clone-show">{t(CS.showOverlay)}</label>
        <input
          id="pg-image-clone-show"
          type="checkbox"
          data-image-clone-overlay
          checked={cs.overlay.show}
          onChange={(e) => onOverlay({ show: e.target.checked })}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-opacity">{t(CS.opacity)}</label>
        <input
          id="pg-image-clone-opacity"
          type="range"
          min={0}
          max={100}
          data-image-clone-overlay-opacity
          value={cs.overlay.opacity}
          onChange={(e) => onOverlay({ opacity: num(e.target.value, 50) })}
        />
      </div>
      {(
        [
          ["clipped", CS.clipped],
          ["autoHide", CS.autoHide],
          ["invert", CS.invert],
        ] as const
      ).map(([k, label]) => (
        <div style={row} key={k}>
          <label htmlFor={`pg-image-clone-${k}`}>{t(label)}</label>
          <input
            id={`pg-image-clone-${k}`}
            type="checkbox"
            data-image-clone-overlay-option={k}
            checked={cs.overlay[k]}
            onChange={(e) => onOverlay({ [k]: e.target.checked })}
          />
        </div>
      ))}
      <div style={row}>
        <label htmlFor="pg-image-clone-sample">{t(CS.sample)}</label>
        <select
          id="pg-image-clone-sample"
          data-image-clone-sample
          value={cs.sample}
          onChange={(e) => onSample(e.target.value as SampleMode)}
        >
          {SAMPLE_MODES.map((v) => (
            <option key={v} value={v}>
              {t(SAMPLE_LABEL[v])}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-clone-aligned2">{t(CS.aligned)}</label>
        <input
          id="pg-image-clone-aligned2"
          type="checkbox"
          data-image-clone-panel-aligned
          checked={aligned}
          onChange={(e) => onAligned(e.target.checked)}
        />
      </div>
      <div style={note}>{t(CS.note)}</div>
    </div>
  );
}

/** The Clone Source panel (its own dockable panel). */
export function makeCloneSourcePanel(session: ImageSession) {
  function CloneSourcePanel() {
    const live = useLive(session, onDidChangeOf);
    const s = live.state();
    return (
      <div style={{ padding: "8px" }}>
        <CloneSourceBody
          cs={s.retouch.cloneSource}
          aligned={s.cloneSource?.aligned ?? true}
          busy={s.busy}
          onSelect={(i) => session.selectCloneSource(i)}
          onSlot={(i, patch) => session.setCloneSourceSlot(i, patch)}
          onReset={(i) => session.resetCloneTransform(i)}
          onOverlay={(patch) => session.setCloneOverlay(patch)}
          onSample={(m) => session.setCloneSample(m)}
          onAligned={(a) => session.setCloneAligned(a)}
        />
      </div>
    );
  }
  return CloneSourcePanel;
}
