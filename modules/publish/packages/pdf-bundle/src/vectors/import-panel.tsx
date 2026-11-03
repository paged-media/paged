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

// File ▸ Import ▸ PDF or AI as Vectors… (WP4.12, publish ADR 658): pick a
// PDF or an Illustrator file, choose its page, and place that page into the
// open document as native page items in one undo step, with a report of what
// could not be carried exactly. The panel is this bundle's: it calls the
// reading and the lowering (`inspectPdf`, `placeVectors`) directly, with no
// typed-command hop through the host (the host dialog this replaces was a
// client of those two commands, which stay for scripts and the CLI).

import { useState } from "react";
import type { ReactElement } from "react";

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { StatusLine, color } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

import type { PdfInfo } from "./ir";
import { inspectPdf, placeVectors, type PlaceVectorsResult } from "./place";

const M = defineMessages("publish.pdfVectors", {
  command: "PDF or AI as Vectors…",
  title: "Import PDF or AI as vectors",
  intro:
    "The page lands on the current page as editable paths, groups, gradients, images and text, in one undo step.",
  choose: "Choose a file…",
  reading: "Reading {name}…",
  page: "Page",
  pageOption: "{page} — {width} × {height} pt",
  scale: "Scale (%)",
  text: "Text",
  textFrames: "Editable text",
  textOutlines: "Outlines",
  ai: "Illustrator file: its PDF part is read; Illustrator's own data is not.",
  reset: "Start over",
  place: "Place",
  placing: "Placing…",
  placed:
    "{count, plural, one {Placed: # thing could not be carried exactly} other {Placed: # things could not be carried exactly}}",
  placedClean: "Placed.",
  noPicker: "This host has no file picker.",
});

// The menu's segments stay English (they are identities); the shell shows
// them through these messages.
defineMessages("menu", {
  Import: "Import",
  "PDF or AI as Vectors…": "PDF or AI as Vectors…",
});
defineMessages("commandCategory", { File: "File" });

export const IMPORT_VECTORS_COMMAND = "media.paged.pdf.command.importVectors";
export const IMPORT_VECTORS_PANEL = "media.paged.pdf.panel.importVectors";
export const IMPORT_VECTORS_MENU_PATH = "File/Import/PDF or AI as Vectors…";

/** The losses a user can act on: every line but the two facts every
 *  placement shares. */
const actionable = (a: PlaceVectorsResult) =>
  a.losses.filter((l) => l.code !== "colours" && l.code !== "aiPrivate");

const ACCEPT = [".pdf", ".ai", "application/pdf", "application/illustrator"];

export function makeImportVectorsPanel(host: BundleHost) {
  function ImportVectorsPanel(_props: PanelProps): ReactElement {
    const strings = useStrings();
    const [file, setFile] = useState<{
      name: string;
      bytes: Uint8Array;
    } | null>(null);
    const [info, setInfo] = useState<PdfInfo | null>(null);
    const [page, setPage] = useState(1);
    const [scale, setScale] = useState("100");
    const [text, setText] = useState<"frames" | "outlines">("frames");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [answer, setAnswer] = useState<PlaceVectorsResult | null>(null);

    const reset = () => {
      setFile(null);
      setInfo(null);
      setAnswer(null);
      setMessage(null);
    };

    const choose = async () => {
      if (!host.supports("shell.pickFile@1")) {
        setMessage(strings.t(M.noPicker));
        return;
      }
      const [picked] = await host.shell.pickFile({
        accept: ACCEPT,
        multiple: false,
      });
      if (!picked) return;
      setFile({ name: picked.name, bytes: picked.bytes });
      setInfo(null);
      setAnswer(null);
      setMessage(strings.t(M.reading, { name: picked.name }));
      // No `try`: the React Compiler does not lower a conditional inside one.
      const read = await inspectPdf(host, picked.bytes).then(
        (r) => ({ ok: true as const, r }),
        (err: unknown) => ({
          ok: false as const,
          why: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!read.ok) return setMessage(read.why);
      setInfo(read.r);
      setPage(1);
      setMessage(null);
    };

    const place = async () => {
      if (!file || !info) return;
      setBusy(true);
      setMessage(null);
      const pct = Number(scale);
      const outcome = await placeVectors(host, {
        bytes: file.bytes,
        name: file.name,
        page,
        ...(Number.isFinite(pct) && pct !== 100 ? { scale: pct } : {}),
        text,
      }).then(
        (r) => ({ ok: true as const, r }),
        (err: unknown) => ({
          ok: false as const,
          why: err instanceof Error ? err.message : String(err),
        }),
      );
      setBusy(false);
      if (!outcome.ok) return setMessage(outcome.why);
      setAnswer(outcome.r);
    };

    const losses = answer ? actionable(answer) : [];

    return (
      <div data-pdf-vectors-panel="" style={{ padding: 12, fontSize: 11.5 }}>
        <p style={{ margin: "0 0 10px" }}>{strings.t(M.intro)}</p>
        <div style={rowStyle}>
          <button
            type="button"
            data-pdf-vectors-choose=""
            onClick={() => void choose()}
          >
            {strings.t(M.choose)}
          </button>
          <span data-pdf-vectors-file="">{file?.name ?? ""}</span>
        </div>
        {info ? (
          <>
            <label style={rowStyle}>
              <span style={labelStyle}>{strings.t(M.page)}</span>
              <select
                data-pdf-vectors-page=""
                value={page}
                onChange={(e) => setPage(Number(e.currentTarget.value))}
              >
                {info.pages.map((p, i) => (
                  <option key={i} value={i + 1}>
                    {strings.t(M.pageOption, {
                      page: i + 1,
                      width: Math.round(p.width_pt),
                      height: Math.round(p.height_pt),
                    })}
                  </option>
                ))}
              </select>
            </label>
            <label style={rowStyle}>
              <span style={labelStyle}>{strings.t(M.scale)}</span>
              <input
                data-pdf-vectors-scale=""
                type="number"
                min={1}
                max={10000}
                value={scale}
                onChange={(e) => setScale(e.currentTarget.value)}
                style={{ width: 80 }}
              />
            </label>
            <label style={rowStyle}>
              <span style={labelStyle}>{strings.t(M.text)}</span>
              <select
                data-pdf-vectors-text=""
                value={text}
                onChange={(e) =>
                  setText(
                    e.currentTarget.value === "outlines"
                      ? "outlines"
                      : "frames",
                  )
                }
              >
                <option value="frames">{strings.t(M.textFrames)}</option>
                <option value="outlines">{strings.t(M.textOutlines)}</option>
              </select>
            </label>
            {info.format === "ai" ? (
              <p
                data-pdf-vectors-ai=""
                style={{ margin: "6px 0 0", color: color.mutedFg }}
              >
                {strings.t(M.ai)}
              </p>
            ) : null}
          </>
        ) : null}
        {answer ? (
          <div data-pdf-vectors-report="">
            <p style={{ margin: "8px 0 4px" }}>
              {losses.length
                ? strings.t(M.placed, { count: losses.length })
                : strings.t(M.placedClean)}
            </p>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {answer.losses.map((l) => (
                <li key={l.code} data-pdf-vectors-loss={l.code}>
                  {l.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <StatusLine tone="error" attr="data-pdf-vectors-problem">
          {message}
        </StatusLine>
        <div style={{ ...rowStyle, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" data-pdf-vectors-reset="" onClick={reset}>
            {strings.t(M.reset)}
          </button>
          {answer ? null : (
            <button
              type="button"
              data-pdf-vectors-place=""
              disabled={!info || busy}
              onClick={() => void place()}
            >
              {strings.t(busy ? M.placing : M.place)}
            </button>
          )}
        </div>
      </div>
    );
  }
  return ImportVectorsPanel;
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "6px 0",
} as const;

const labelStyle = { minWidth: 80, color: color.mutedFg } as const;

/** The command, its File ▸ Import row and the panel it opens. */
export function contributeImportVectors(host: BundleHost) {
  const subs = [
    host.contribute.panel({
      id: IMPORT_VECTORS_PANEL,
      title: t(M.title),
      component: makeImportVectorsPanel(host),
      defaultDock: "right",
    }),
    host.contribute.command({
      id: IMPORT_VECTORS_COMMAND,
      title: t(M.command),
      category: "File",
      handler: () => {
        if (host.supports("shell.openPanel@1"))
          host.shell.openPanel(IMPORT_VECTORS_PANEL);
      },
    }),
    host.contribute.menu({
      path: IMPORT_VECTORS_MENU_PATH,
      command: IMPORT_VECTORS_COMMAND,
      group: "import",
      order: 20,
    }),
  ];
  return {
    dispose() {
      for (const s of subs) s.dispose();
    },
  };
}
