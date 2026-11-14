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

// File ▸ Export PDF… — the guided PDF export (editor ADR 1221; the UX
// strategy's §6.6; UXI-FIL-004, UXI-FIL-005, UXI-FBK-003, UXI-FBK-004;
// UX audit F-12).
//
// One dialog, read top to bottom as the flow it is:
//
//   1. OUTPUT — a preset, the standard, the output intent, colour, the
//      pages (all, the page in view, or a range), bleed, marks, what to
//      include, image downsampling; the destination is the browser's
//      downloads, named before the export runs. Kit controls throughout
//      (`KitSelect`, `KitCheckbox`, segments), not the platform's.
//   2. READINESS — checked live from the options and what the document
//      says about itself, BEFORE anything starts (`export-readiness.ts`):
//      a blocker refuses the export with its reason and the panel that
//      fixes it (PDF/X-4 without an output intent is refused, never
//      written as if it met the standard: ADR 238); a warning is said and
//      the export may go ahead.
//   3. PREVIEW — the facts of the file: pages, page size, bleed, colour,
//      fonts, transparency, images, destination.
//   4. EXPORT — the stages as they happen: preparing, page n of N (the one
//      measurable stage, with a determinate bar), finishing; Cancel aborts
//      between pages and the engine drops its session.
//   5. RESULT — a PDF is only reported when its bytes are one (`%PDF-`);
//      the dialog closes and the one toast channel (editor ADR 1219) names
//      the file, the pages, where it went and the findings, with a way to
//      them. A failure stays in the dialog, worded as action, reason and
//      "Nothing changed." (an export never changes the document).
//
// A controlled React form, not a catalog composition: the fields are
// interdependent and the dialog owns the export loop (`client.exportPdf`
// page by page with an AbortController). `paged.file.exportPdf` only opens
// it through the editor's dialog event.

import { useEffect, useRef, useState } from "react";
import type {
  ExportPdfWireOptions,
  FontSummary,
  LinkSummary,
  PageSummary,
  PreflightFinding,
} from "@paged-media/client";
import { Segment } from "@paged-media/panel-kit";
import { KitCheckbox, KitSelect } from "@paged-media/ui";
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
import { useCanvasClient } from "../state/canvas-client-context";
import { useDocument } from "../state/document-context";
import {
  isRecord,
  oneOf,
  parseStored,
  readStoredShape,
} from "../lib/stored-settings";
import { printOutputFacts, workingProfileLabel } from "../lib/print-output";
import {
  exportAllowed,
  pageSpan,
  customBleedPt,
  pdfPreviewFacts,
  pdfReadiness,
  type PdfDocumentFacts,
  type ReadinessCheck,
} from "../lib/export-readiness";
import {
  useCollection,
  useDocumentMeta,
  useDocumentStats,
} from "../catalog/use-collection";
import { EXPORT_PDF } from "./messages";
import {
  createEmitter,
  scoped,
  useEditorScope,
  useScoped,
  type EditorScope,
} from "../state/editor-scope";
import { useEditorStorage, type StorageAdapter } from "../state/storage";
import { operationFeedbackOf } from "../state/operation-feedback";

type DialogAction = "open" | "close";
const DIALOG = scoped("exportPdfDialog", () => createEmitter<DialogAction>());

/** Open/close `scope`'s export dialog (command handlers, toolbars). */
export function notifyExportPdfDialog(
  scope: EditorScope,
  action: DialogAction,
): void {
  scope.get(DIALOG).emit(action);
}

/** What a finished export found (the Preflight panel and Publication
 *  health show the last run's findings). */
export interface PdfExportFindings {
  findings: PreflightFinding[];
  diagnostics: string[];
}
const EXPORTED = scoped("exportPdfResults", () => ({
  emitter: createEmitter<PdfExportFindings>(),
  last: null as PdfExportFindings | null,
}));

/** Hear every PDF export `scope`'s dialog finishes, starting with the last
 *  one if there was one; returns the unlisten. */
export function onPdfExported(
  scope: EditorScope,
  listener: (result: PdfExportFindings) => void,
): () => void {
  const slot = scope.get(EXPORTED);
  if (slot.last) listener(slot.last);
  return slot.emitter.subscribe(listener);
}

function notePdfExported(scope: EditorScope, result: PdfExportFindings): void {
  const slot = scope.get(EXPORTED);
  slot.last = result;
  slot.emitter.emit(result);
}

/** The feedback key of the export's result (one toast, updated). */
export const PDF_EXPORT_FEEDBACK_KEY = "paged.export.pdf";

/** Persisted last-used options (schema drift falls back to defaults). */
const OPTIONS_KEY = "paged.exportPdf.options.v1";
/** The user's named presets (ADR 247 shape check, entry by entry). */
const PRESETS_KEY = "paged.exportPdf.presets.v1";

export interface PdfFormState {
  standard: "pdfx4" | "pdf17";
  outputIntentProfile: string; // "" = active working space
  colorPolicy: "preserveNumbers" | "convertToDestination";
  pageScope: "all" | "current" | "range";
  pageFrom: string; // 1-based in the UI
  pageTo: string;
  useDocumentBleed: boolean;
  bleedPt: string; // uniform custom bleed
  cropMarks: boolean;
  registrationMarks: boolean;
  colorBars: boolean;
  downsample: "off" | "300" | "150";
  bookmarks: boolean;
  headingOutline: boolean;
  tagged: boolean;
  /** Write the comments as PDF annotations (engine ADR 1055). */
  comments: boolean;
}

export const PDF_FORM_DEFAULTS: PdfFormState = {
  standard: "pdfx4",
  outputIntentProfile: "",
  colorPolicy: "preserveNumbers",
  pageScope: "all",
  pageFrom: "1",
  pageTo: "1",
  useDocumentBleed: true,
  bleedPt: "0",
  cropMarks: false,
  registrationMarks: false,
  colorBars: false,
  downsample: "off",
  bookmarks: false,
  headingOutline: false,
  tagged: false,
  comments: false,
};

const FORM_CHECKS = {
  standard: oneOf("pdf17", "pdfx4"),
  colorPolicy: oneOf("preserveNumbers", "convertToDestination"),
  pageScope: oneOf("all", "current", "range"),
  downsample: oneOf("off", "300", "150"),
} as const;

/** The stored form, field by field: a value the dialog does not offer
 *  (`standard: "bogus"`) reads as the default rather than reaching the
 *  export (SH-103, ADR 247). A form stored before the page scope existed
 *  (`allPages: false`) reads as a range. */
export function loadPdfForm(storage: StorageAdapter): PdfFormState {
  let raw: string | null = null;
  try {
    raw = storage.getItem(OPTIONS_KEY);
  } catch {
    return PDF_FORM_DEFAULTS;
  }
  const stored = parseStored(raw);
  const form = readStoredShape(stored, PDF_FORM_DEFAULTS, FORM_CHECKS);
  if (isRecord(stored) && !("pageScope" in stored) && stored.allPages === false)
    return { ...form, pageScope: "range" };
  return form;
}

/** The fields a preset sets: everything but the pages and the profile,
 *  which belong to the document at hand. */
type PresetFields = Omit<
  PdfFormState,
  "pageScope" | "pageFrom" | "pageTo" | "outputIntentProfile"
>;
const PRESET_FIELDS = Object.keys(PDF_FORM_DEFAULTS).filter(
  (k) =>
    !["pageScope", "pageFrom", "pageTo", "outputIntentProfile"].includes(k),
) as (keyof PresetFields)[];

interface Preset {
  id: string;
  name: string;
  fields: Partial<PresetFields>;
}

/** The built-in presets: press, office print, screen. */
function builtInPresets(t: (key: string) => string): Preset[] {
  return [
    {
      id: "builtin:press",
      name: t(EXPORT_PDF.presetPress),
      fields: {
        standard: "pdfx4",
        colorPolicy: "preserveNumbers",
        useDocumentBleed: true,
        cropMarks: true,
        registrationMarks: true,
        colorBars: false,
        downsample: "off",
      },
    },
    {
      id: "builtin:print",
      name: t(EXPORT_PDF.presetPrint),
      fields: {
        standard: "pdf17",
        colorPolicy: "preserveNumbers",
        useDocumentBleed: true,
        cropMarks: false,
        registrationMarks: false,
        colorBars: false,
        downsample: "300",
      },
    },
    {
      id: "builtin:screen",
      name: t(EXPORT_PDF.presetScreen),
      fields: {
        standard: "pdf17",
        colorPolicy: "preserveNumbers",
        useDocumentBleed: false,
        bleedPt: "0",
        cropMarks: false,
        registrationMarks: false,
        colorBars: false,
        downsample: "150",
        bookmarks: true,
        tagged: true,
      },
    },
  ];
}

/** The user's presets as stored: an entry without a name, or with a field
 *  the dialog does not offer, keeps only what it may (ADR 247). */
export function loadPdfPresets(
  storage: StorageAdapter,
): Array<{ name: string; fields: Partial<PresetFields> }> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PRESETS_KEY);
  } catch {
    return [];
  }
  const stored = parseStored(raw);
  if (!Array.isArray(stored)) return [];
  const out: Array<{ name: string; fields: Partial<PresetFields> }> = [];
  for (const entry of stored.slice(0, MAX_PRESETS)) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (!name) continue;
    const full = readStoredShape(entry.fields, PDF_FORM_DEFAULTS, FORM_CHECKS);
    const fields: Partial<PresetFields> = {};
    for (const k of PRESET_FIELDS)
      (fields as Record<string, unknown>)[k] = full[k];
    out.push({ name, fields });
  }
  return out;
}

const MAX_PRESETS = 20;

type Phase =
  | { kind: "idle" }
  | {
      kind: "exporting";
      stage: "preparing" | "pages" | "finishing";
      done: number;
      total: number;
    }
  | { kind: "error"; message: string }
  | { kind: "canceled"; message: string };

/** Whether `bytes` are a PDF file (UXI-FIL-005: an artefact the export did
 *  not produce is never reported as one). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

export function ExportPdfDialog() {
  const [open, setOpen] = useState(false);
  // The editor's dialog event (the notifyPalette pattern).
  const dialog = useScoped(DIALOG);
  useEffect(
    () => dialog.subscribe((action) => setOpen(action === "open")),
    [dialog],
  );
  // The last export's findings belong to its document.
  const client = useCanvasClient();
  const exported = useScoped(EXPORTED);
  useEffect(
    () =>
      client.subscribe((msg) => {
        if (msg.kind === "documentLoaded") exported.last = null;
      }),
    [client, exported],
  );
  // The form mounts while the dialog is open, so its collections are read
  // then and not for the life of the editor.
  return open ? <ExportPdfForm onClose={() => setOpen(false)} /> : null;
}

function ExportPdfForm({ onClose }: { onClose: () => void }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const client = useCanvasClient();
  const { handle } = useDocument();
  const storage = useEditorStorage();
  const meta = useDocumentMeta();
  const stats = useDocumentStats();
  const fonts = useCollection<FontSummary>("fonts");
  const links = useCollection<LinkSummary>("links");
  const pages = useCollection<PageSummary>("pages");
  const [form, setForm] = useState<PdfFormState>(() => loadPdfForm(storage));
  const [presets, setPresets] = useState(() => loadPdfPresets(storage));
  const [presetId, setPresetId] = useState("");
  const [naming, setNaming] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const [standardSeeded, setStandardSeeded] = useState(false);

  // The print-output facts (ADR 266): the Export Center's pill and this
  // dialog's default standard come from the one derivation.
  const print = printOutputFacts(meta);
  const pageCount = meta?.pageCount ?? handle?.pageCount ?? 0;
  const currentPage = Math.max(
    0,
    meta?.activePage && handle ? handle.pageIds.indexOf(meta.activePage) : 0,
  );
  const docName = meta?.documentName || "document";

  // Finding PN-305 (UX audit F-11): the dialog opens on the strictest
  // standard the document can meet — PDF/X-4 when its working space has
  // an output intent (or a profile was picked), PDF 1.7 otherwise — so the
  // default always exports. X-4 stays an informed choice. Not persisted:
  // the next document decides again.
  // Seeded in render, the moment the meta arrives, so the standard and
  // the working space's label change together (React's "adjust state
  // when a prop changes").
  if (!standardSeeded && meta) {
    setStandardSeeded(true);
    const canMeetX4 = printOutputFacts(meta).standard === "pdfx4";
    setForm((f) => ({
      ...f,
      pageTo: f.pageScope === "range" ? f.pageTo : String(meta.pageCount),
      standard:
        canMeetX4 || f.outputIntentProfile !== ""
          ? loadPdfForm(storage).standard
          : "pdf17",
    }));
  }

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

  const persist = (next: PdfFormState) => {
    try {
      storage.setItem(OPTIONS_KEY, JSON.stringify(next));
    } catch {
      /* quota — last-used options are a convenience only */
    }
  };
  const set = <K extends keyof PdfFormState>(
    key: K,
    value: PdfFormState[K],
  ) => {
    setPresetId("");
    setForm((f) => {
      const next = { ...f, [key]: value };
      persist(next);
      return next;
    });
  };

  const allPresets: Preset[] = [
    ...builtInPresets((k) => strings.t(k)),
    ...presets.map((p) => ({ id: `user:${p.name}`, ...p })),
  ];
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = allPresets.find((p) => p.id === id);
    if (!preset) return;
    setForm((f) => {
      const next = { ...f, ...preset.fields };
      persist(next);
      return next;
    });
  };
  const savePreset = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const fields: Partial<PresetFields> = {};
    for (const k of PRESET_FIELDS)
      (fields as Record<string, unknown>)[k] = form[k];
    const next = [
      ...presets.filter((p) => p.name !== clean),
      { name: clean, fields },
    ].slice(-MAX_PRESETS);
    setPresets(next);
    try {
      storage.setItem(PRESETS_KEY, JSON.stringify(next));
    } catch {
      /* quota — a preset is a convenience only */
    }
    setPresetId(`user:${clean}`);
    setNaming(null);
  };

  const docFacts: PdfDocumentFacts = {
    loaded: handle != null && pageCount > 0,
    pageCount,
    currentPage,
    print,
    pages: pages
      ? pages.map((p) => ({
          sizePt: p.sizePt,
          bleedTopPt: p.bleedTopPt,
          bleedLeftPt: p.bleedLeftPt,
          bleedBottomPt: p.bleedBottomPt,
          bleedRightPt: p.bleedRightPt,
        }))
      : null,
    fonts,
    links,
    oversetStories: stats?.overset_stories ?? null,
    documentName: docName,
  };
  const checks = pdfReadiness(form, docFacts);
  const facts = pdfPreviewFacts(form, docFacts);
  const exporting = phase.kind === "exporting";
  const canExport = exportAllowed(checks) && !exporting;
  const blockers = checks.filter((c) => c.level === "blocker").length;
  const warnings = checks.filter((c) => c.level === "warning").length;

  // A fix opens the panel that makes it: the dialog closes first, so the
  // panel is not under a modal.
  const openFix = (check: ReadinessCheck) => {
    if (!check.fix) return;
    onClose();
    operationFeedbackOf(scope).runAction({
      label: check.fix.label,
      command: `paged.panel.show.${check.fix.panel}`,
    });
  };

  const onExport = async () => {
    const span = pageSpan(form, pageCount, currentPage);
    const bleed = form.useDocumentBleed ? null : customBleedPt(form);
    if (!canExport || !span) return;
    const allPages = span.from === 0 && span.to === pageCount - 1;
    const options: ExportPdfWireOptions = {
      standard: form.standard,
      outputIntentProfile:
        form.outputIntentProfile === "" ? null : form.outputIntentProfile,
      outputCondition:
        form.standard === "pdfx4"
          ? ((form.outputIntentProfile || print.outputIntent) ?? null)
          : null,
      colorPolicy: form.colorPolicy,
      pageFrom: allPages ? null : span.from,
      pageTo: allPages ? null : span.to,
      cropMarks: form.cropMarks,
      registrationMarks: form.registrationMarks,
      colorBars: form.colorBars,
      pageInfo: false,
      bleedOverridePt: bleed === null ? null : [bleed, bleed, bleed, bleed],
      downsamplePpi: form.downsample === "off" ? null : Number(form.downsample),
      title: docName,
      bookmarks: form.bookmarks,
      headingOutline: form.headingOutline,
      tagged: form.tagged,
      comments: form.comments,
    };
    const fileName = `${docName}.pdf`;
    const feedback = operationFeedbackOf(scope);
    const action = strings.t(EXPORT_PDF.action, { file: fileName });
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "exporting", stage: "preparing", done: 0, total: 0 });
    // A promise chain, not try/finally: the React Compiler does not compile
    // a component with a `finally` in it (ADR 229).
    await client
      .exportPdf(options, {
        signal: controller.signal,
        onProgress: (done, total) =>
          setPhase({
            kind: "exporting",
            stage: done >= total && total > 0 ? "finishing" : "pages",
            done,
            total,
          }),
      })
      .then(({ bytes, diagnostics: reported, findings: found0 }) => {
        const diagnostics = reported ?? [];
        const findings = found0 ?? [];
        // UXI-FIL-005: what the engine answered must BE a PDF before it is
        // delivered or called one.
        if (!looksLikePdf(bytes)) {
          const worded = feedback.report({
            action,
            outcome: "recoverable-failure",
            reason: strings.t(EXPORT_PDF.notAPdf),
            document: "unchanged",
            channel: "inline",
            source: "paged.export",
          });
          setPhase({ kind: "error", message: worded.sentence });
          return;
        }
        const blob = new Blob([bytes.slice()], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        notePdfExported(scope, { findings, diagnostics });
        const count = span.to - span.from + 1;
        const found =
          findings.length > 0 ? findings.length : diagnostics.length;
        const list =
          findings.length > 0
            ? findings.map((f) =>
                f.pageIndex != null
                  ? `${f.severity} · p${f.pageIndex + 1} · ${f.message}`
                  : `${f.severity} · ${f.message}`,
              )
            : diagnostics;
        // Done: the dialog closes and the one toast channel says what was
        // written, where, and what the export found (UXI-FBK-003).
        setPhase({ kind: "idle" });
        onClose();
        feedback.report({
          action,
          outcome: "success",
          prominent: true,
          title:
            found > 0
              ? strings.t(EXPORT_PDF.exportedFindings, {
                  file: fileName,
                  count,
                  findings: found,
                })
              : strings.t(EXPORT_PDF.exportedTo, { file: fileName, count }),
          ...(list.length > 0 ? { detail: list.join("\n") } : {}),
          ...(found > 0
            ? {
                actions: [
                  {
                    label: strings.t(EXPORT_PDF.showFindings),
                    command: "paged.panel.show.paged.preflight",
                  },
                ],
              }
            : {}),
          key: PDF_EXPORT_FEEDBACK_KEY,
          source: "paged.export",
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          const worded = feedback.report({
            action,
            outcome: "canceled",
            document: "unchanged",
            channel: "inline",
            source: "paged.export",
          });
          setPhase({ kind: "canceled", message: worded.sentence });
        } else {
          const worded = feedback.report({
            action,
            outcome: "recoverable-failure",
            reason: err instanceof Error ? err.message : String(err),
            document: "unchanged",
            channel: "inline",
            source: "paged.export",
          });
          setPhase({ kind: "error", message: worded.sentence });
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
      onClose();
    }
  };

  const statusAttr =
    phase.kind === "exporting"
      ? "exporting"
      : phase.kind === "error"
        ? "error"
        : "idle";

  const stageText =
    phase.kind !== "exporting"
      ? ""
      : phase.stage === "preparing"
        ? strings.t(EXPORT_PDF.stagePreparing)
        : phase.stage === "finishing"
          ? strings.t(EXPORT_PDF.stageFinishing)
          : strings.t(EXPORT_PDF.progress, {
              done: phase.done,
              total: phase.total,
            });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Block closing via overlay/Escape mid-export; Cancel aborts.
        if (!next && exporting) return;
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-export-dialog
        data-export-status={statusAttr}
        data-export-ready={canExport ? "" : undefined}
        className="max-w-xl"
        style={{ maxHeight: "88vh", overflowY: "auto" }}
      >
        <DialogHeader>
          <DialogTitle>{strings.t(EXPORT_PDF.title)}</DialogTitle>
          <DialogDescription>
            {strings.t(EXPORT_PDF.description)}
          </DialogDescription>
        </DialogHeader>

        <section data-export-step="output" style={sectionStyle}>
          <h3 style={kickerStyle}>{strings.t(EXPORT_PDF.stepOutput)}</h3>
          <Row label={strings.t(EXPORT_PDF.preset)}>
            <KitSelect
              data-export-preset
              value={presetId}
              disabled={exporting}
              onChange={(e) => applyPreset(e.target.value)}
            >
              <option value="">{strings.t(EXPORT_PDF.presetCustom)}</option>
              {allPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </KitSelect>
            {naming === null ? (
              <Button
                variant="outline"
                size="sm"
                data-export-preset-save
                disabled={exporting}
                onClick={() => setNaming("")}
              >
                {strings.t(EXPORT_PDF.savePreset)}
              </Button>
            ) : null}
          </Row>
          {naming !== null && (
            <Row label="">
              <Input
                data-export-preset-name
                aria-label={strings.t(EXPORT_PDF.presetName)}
                placeholder={strings.t(EXPORT_PDF.presetName)}
                value={naming}
                autoFocus
                className="h-[30px]"
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    savePreset(naming);
                  }
                }}
              />
              <Button
                size="sm"
                data-export-preset-confirm
                disabled={naming.trim() === ""}
                onClick={() => savePreset(naming)}
              >
                {strings.t(EXPORT_PDF.save)}
              </Button>
            </Row>
          )}
          <Row label={strings.t(EXPORT_PDF.conformance)}>
            <KitSelect
              data-export-standard
              value={form.standard}
              disabled={exporting}
              onChange={(e) =>
                set("standard", e.target.value as PdfFormState["standard"])
              }
            >
              <option value="pdfx4">PDF/X-4</option>
              <option value="pdf17">PDF 1.7</option>
            </KitSelect>
          </Row>
          <Row label={strings.t(EXPORT_PDF.outputIntent)}>
            <KitSelect
              data-export-profile
              value={form.outputIntentProfile}
              disabled={exporting}
              onChange={(e) => set("outputIntentProfile", e.target.value)}
            >
              <option value="">
                {print.profileName
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
            </KitSelect>
          </Row>
          <Row label={strings.t(EXPORT_PDF.color)}>
            <KitSelect
              data-export-policy
              value={form.colorPolicy}
              disabled={exporting}
              onChange={(e) =>
                set(
                  "colorPolicy",
                  e.target.value as PdfFormState["colorPolicy"],
                )
              }
            >
              <option value="preserveNumbers">
                {strings.t(EXPORT_PDF.preserveNumbers)}
              </option>
              <option value="convertToDestination">
                {strings.t(EXPORT_PDF.convertToDestination)}
              </option>
            </KitSelect>
          </Row>
          <Row label={strings.t(EXPORT_PDF.pages)}>
            <div
              role="group"
              aria-label={strings.t(EXPORT_PDF.pages)}
              data-export-page-scope
              style={segmentGroupStyle}
            >
              {(
                [
                  ["all", strings.t(EXPORT_PDF.allPages, { count: pageCount })],
                  ["current", strings.t(EXPORT_PDF.currentPage)],
                  ["range", strings.t(EXPORT_PDF.range)],
                ] as const
              ).map(([value, label], i) => (
                <Segment
                  key={value}
                  pressed={form.pageScope === value}
                  disabled={exporting}
                  data-export-page-scope-option={value}
                  onClick={() => set("pageScope", value)}
                  style={segmentStyle(form.pageScope === value, i < 2)}
                >
                  {label}
                </Segment>
              ))}
            </div>
          </Row>
          {form.pageScope === "range" && (
            <Row label="">
              <Input
                data-export-page-from
                aria-label={strings.t(EXPORT_PDF.fromPage)}
                className="h-[30px]"
                style={{ width: 64 }}
                inputMode="numeric"
                value={form.pageFrom}
                disabled={exporting}
                onChange={(e) => set("pageFrom", e.target.value)}
              />
              <span>–</span>
              <Input
                data-export-page-to
                aria-label={strings.t(EXPORT_PDF.toPage)}
                className="h-[30px]"
                style={{ width: 64 }}
                inputMode="numeric"
                value={form.pageTo}
                disabled={exporting}
                onChange={(e) => set("pageTo", e.target.value)}
              />
            </Row>
          )}
          <Row label={strings.t(EXPORT_PDF.bleed)}>
            <KitCheckbox
              data-export-document-bleed
              checked={form.useDocumentBleed}
              disabled={exporting}
              onChange={(e) => set("useDocumentBleed", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.documentBleed)}
            </KitCheckbox>
            {!form.useDocumentBleed && (
              <>
                <Input
                  data-export-bleed
                  aria-label={strings.t(EXPORT_PDF.bleed)}
                  className="h-[30px]"
                  style={{ width: 64 }}
                  inputMode="decimal"
                  value={form.bleedPt}
                  disabled={exporting}
                  onChange={(e) => set("bleedPt", e.target.value)}
                />
                <span style={{ opacity: 0.7 }}>
                  {strings.t(EXPORT_PDF.ptAllSides)}
                </span>
              </>
            )}
          </Row>
          <Row label={strings.t(EXPORT_PDF.marks)}>
            <KitCheckbox
              checked={form.cropMarks}
              disabled={exporting}
              onChange={(e) => set("cropMarks", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.cropMarks)}
            </KitCheckbox>
            <KitCheckbox
              checked={form.registrationMarks}
              disabled={exporting}
              onChange={(e) => set("registrationMarks", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.registrationMarks)}
            </KitCheckbox>
            <KitCheckbox
              checked={form.colorBars}
              disabled={exporting}
              onChange={(e) => set("colorBars", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.colorBars)}
            </KitCheckbox>
          </Row>
          <Row label={strings.t(EXPORT_PDF.include)}>
            <KitCheckbox
              checked={form.bookmarks}
              disabled={exporting}
              onChange={(e) => set("bookmarks", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.bookmarks)}
            </KitCheckbox>
            <KitCheckbox
              data-export-heading-outline
              checked={form.headingOutline}
              disabled={exporting}
              onChange={(e) => set("headingOutline", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.headingOutline)}
            </KitCheckbox>
            <KitCheckbox
              checked={form.tagged}
              disabled={exporting}
              onChange={(e) => set("tagged", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.tagged)}
            </KitCheckbox>
            <KitCheckbox
              data-export-comments
              checked={form.comments}
              disabled={exporting}
              onChange={(e) => set("comments", e.target.checked)}
            >
              {strings.t(EXPORT_PDF.comments)}
            </KitCheckbox>
          </Row>
          <Row label={strings.t(EXPORT_PDF.downsample)}>
            <KitSelect
              data-export-downsample
              value={form.downsample}
              disabled={exporting}
              onChange={(e) =>
                set("downsample", e.target.value as PdfFormState["downsample"])
              }
            >
              <option value="off">{strings.t(EXPORT_PDF.downsampleOff)}</option>
              <option value="300">
                {strings.t(EXPORT_PDF.downsampleTo, { ppi: 300 })}
              </option>
              <option value="150">
                {strings.t(EXPORT_PDF.downsampleTo, { ppi: 150 })}
              </option>
            </KitSelect>
          </Row>
        </section>

        <section
          data-export-step="readiness"
          data-export-blockers={blockers}
          data-export-warnings={warnings}
          style={sectionStyle}
        >
          <h3 style={kickerStyle}>{strings.t(EXPORT_PDF.stepReadiness)}</h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {checks.map((c) => (
              <li
                key={c.id}
                data-export-check={c.id}
                data-export-check-level={c.level}
                // The X-4 blocker keeps the attribute the export's specs
                // have always read.
                data-export-validation={
                  c.id === "standard" && c.level === "blocker" ? "" : undefined
                }
                style={checkStyle}
              >
                <span aria-hidden style={dotStyle(c.level)} />
                <span style={{ flex: 1 }}>
                  <span className="sr-only">
                    {strings.t(
                      c.level === "blocker"
                        ? EXPORT_PDF.levelBlocker
                        : c.level === "warning"
                          ? EXPORT_PDF.levelWarning
                          : EXPORT_PDF.levelOk,
                    )}
                    {": "}
                  </span>
                  {c.text}
                </span>
                {c.fix && (
                  <button
                    type="button"
                    data-export-check-fix={c.fix.panel}
                    onClick={() => openFix(c)}
                    style={linkStyle}
                  >
                    {c.fix.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section data-export-step="preview" style={sectionStyle}>
          <h3 style={kickerStyle}>{strings.t(EXPORT_PDF.stepPreview)}</h3>
          <dl style={factsStyle}>
            {facts.map((f) => (
              <div
                key={f.id}
                data-export-fact={f.id}
                style={{ display: "contents" }}
              >
                <dt style={{ color: "var(--pg-muted-fg)" }}>{f.label}</dt>
                <dd style={{ margin: 0 }}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {phase.kind === "exporting" && (
          <div
            data-export-progress
            data-export-stage={phase.stage}
            role="status"
            style={{ marginTop: 4 }}
          >
            <div style={{ fontSize: 12, marginBottom: 4 }}>{stageText}</div>
            {phase.stage === "pages" && phase.total > 0 ? (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={phase.total}
                aria-valuenow={phase.done}
                aria-label={stageText}
                style={barTrackStyle}
              >
                <div
                  style={{
                    ...barFillStyle,
                    width: `${(phase.done / phase.total) * 100}%`,
                  }}
                />
              </div>
            ) : (
              // A stage with no measure shows no percent (UXI-FBK-004).
              <div
                role="progressbar"
                aria-label={stageText}
                data-export-indeterminate
                style={barTrackStyle}
              >
                <div
                  style={{ ...barFillStyle, width: "100%", opacity: 0.35 }}
                />
              </div>
            )}
          </div>
        )}
        {phase.kind === "error" && (
          <div
            data-export-error
            role="alert"
            style={{ color: "var(--status-error)", fontSize: 12 }}
          >
            {phase.message}
          </div>
        )}
        {phase.kind === "canceled" && (
          <div data-export-canceled role="status" style={{ fontSize: 12 }}>
            {phase.message}
          </div>
        )}

        <DialogFooter>
          <span
            data-export-summary
            className="pg-ui-xs"
            style={{ marginRight: "auto", alignSelf: "center" }}
          >
            {blockers > 0
              ? strings.t(EXPORT_PDF.summaryBlocked, { count: blockers })
              : warnings > 0
                ? strings.t(EXPORT_PDF.summaryWarnings, { count: warnings })
                : strings.t(EXPORT_PDF.summaryReady)}
          </span>
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
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <div style={rowBodyStyle}>{children}</div>
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const kickerStyle: React.CSSProperties = {
  margin: 0,
  font: "700 10px var(--font-sans)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
};

const labelStyle: React.CSSProperties = {
  width: 120,
  flex: "none",
  color: "var(--pg-muted-fg)",
};

const rowBodyStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px 12px",
  flex: 1,
  minWidth: 0,
};

const segmentGroupStyle: React.CSSProperties = {
  display: "inline-flex",
  overflow: "hidden",
  borderRadius: 6,
  border: "1px solid var(--pg-border)",
};

function segmentStyle(active: boolean, divider: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    border: "none",
    borderRight: divider ? "1px solid var(--pg-border)" : "none",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    cursor: "pointer",
    background: active ? "var(--chrome-slot-active)" : "var(--pg-bg)",
    color: active ? "var(--chrome-icon-active)" : "var(--pg-muted-fg)",
  };
}

const checkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  padding: "3px 0",
  fontSize: 12.5,
  lineHeight: 1.45,
};

function dotStyle(level: ReadinessCheck["level"]): React.CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flex: "none",
    transform: "translateY(-1px)",
    background:
      level === "blocker"
        ? "var(--status-error)"
        : level === "warning"
          ? "var(--status-review)"
          : "var(--status-approved)",
  };
}

const linkStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontWeight: 600,
  color: "var(--pg-primary)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const factsStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "120px 1fr",
  gap: "4px 8px",
  margin: 0,
  fontSize: 12.5,
};

const barTrackStyle: React.CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: "var(--muted)",
  overflow: "hidden",
};

const barFillStyle: React.CSSProperties = {
  height: "100%",
  background: "var(--pg-primary)",
  transition: "width var(--dur-fast)",
};
