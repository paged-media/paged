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

// The ML features' panel section (WP8.2, image ADR 485): the Generate form
// (prompt, seed, steps, variations and the strip of results), Generative
// Fill and Expand, Remove, Remove Background, the preset edits, and the
// Neural Filters (Super Zoom, JPEG Artifact Removal). Every button calls
// the session's ML controller; a missing model is the status line's
// message, nothing here names or fetches one.

import { useState } from "react";

import { defineMessages, t } from "@paged-media/strings";

import type { MlUiState } from "../../ml-features";
import type { ImageSession } from "../../session";
import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.mlPanel", {
  title: "Generate and neural filters",
  prompt: "Prompt",
  seed: "Seed",
  steps: "Steps",
  variations: "Variations",
  generate: "Generate image",
  fill: "Generative fill",
  expandTo: "Expand canvas to",
  expand: "Generative expand",
  removeHq: "Remove selection",
  removeBg: "Remove background",
  presets: "Presets",
  skySwap: "Sky replacement",
  colorize: "Colorize",
  skin: "Skin smoothing",
  neural: "Neural filters",
  superZoom: "Super zoom ×2",
  superZoom4: "Super zoom ×4",
  jpeg: "JPEG artifact removal",
  place: "Place",
  discard: "Discard",
  working: "Working with the local image model…",
  anchor: "Anchor",
  hint:
    "These use the local image models you installed in Settings. Nothing is " +
    "downloaded from here; without a model the buttons say so.",
});

const ANCHORS: Array<[number, string]> = [
  [0, "left / top"],
  [1, "centre"],
  [2, "right / bottom"],
];

/** A candidate's RGBA as a data-URL-free thumbnail (a canvas element). */
function Thumb({ c }: { c: MlUiState["candidates"][number] }) {
  return (
    <canvas
      width={c.width}
      height={c.height}
      style={{ width: 72, height: 72, objectFit: "contain" }}
      ref={(el) => {
        const ctx = el?.getContext("2d");
        if (ctx)
          ctx.putImageData(
            new ImageData(
              c.data as Uint8ClampedArray<ArrayBuffer>,
              c.width,
              c.height,
            ),
            0,
            0,
          );
      }}
    />
  );
}

export function MlSection({
  session,
  ml,
  canvas,
  hasSelection,
  disabled,
}: {
  session: ImageSession;
  ml: MlUiState;
  canvas: { width: number; height: number } | null;
  hasSelection: boolean;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState(-1);
  const [steps, setSteps] = useState(20);
  const [variations, setVariations] = useState(1);
  const [grow, setGrow] = useState(150);
  const [ax, setAx] = useState(1);
  const [ay, setAy] = useState(1);
  const off = disabled || ml.busy;
  const f = () => session.ml();
  const opts = { seed, steps };
  return (
    <>
      <div style={sectionTitle}>{t(M.title)}</div>
      <div style={row}>
        <label htmlFor="pg-image-ml-prompt">{t(M.prompt)}</label>
        <input
          id="pg-image-ml-prompt"
          type="text"
          data-image-ml="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-ml-seed">{t(M.seed)}</label>
        <input
          id="pg-image-ml-seed"
          type="number"
          value={seed}
          min={-1}
          onChange={(e) => setSeed(Number(e.target.value))}
        />
        <label htmlFor="pg-image-ml-steps">{t(M.steps)}</label>
        <input
          id="pg-image-ml-steps"
          type="number"
          value={steps}
          min={1}
          max={100}
          onChange={(e) => setSteps(Number(e.target.value))}
        />
        <label htmlFor="pg-image-ml-variations">{t(M.variations)}</label>
        <input
          id="pg-image-ml-variations"
          type="number"
          value={variations}
          min={1}
          max={8}
          onChange={(e) => setVariations(Number(e.target.value))}
        />
      </div>
      <div style={row}>
        <button
          type="button"
          data-image-ml="generate"
          disabled={off}
          onClick={() =>
            void f().generateImage(prompt, { ...opts, variations })
          }
        >
          {t(M.generate)}
        </button>
        <button
          type="button"
          data-image-ml="fill"
          disabled={off || !hasSelection}
          onClick={() => void f().generativeFill(prompt, opts)}
        >
          {t(M.fill)}
        </button>
        <button
          type="button"
          data-image-ml="removeHq"
          disabled={off || !hasSelection}
          onClick={() => void f().removeSelection()}
        >
          {t(M.removeHq)}
        </button>
        <button
          type="button"
          data-image-ml="removeBg"
          disabled={off}
          onClick={() => void f().removeBackground()}
        >
          {t(M.removeBg)}
        </button>
      </div>
      {ml.candidates.length > 0 && (
        <div style={row} data-image-ml="strip">
          {ml.candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              data-image-ml-candidate={c.id}
              disabled={off}
              title={t(M.place)}
              onClick={() =>
                void f().placeCandidate(c.id, prompt || "Generated")
              }
            >
              <Thumb c={c} />
            </button>
          ))}
          <button type="button" onClick={() => f().clearCandidates()}>
            {t(M.discard)}
          </button>
        </div>
      )}
      <div style={row}>
        <label htmlFor="pg-image-ml-grow">{t(M.expandTo)}</label>
        <input
          id="pg-image-ml-grow"
          type="number"
          value={grow}
          min={101}
          max={400}
          onChange={(e) => setGrow(Number(e.target.value))}
        />
        <span style={mono}>%</span>
        <label htmlFor="pg-image-ml-ax">{t(M.anchor)}</label>
        <select
          id="pg-image-ml-ax"
          value={ax}
          onChange={(e) => setAx(Number(e.target.value))}
        >
          {ANCHORS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label={t(M.anchor)}
          value={ay}
          onChange={(e) => setAy(Number(e.target.value))}
        >
          {ANCHORS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-image-ml="expand"
          disabled={off || !canvas}
          onClick={() =>
            canvas &&
            void f().generativeExpand(
              prompt,
              {
                width: Math.round((canvas.width * grow) / 100),
                height: Math.round((canvas.height * grow) / 100),
                anchorX: ax,
                anchorY: ay,
              },
              opts,
            )
          }
        >
          {t(M.expand)}
        </button>
      </div>
      <div style={row}>
        <span>{t(M.presets)}</span>
        <button
          type="button"
          data-image-ml="sky"
          disabled={off}
          onClick={() => void f().skyReplacement(prompt, opts)}
        >
          {t(M.skySwap)}
        </button>
        <button
          type="button"
          data-image-ml="colorize"
          disabled={off}
          onClick={() => void f().colorize(opts)}
        >
          {t(M.colorize)}
        </button>
        <button
          type="button"
          data-image-ml="skin"
          disabled={off}
          onClick={() => void f().skinSmoothing(opts)}
        >
          {t(M.skin)}
        </button>
      </div>
      <div style={row}>
        <span>{t(M.neural)}</span>
        <button
          type="button"
          data-image-ml="superZoom"
          disabled={off}
          onClick={() => void f().superZoom(2)}
        >
          {t(M.superZoom)}
        </button>
        <button
          type="button"
          data-image-ml="superZoom4"
          disabled={off}
          onClick={() => void f().superZoom(4)}
        >
          {t(M.superZoom4)}
        </button>
        <button
          type="button"
          data-image-ml="jpeg"
          disabled={off}
          onClick={() => void f().removeJpegArtifacts()}
        >
          {t(M.jpeg)}
        </button>
      </div>
      {ml.busy && <div style={note}>{t(M.working)}</div>}
      <div style={note}>{t(M.hint)}</div>
    </>
  );
}
