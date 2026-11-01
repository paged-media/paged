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

// Generate Image (paged.generate-image, editor ADR 313): a prompt, a shape
// and a button. With one image frame selected the picture fills it; with
// anything else a new frame is made on the current page. It works for the
// pages of every module, since a frame is a page item. The model is the ML
// doors' (`ml.generate@1`): never bundled or downloaded by this panel, and
// a refusal is the registry's own sentence, shown as it came.

import { useRef, useState } from "react";

import { defineMessages, useStrings } from "@paged-media/strings";
import { FocusScope, usePaged, useSelection } from "@paged-media/shell";

import { generateImage } from "../ml/generate-image";
import { useMlService } from "../ml/scope";

const M = defineMessages("app.generateImagePanel", {
  noService: "The ML service does not run in this editor.",
  intro:
    "Make a picture from a prompt with the local image model and put it in an image frame. Nothing leaves this machine.",
  prompt: "Prompt",
  promptHint: "A lighthouse at dusk, oil painting",
  negative: "Leave out",
  shape: "Shape",
  fitFrame: "Fit the selected frame",
  square: "Square (1:1)",
  landscape: "Landscape (16:9)",
  portrait: "Portrait (9:16)",
  wide: "Wide (4:3)",
  tall: "Tall (3:4)",
  fillsSelected: "The picture fills the selected frame.",
  makesNew: "The picture goes into a new frame on the current page.",
  generate: "Generate",
  generating: "Generating…",
  cancel: "Cancel",
  step: "Step {step} of {total}",
  done: "Generated with {provider}. One undo step.",
});

type Shape = "fit" | "square" | "landscape" | "portrait" | "wide" | "tall";

const ASPECTS: Record<Exclude<Shape, "fit">, [number, number]> = {
  square: [1, 1],
  landscape: [16, 9],
  portrait: [9, 16],
  wide: [4, 3],
  tall: [3, 4],
};

function aspectOf(shape: Exclude<Shape, "fit">) {
  const [width, height] = ASPECTS[shape];
  return { width, height };
}

const sectionTitle =
  "text-[10px] uppercase tracking-wide text-muted-foreground";
const button =
  "text-xs border border-input rounded px-2 py-1 disabled:opacity-50";

type RunState =
  | { kind: "idle" }
  | { kind: "running"; step?: number; total?: number }
  | { kind: "done"; provider: string }
  | { kind: "error"; message: string };

export function GenerateImagePanel() {
  const strings = useStrings();
  const service = useMlService();
  const paged = usePaged();
  const selection = useSelection();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [shape, setShape] = useState<Shape>("fit");
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);

  if (!service)
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-generate-panel="none"
      >
        {strings.t(M.noService)}
      </div>
    );

  const frameSelected =
    selection.elementSelection.length === 1 &&
    ["rectangle", "oval", "polygon"].includes(
      selection.elementSelection[0]!.kind,
    );
  const running = run.kind === "running";

  const start = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setRun({ kind: "running" });
    let failure: string | null = null;
    const outcome = await generateImage(
      paged,
      (severity, message) => {
        if (severity === "error") failure = message;
      },
      (request, options) => service.generateImage(request, options),
      {
        prompt,
        ...(negative.trim() ? { negativePrompt: negative.trim() } : {}),
        ...(shape !== "fit" ? { aspect: aspectOf(shape) } : {}),
      },
      {
        signal: controller.signal,
        onProgress: (p) =>
          setRun({ kind: "running", step: p.step, total: p.total }),
      },
    );
    abort.current = null;
    if (outcome.applied)
      setRun({ kind: "done", provider: outcome.provider ?? "" });
    else if (failure) setRun({ kind: "error", message: failure });
    else setRun({ kind: "idle" });
  };

  return (
    <FocusScope>
      <div
        className="p-3 text-sm flex flex-col gap-3"
        data-generate-panel="ready"
      >
        <p className="text-xs text-muted-foreground m-0">
          {strings.t(M.intro)}
        </p>
        <label className="flex flex-col gap-0.5 text-xs">
          <span className={sectionTitle}>{strings.t(M.prompt)}</span>
          <textarea
            className="border border-input rounded px-1"
            data-generate-prompt
            rows={3}
            value={prompt}
            placeholder={strings.t(M.promptHint)}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          <span className={sectionTitle}>{strings.t(M.negative)}</span>
          <input
            className="border border-input rounded px-1"
            data-generate-negative
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          <span className={sectionTitle}>{strings.t(M.shape)}</span>
          <select
            className="border border-input rounded"
            data-generate-shape
            value={shape}
            onChange={(e) => setShape(e.target.value as Shape)}
          >
            <option value="fit">{strings.t(M.fitFrame)}</option>
            <option value="square">{strings.t(M.square)}</option>
            <option value="landscape">{strings.t(M.landscape)}</option>
            <option value="portrait">{strings.t(M.portrait)}</option>
            <option value="wide">{strings.t(M.wide)}</option>
            <option value="tall">{strings.t(M.tall)}</option>
          </select>
        </label>
        <div
          className="text-xs text-muted-foreground"
          data-generate-target={frameSelected ? "frame" : "new"}
        >
          {strings.t(frameSelected ? M.fillsSelected : M.makesNew)}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            data-action="generate-image"
            disabled={running || !prompt.trim()}
            onClick={() => void start()}
          >
            {strings.t(running ? M.generating : M.generate)}
          </button>
          {running && (
            <button
              type="button"
              className={button}
              data-action="generate-cancel"
              onClick={() => abort.current?.abort()}
            >
              {strings.t(M.cancel)}
            </button>
          )}
        </div>
        {run.kind === "running" && run.step !== undefined && (
          <div className="text-xs text-muted-foreground" data-generate-progress>
            {strings.t(M.step, { step: run.step, total: run.total ?? 0 })}
          </div>
        )}
        {run.kind === "done" && (
          <div className="text-xs" data-generate-status="done">
            {strings.t(M.done, { provider: run.provider })}
          </div>
        )}
        {run.kind === "error" && (
          <div
            role="alert"
            className="text-xs"
            data-generate-status="error"
            style={{ color: "var(--status-error)" }}
          >
            {run.message}
          </div>
        )}
      </div>
    </FocusScope>
  );
}
