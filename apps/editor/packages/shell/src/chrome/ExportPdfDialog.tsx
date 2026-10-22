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

// Concept 3 — the PDF export dialog (File ▸ Export PDF…).
//
// A controlled React form, NOT a catalog composition: the fields are
// interdependent (X-4 requires an output-intent profile; the Export
// button gates on validation) and the dialog OWNS the export loop —
// it drives `client.exportPdf` page by page, renders the determinate
// progress bar, and surfaces Cancel through an AbortController. The
// command (`paged.file.exportPdf`) only opens it via the module
// emitter below (the CommandPalette `notifyPalette` pattern).
//
// A finished export closes the dialog (ADR 272): the PDF is a download, so
// the dialog has nothing left to offer, and a notice at the window's foot
// names the file, its pages and any findings. A failed export keeps the
// dialog open with the error beside the options that produced it, so the
// user can change one and export again. Cancel during the export aborts it
// and the dialog stays open, as it was.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ExportPdfWireOptions } from "@paged-media/client";
import { useStrings } from "@paged-media/strings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Icon } from "../icons";
import { useCanvasClient } from "../state/canvas-client-context";
import { useDocument } from "../state/document-context";
import { oneOf, parseStored, readStoredShape } from "../lib/stored-settings";
import {
  printOutputFacts,
  workingProfileLabel,
  type PrintOutputFacts,
} from "../lib/print-output";
import { EXPORT_PDF } from "./messages";
import { richText } from "./rich";

type DialogAction = "open" | "close";
const listeners = new Set<(action: DialogAction) => void>();

/** Open/close the export dialog from anywhere (command handlers). */
export function notifyExportPdfDialog(action: DialogAction): void {
  for (const fn of listeners) fn(action);
}

/** Persisted last-used options (schema drift falls back to defaults). */
const OPTIONS_KEY = "paged.exportPdf.options.v1";

interface FormState {
  standard: "pdf17" | "pdfx4";
  outputIntentProfile: string; // "" = active working space
  colorPolicy: "preserveNumbers" | "convertToDestination";
  allPages: boolean;
  pageFrom: string; // 1-based in the UI
  pageTo: string;
  useDocumentBleed: boolean;
  bleedPt: string; // uniform custom bleed
  cropMarks: boolean;
  registrationMarks: boolean;
  colorBars: boolean;
  downsample: "off" | "300" | "150";
  bookmarks: boolean;
  tagged: boolean;
}

const DEFAULTS: FormState = {
  standard: "pdfx4",
  outputIntentProfile: "",
  colorPolicy: "preserveNumbers",
  allPages: true,
  pageFrom: "1",
  pageTo: "1",
  useDocumentBleed: true,
  bleedPt: "0",
  cropMarks: false,
  registrationMarks: false,
  colorBars: false,
  downsample: "off",
  bookmarks: false,
  tagged: false,
};

/** The stored form, field by field: a value the dialog does not offer
 *  (`standard: "bogus"`) reads as the default rather than reaching the
 *  export (SH-103, ADR 247). */
function loadSaved(): FormState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OPTIONS_KEY);
  } catch {
    return DEFAULTS;
  }
  return readStoredShape(parseStored(raw), DEFAULTS, {
    standard: oneOf("pdf17", "pdfx4"),
    colorPolicy: oneOf("preserveNumbers", "convertToDestination"),
    downsample: oneOf("off", "300", "150"),
  });
}

type Phase =
  | { kind: "idle" }
  | { kind: "exporting"; done: number; total: number }
  | { kind: "error"; message: string }
  | { kind: "done"; pages: number; diagnostics: string[] };

/** What the notice after a finished export says. */
interface ExportNotice {
  fileName: string;
  pages: number;
  diagnostics: string[];
}

/** How long the notice stays (ms); it also closes on its ✕. A notice with
 *  findings stays until it is closed: the findings are worth reading. */
const NOTICE_MS = 6000;

const fieldRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};
const labelStyle: React.CSSProperties = { width: 130, opacity: 0.8 };

export function ExportPdfDialog() {
  const strings = useStrings();
  const client = useCanvasClient();
  const { handle } = useDocument();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(loadSaved);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [docName, setDocName] = useState("document");
  // The print-output facts (ADR 266): the Export Center's pill and this
  // dialog's default standard come from the one derivation.
  const [print, setPrint] = useState<PrintOutputFacts>(() =>
    printOutputFacts(null),
  );
  const activeProfile = print.profileName;
  const profileActive = print.profileActive;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [notice, setNotice] = useState<ExportNotice | null>(null);

  useEffect(() => {
    if (!notice || notice.diagnostics.length > 0) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Module-emitter subscription (the notifyPalette pattern).
  useEffect(() => {
    const fn = (action: DialogAction) => {
      setOpen(action === "open");
      if (action === "open") {
        setPhase({ kind: "idle" });
        setNotice(null);
      }
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  // Registered profile names — the X-4 output-intent choices.
  useEffect(() => {
    const off = client.subscribe((msg) => {
      if (msg.kind === "colorProfileRegistered") {
        const name = (msg.payload as { name: string }).name;
        setProfiles((prev) => (prev.includes(name) ? prev : [...prev, name]));
      }
    });
    return off;
  }, [client]);

  // Seed document name / active profile / page count on open.
  useEffect(() => {
    if (!open || !handle) return;
    let cancelled = false;
    void client.documentMeta().then((meta) => {
      if (cancelled) return;
      setDocName(meta.documentName || "document");
      const facts = printOutputFacts(meta);
      setPrint(facts);
      setPageCount(meta.pageCount);
      const canMeetX4 = facts.standard === "pdfx4";
      setForm((f) => ({
        ...f,
        pageTo: f.allPages ? String(meta.pageCount) : f.pageTo,
        // Finding PN-305 (UX audit F-11): the dialog opens on the
        // strictest standard the document can meet — PDF/X-4 when its
        // working space has an output intent (or a profile was picked),
        // PDF 1.7 otherwise — so the default always exports. X-4 stays an
        // informed choice in the menu. Not persisted: the next document
        // decides again.
        standard:
          canMeetX4 || f.outputIntentProfile !== ""
            ? loadSaved().standard
            : "pdf17",
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [open, handle, client]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        /* quota — last-used options are a convenience only */
      }
      return next;
    });
  };

  // X-4 needs an output intent with REAL bytes behind it: an
  // explicitly selected registered profile, or a working space the
  // worker reports as active (cmykProfileName alone can be a bare
  // designmap declaration with no bytes — not exportable).
  const x4ProfileMissing =
    form.standard === "pdfx4" &&
    form.outputIntentProfile === "" &&
    !profileActive;

  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const rangeInvalid = useMemo(() => {
    if (form.allPages) return false;
    const from = Number(form.pageFrom);
    const to = Number(form.pageTo);
    return (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < from ||
      to > pageCount
    );
  }, [form.allPages, form.pageFrom, form.pageTo, pageCount]);

  const exporting = phase.kind === "exporting";
  const canExport =
    handle != null && !exporting && !x4ProfileMissing && !rangeInvalid;

  const onExport = async () => {
    const options: ExportPdfWireOptions = {
      standard: form.standard,
      outputIntentProfile:
        form.outputIntentProfile === "" ? null : form.outputIntentProfile,
      outputCondition:
        form.standard === "pdfx4"
          ? ((form.outputIntentProfile || print.outputIntent) ?? null)
          : null,
      colorPolicy: form.colorPolicy,
      pageFrom: form.allPages ? null : Number(form.pageFrom) - 1,
      pageTo: form.allPages ? null : Number(form.pageTo) - 1,
      cropMarks: form.cropMarks,
      registrationMarks: form.registrationMarks,
      colorBars: form.colorBars,
      pageInfo: false,
      bleedOverridePt: form.useDocumentBleed
        ? null
        : [
            Number(form.bleedPt) || 0,
            Number(form.bleedPt) || 0,
            Number(form.bleedPt) || 0,
            Number(form.bleedPt) || 0,
          ],
      downsamplePpi: form.downsample === "off" ? null : Number(form.downsample),
      title: docName,
      bookmarks: form.bookmarks,
      tagged: form.tagged,
    };
    const fileName = `${docName}.pdf`;
    const pages = form.allPages
      ? pageCount
      : Number(form.pageTo) - Number(form.pageFrom) + 1;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "exporting", done: 0, total: 1 });
    // A promise chain, not try/finally: the React Compiler does not compile
    // a component with a `finally` in it (ADR 229).
    await client
      .exportPdf(options, {
        signal: controller.signal,
        onProgress: (done, total) =>
          setPhase({ kind: "exporting", done, total }),
      })
      .then(({ bytes, diagnostics }) => {
        const blob = new Blob([bytes.slice()], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        setPhase({ kind: "done", pages, diagnostics });
        // Done: the dialog closes and the notice says what was written.
        setOpen(false);
        setNotice({ fileName, pages, diagnostics });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          setPhase({ kind: "idle" });
        } else {
          setPhase({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        abortRef.current = null;
      });
  };

  const onCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
    } else {
      setOpen(false);
    }
  };

  const statusAttr =
    phase.kind === "exporting"
      ? "exporting"
      : phase.kind === "done"
        ? "done"
        : phase.kind === "error"
          ? "error"
          : "idle";

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Block closing via overlay/Escape mid-export; Cancel aborts.
          if (!next && exporting) return;
          setOpen(next);
        }}
      >
        <DialogContent data-export-dialog data-export-status={statusAttr}>
          <DialogHeader>
            <DialogTitle>{strings.t(EXPORT_PDF.title)}</DialogTitle>
            <DialogDescription>
              {strings.t(EXPORT_PDF.description)}
            </DialogDescription>
          </DialogHeader>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={fieldRow}>
              <span style={labelStyle}>
                {strings.t(EXPORT_PDF.conformance)}
              </span>
              <select
                data-export-standard
                value={form.standard}
                disabled={exporting}
                onChange={(e) =>
                  set("standard", e.target.value as FormState["standard"])
                }
              >
                <option value="pdfx4">PDF/X-4</option>
                <option value="pdf17">PDF 1.7</option>
              </select>
            </div>

            <div style={fieldRow}>
              <span style={labelStyle}>
                {strings.t(EXPORT_PDF.outputIntent)}
              </span>
              <select
                data-export-profile
                value={form.outputIntentProfile}
                disabled={exporting}
                onChange={(e) => set("outputIntentProfile", e.target.value)}
              >
                <option value="">
                  {activeProfile
                    ? strings.t(EXPORT_PDF.workingSpaceNamed, {
                        profile: workingProfileLabel(print),
                      })
                    : strings.t(EXPORT_PDF.workingSpace)}
                </option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            {x4ProfileMissing && (
              <div
                data-export-validation
                style={{
                  color: "var(--status-error)",
                  fontSize: 12,
                  marginLeft: 138,
                }}
              >
                {strings.t(EXPORT_PDF.x4NeedsProfile)}
              </div>
            )}

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.color)}</span>
              <select
                data-export-policy
                value={form.colorPolicy}
                disabled={exporting}
                onChange={(e) =>
                  set("colorPolicy", e.target.value as FormState["colorPolicy"])
                }
              >
                <option value="preserveNumbers">
                  {strings.t(EXPORT_PDF.preserveNumbers)}
                </option>
                <option value="convertToDestination">
                  {strings.t(EXPORT_PDF.convertToDestination)}
                </option>
              </select>
            </div>

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.pages)}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.allPages}
                  disabled={exporting}
                  onChange={(e) => set("allPages", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.allPages, { count: pageCount })}
              </label>
              {!form.allPages && (
                <>
                  <Input
                    data-export-page-from
                    style={{ width: 56 }}
                    value={form.pageFrom}
                    disabled={exporting}
                    onChange={(e) => set("pageFrom", e.target.value)}
                  />
                  <span>–</span>
                  <Input
                    data-export-page-to
                    style={{ width: 56 }}
                    value={form.pageTo}
                    disabled={exporting}
                    onChange={(e) => set("pageTo", e.target.value)}
                  />
                </>
              )}
            </div>
            {rangeInvalid && (
              <div
                style={{
                  color: "var(--status-error)",
                  fontSize: 12,
                  marginLeft: 138,
                }}
              >
                {strings.t(EXPORT_PDF.rangeInvalid, { count: pageCount })}
              </div>
            )}

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.bleed)}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.useDocumentBleed}
                  disabled={exporting}
                  onChange={(e) => set("useDocumentBleed", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.documentBleed)}
              </label>
              {!form.useDocumentBleed && (
                <>
                  <Input
                    style={{ width: 64 }}
                    value={form.bleedPt}
                    disabled={exporting}
                    onChange={(e) => set("bleedPt", e.target.value)}
                  />
                  <span style={{ opacity: 0.7 }}>
                    {strings.t(EXPORT_PDF.ptAllSides)}
                  </span>
                </>
              )}
            </div>

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.marks)}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.cropMarks}
                  disabled={exporting}
                  onChange={(e) => set("cropMarks", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.cropMarks)}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.registrationMarks}
                  disabled={exporting}
                  onChange={(e) => set("registrationMarks", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.registrationMarks)}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.colorBars}
                  disabled={exporting}
                  onChange={(e) => set("colorBars", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.colorBars)}
              </label>
            </div>

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.include)}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.bookmarks}
                  disabled={exporting}
                  onChange={(e) => set("bookmarks", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.bookmarks)}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.tagged}
                  disabled={exporting}
                  onChange={(e) => set("tagged", e.target.checked)}
                />
                {strings.t(EXPORT_PDF.tagged)}
              </label>
            </div>

            <div style={fieldRow}>
              <span style={labelStyle}>{strings.t(EXPORT_PDF.downsample)}</span>
              <select
                value={form.downsample}
                disabled={exporting}
                onChange={(e) =>
                  set("downsample", e.target.value as FormState["downsample"])
                }
              >
                <option value="off">
                  {strings.t(EXPORT_PDF.downsampleOff)}
                </option>
                <option value="300">
                  {strings.t(EXPORT_PDF.downsampleTo, { ppi: 300 })}
                </option>
                <option value="150">
                  {strings.t(EXPORT_PDF.downsampleTo, { ppi: 150 })}
                </option>
              </select>
            </div>

            {phase.kind === "exporting" && (
              <div data-export-progress style={{ marginTop: 4 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  {strings.t(EXPORT_PDF.progress, {
                    done: phase.done,
                    total: phase.total,
                  })}
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--muted)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${phase.total > 0 ? (phase.done / phase.total) * 100 : 0}%`,
                      background: "var(--pg-primary)",
                      transition: "width var(--dur-fast)",
                    }}
                  />
                </div>
              </div>
            )}
            {phase.kind === "error" && (
              <div
                data-export-error
                style={{ color: "var(--status-error)", fontSize: 12 }}
              >
                {strings.t(EXPORT_PDF.failed, { message: phase.message })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" data-export-cancel onClick={onCancel}>
              {strings.t(EXPORT_PDF.cancel)}
            </Button>
            <Button
              data-export-confirm
              disabled={!canExport}
              onClick={() => void onExport()}
            >
              {strings.t(EXPORT_PDF.export)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {notice && (
        <div role="status" data-export-notice style={noticeStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }}>
              {richText(
                strings.t(EXPORT_PDF.exported, { count: notice.pages }),
                { file: <strong>{notice.fileName}</strong> },
              )}
            </span>
            <button
              type="button"
              aria-label={strings.t(EXPORT_PDF.dismiss)}
              data-export-notice-close
              onClick={() => setNotice(null)}
              style={noticeCloseStyle}
            >
              <Icon name="ui-x" size={12} />
            </button>
          </div>
          {notice.diagnostics.length > 0 && (
            <div style={{ marginTop: 4, opacity: 0.8 }}>
              {strings.t(EXPORT_PDF.findings, {
                count: notice.diagnostics.length,
                list: notice.diagnostics.join("; "),
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const noticeStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 24,
  transform: "translateX(-50%)",
  zIndex: 60,
  maxWidth: 480,
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--chrome-border)",
  background: "var(--chrome-panel-bg)",
  color: "var(--pg-fg)",
  boxShadow: "0 6px 24px rgb(0 0 0 / 0.25)",
  fontSize: 12.5,
};

const noticeCloseStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--pg-muted-fg)",
  cursor: "pointer",
  padding: 2,
  lineHeight: 1,
};
