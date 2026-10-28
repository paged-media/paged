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

// File ▸ Import ▸ PDF or AI as Vectors… (WP4.12, publish ADR 658): pick a
// PDF or an Illustrator file, choose its page, and place that page into
// the open document as native page items — paths, clip groups,
// gradients, images, text frames — in one undo step, with a report of
// what could not be carried exactly.
//
// The reading and the lowering are paged.pdf's (modules/publish): the
// dialog reaches them only through the bundle's typed commands
// (`media.paged.pdf.inspectPdf`, `media.paged.pdf.placeVectors`), the
// door PM-0002 leaves the host. Without the bundle the row stays and
// says so.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";

import {
  createValueStore,
  FocusScope,
  scoped,
  scopeOf,
  useObjectModel,
  useScoped,
  type EditorScope,
} from "@paged-media/shell";
import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { StatusLine, color, radius } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

import { pickFiles, type PickedFile } from "../shell-file-picker";

const M = defineMessages("app.pdfVectors", {
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
  cancel: "Cancel",
  place: "Place",
  placing: "Placing…",
  placed:
    "{count, plural, one {Placed: # thing could not be carried exactly} other {Placed: # things could not be carried exactly}}",
  placedClean: "Placed.",
  noBundle: "The PDF import (paged.pdf) is not loaded.",
  close: "Close",
});

// The menu's segments stay English (they are identities); the shell shows
// them through these messages.
defineMessages("menu", {
  Import: "Import",
  "PDF or AI as Vectors…": "PDF or AI as Vectors…",
});
defineMessages("commandCategory", { File: "File" });

export const IMPORT_PDF_VECTORS_COMMAND = "paged.file.importPdfVectors";
/** The bundle's typed commands the dialog drives. */
export const PDF_INSPECT = "media.paged.pdf.inspectPdf";
export const PDF_PLACE_VECTORS = "media.paged.pdf.placeVectors";

const OPEN = scoped("pdfVectorsDialog", () => createValueStore(false));

export function openPdfVectors(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export const PDF_VECTORS_COMMANDS: CommandContribution[] = [
  {
    id: IMPORT_PDF_VECTORS_COMMAND,
    get title() {
      return t(M.command);
    },
    category: "File",
    handler: (paged) => openPdfVectors(scopeOf(paged)),
  },
];

export const PDF_VECTORS_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "File/Import/PDF or AI as Vectors…",
    command: IMPORT_PDF_VECTORS_COMMAND,
    order: 20,
    group: "import",
  },
];

/** What `media.paged.pdf.inspectPdf` answers. */
interface PdfInfo {
  format: "pdf" | "ai";
  pages: { width_pt: number; height_pt: number }[];
  ai?: { pdf_compatible: boolean; has_private_data: boolean };
}

/** What `media.paged.pdf.placeVectors` answers (as far as the dialog
 *  reads it). */
interface PlaceAnswer {
  placed: boolean;
  losses: { code: string; count: number; message: string }[];
}

/** The losses a user can act on: every line but the two facts every
 *  placement shares. */
const actionable = (a: PlaceAnswer) =>
  a.losses.filter((l) => l.code !== "colours" && l.code !== "aiPrivate");

export function PdfVectorsDialog(): ReactElement | null {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <PdfVectorsForm /> : null;
}

function PdfVectorsForm(): ReactElement {
  const strings = useStrings();
  const model = useObjectModel();
  const store = useScoped(OPEN);
  const close = () => store.set(false);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState("100");
  const [text, setText] = useState<"frames" | "outlines">("frames");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [answer, setAnswer] = useState<PlaceAnswer | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const choose = async () => {
    const [picked] = await pickFiles({
      accept: [".pdf", ".ai", "application/pdf", "application/illustrator"],
    });
    if (!picked || !model) return;
    setFile(picked);
    setInfo(null);
    setAnswer(null);
    setMessage(strings.t(M.reading, { name: picked.name }));
    try {
      const r = (await model.objects.invoke(PDF_INSPECT, {
        bytes: picked.bytes,
      })) as PdfInfo;
      setInfo(r);
      setPage(1);
      setMessage(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const place = async () => {
    if (!file || !model || !info) return;
    setBusy(true);
    setMessage(null);
    // No `finally`: the React Compiler does not lower one (ADR 229).
    const pct = Number(scale);
    const outcome = await model.objects
      .invoke(PDF_PLACE_VECTORS, {
        bytes: file.bytes,
        name: file.name,
        page,
        ...(Number.isFinite(pct) && pct !== 100 ? { scale: pct } : {}),
        text,
      })
      .then(
        (r) => ({ ok: true as const, r: r as PlaceAnswer }),
        (err: unknown) => ({
          ok: false as const,
          why: err instanceof Error ? err.message : String(err),
        }),
      );
    setBusy(false);
    if (!outcome.ok) return setMessage(outcome.why);
    setAnswer(outcome.r);
    if (actionable(outcome.r).length === 0) close();
  };

  const losses = answer ? actionable(answer) : [];

  return (
    <div
      data-pdf-vectors-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-vectors-title"
        data-pdf-vectors-dialog=""
        data-panel-host=""
        style={dialogStyle}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2 id="pdf-vectors-title" style={titleStyle}>
            {strings.t(M.title)}
          </h2>
          <p style={{ margin: "0 0 10px", fontSize: 11.5 }}>
            {strings.t(M.intro)}
          </p>
          {!model ? (
            <div data-pdf-vectors-no-bundle="" style={{ fontSize: 11.5 }}>
              {strings.t(M.noBundle)}
            </div>
          ) : null}
          <div style={rowStyle}>
            <button
              type="button"
              data-pdf-vectors-choose=""
              onClick={() => void choose()}
              style={secondaryStyle}
            >
              {strings.t(M.choose)}
            </button>
            <span data-pdf-vectors-file="" style={{ fontSize: 11.5 }}>
              {file?.name ?? ""}
            </span>
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
                <p data-pdf-vectors-ai="" style={noteStyle}>
                  {strings.t(M.ai)}
                </p>
              ) : null}
            </>
          ) : null}
          {answer ? (
            <div data-pdf-vectors-report="" style={{ fontSize: 11.5 }}>
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
          <div style={footerStyle}>
            <button
              type="button"
              data-pdf-vectors-cancel=""
              onClick={close}
              style={secondaryStyle}
            >
              {strings.t(answer ? M.close : M.cancel)}
            </button>
            {answer ? null : (
              <button
                type="button"
                data-pdf-vectors-place=""
                disabled={!info || busy}
                onClick={() => void place()}
                style={buttonStyle}
              >
                {strings.t(busy ? M.placing : M.place)}
              </button>
            )}
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.5)",
};

const dialogStyle: CSSProperties = {
  width: "min(460px, 92vw)",
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
};

const titleStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 600,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "6px 0",
  fontSize: 11.5,
};

const labelStyle: CSSProperties = { minWidth: 80, color: color.mutedFg };

const noteStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: color.mutedFg,
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 14,
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};

const secondaryStyle: CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: color.fg,
};
