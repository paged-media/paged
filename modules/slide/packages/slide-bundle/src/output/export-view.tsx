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

// File ▸ Export… (slide ADR 720): PowerPoint's Export page as a module
// view in place of the canvas (extensions ADR 345). PDF slides, handouts
// and notes pages; the outline; a template; a video, with its progress and
// a Cancel. Each writes a file through the host's saver.

import type { BundleHost, ViewProps } from "@paged-media/plugin-api";
import { color } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import { OUTPUT, SHOW } from "../messages.js";
import { HANDOUT_COUNTS, type Paper, type PdfLayout } from "./documents.js";
import type { Job, Output } from "./output.js";

const section: React.CSSProperties = {
  borderBottom: `1px solid ${color.border}`,
  padding: "16px 24px",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
};
const heading: React.CSSProperties = { width: "100%", margin: 0, fontSize: 14 };
const label: React.CSSProperties = {
  fontSize: 12,
  display: "flex",
  gap: 6,
  alignItems: "center",
};

export function useJob(output: Output): Job | null {
  return React.useSyncExternalStore(
    (fn) => output.subscribe(fn),
    () => output.current(),
    () => output.current(),
  );
}

export function makeExportView(
  host: BundleHost,
  output: Output,
): React.ComponentType<ViewProps> {
  const save = async (file: {
    bytes: Uint8Array;
    fileName: string;
    mimeType?: string;
  }) => {
    await output.save(file);
  };
  const guard = (p: Promise<unknown>) =>
    p.catch((e) =>
      host.log.warn(
        `paged.slide export: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

  const View: React.FC<ViewProps> = ({ close }) => {
    const { t } = useStrings();
    const job = useJob(output);
    const running = !!job && !job.result && !job.error;
    const [layout, setLayout] = React.useState<PdfLayout>("handouts");
    const [perPage, setPerPage] = React.useState(6);
    const [paper, setPaper] = React.useState<Paper>(() =>
      output.defaultPaper(),
    );
    const [hidden, setHidden] = React.useState(false);
    const [height, setHeight] = React.useState(1080);
    const [fps, setFps] = React.useState(30);
    const [seconds, setSeconds] = React.useState(5);
    const [timings, setTimings] = React.useState(true);

    return (
      <div data-slide-export="ready" style={{ minHeight: "100%" }}>
        <div style={{ ...section, justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{t(OUTPUT.title)}</h2>
          <button type="button" data-export="close" onClick={close}>
            {t(SHOW.normalView)}
          </button>
        </div>

        <div style={section} data-export-section="pdf">
          <h3 style={heading}>{t(OUTPUT.pdf)}</h3>
          <label style={label}>
            {t(OUTPUT.pdfLayout)}
            <select
              data-export="pdf-layout"
              value={layout}
              onChange={(e) => setLayout(e.target.value as PdfLayout)}
            >
              <option value="slides">{t(OUTPUT.layoutSlides)}</option>
              <option value="handouts">{t(OUTPUT.layoutHandouts)}</option>
              <option value="notes">{t(OUTPUT.layoutNotes)}</option>
            </select>
          </label>
          {layout === "handouts" && (
            <label style={label}>
              {t(OUTPUT.perPage)}
              <select
                data-export="pdf-per-page"
                value={perPage}
                onChange={(e) => setPerPage(Number(e.target.value))}
              >
                {HANDOUT_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {layout !== "slides" && (
            <label style={label}>
              {t(OUTPUT.paper)}
              <select
                data-export="pdf-paper"
                value={paper}
                onChange={(e) => setPaper(e.target.value as Paper)}
              >
                <option value="letter">Letter</option>
                <option value="a4">A4</option>
              </select>
            </label>
          )}
          <label style={label}>
            <input
              type="checkbox"
              data-export="pdf-hidden"
              checked={hidden}
              onChange={(e) => setHidden(e.target.checked)}
            />
            {t(OUTPUT.includeHidden)}
          </label>
          <button
            type="button"
            data-export="pdf"
            disabled={running}
            onClick={() =>
              guard(
                output
                  .pdf({ layout, perPage, paper, includeHidden: hidden })
                  .then((r) => save(r)),
              )
            }
          >
            {t(OUTPUT.exportPdf)}
          </button>
        </div>

        <div style={section} data-export-section="outline">
          <h3 style={heading}>{t(OUTPUT.outline)}</h3>
          {(["rtf", "txt"] as const).map((f) => (
            <button
              key={f}
              type="button"
              data-export={`outline-${f}`}
              disabled={running}
              onClick={() => guard(output.outline(f).then((r) => save(r)))}
            >
              {t(f === "rtf" ? OUTPUT.outlineRtf : OUTPUT.outlineTxt)}
            </button>
          ))}
        </div>

        <div style={section} data-export-section="template">
          <h3 style={heading}>{t(OUTPUT.template)}</h3>
          <span style={{ fontSize: 12, opacity: 0.75, flex: 1 }}>
            {t(OUTPUT.templateHint)}
          </span>
          <button
            type="button"
            data-export="template"
            disabled={running}
            onClick={() =>
              guard(
                output.template().then((r) =>
                  save({
                    ...r,
                    mimeType:
                      "application/vnd.openxmlformats-officedocument.presentationml.template",
                  }),
                ),
              )
            }
          >
            {t(OUTPUT.saveAsTemplate)}
          </button>
        </div>

        <div style={section} data-export-section="video">
          <h3 style={heading}>{t(OUTPUT.video)}</h3>
          <label style={label}>
            {t(OUTPUT.resolution)}
            <select
              data-export="video-height"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            >
              <option value={720}>HD (720p)</option>
              <option value={1080}>Full HD (1080p)</option>
              <option value={2160}>Ultra HD (4K)</option>
            </select>
          </label>
          <label style={label}>
            {t(OUTPUT.fps)}
            <select
              data-export="video-fps"
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
            >
              {[24, 30, 60].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            {t(OUTPUT.secondsPerSlide)}
            <input
              type="number"
              data-export="video-seconds"
              min={0.5}
              max={3600}
              step={0.5}
              value={seconds}
              style={{ width: 64 }}
              onChange={(e) => setSeconds(Number(e.target.value) || 5)}
            />
          </label>
          <label style={label}>
            <input
              type="checkbox"
              data-export="video-timings"
              checked={timings}
              onChange={(e) => setTimings(e.target.checked)}
            />
            {t(OUTPUT.useTimings)}
          </label>
          <button
            type="button"
            data-export="video"
            disabled={running}
            onClick={() =>
              guard(
                output
                  .video({
                    height,
                    fps,
                    secondsPerSlide: seconds,
                    useTimings: timings,
                  })
                  .then((v) =>
                    save({
                      bytes: v.bytes,
                      fileName: v.fileName,
                      mimeType: "video/mp4",
                    }),
                  ),
              )
            }
          >
            {t(OUTPUT.exportVideo)}
          </button>
        </div>

        {job && (
          <div
            style={section}
            data-export-job={job.kind}
            data-export-state={
              running ? "running" : job.error ? "failed" : "done"
            }
            aria-live="polite"
          >
            {running && (
              <>
                <progress
                  value={job.done}
                  max={Math.max(1, job.total)}
                  style={{ flex: 1 }}
                  data-export="progress"
                />
                <span style={{ fontSize: 12 }}>
                  {t(OUTPUT.running, { done: job.done, total: job.total })}
                </span>
                <button
                  type="button"
                  data-export="cancel"
                  onClick={() => output.cancel()}
                >
                  {t(OUTPUT.cancel)}
                </button>
              </>
            )}
            {job.result && (
              <span style={{ fontSize: 12 }}>
                {t(OUTPUT.saved, { file: job.result.fileName })}
                {job.result.note
                  ? ` ${t(OUTPUT.replaced, { count: job.result.note })}`
                  : ""}
              </span>
            )}
            {job.error && (
              <span
                style={{ fontSize: 12, color: "var(--pg-danger, #c0392b)" }}
              >
                {t(OUTPUT.failed, { reason: job.error })}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };
  return View;
}
