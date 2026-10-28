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

// Cockpit — the Export family's shared output model + live actions.
//
// W2.6 (Full-Green) — every output is now either LIVE (a real action
// through the published client surface) or HONEST (a visible,
// disabled concept seam). The three Export-mode panels (Outputs nav,
// Export Center table, Export inspector) read this single source so
// they stay in lockstep.
//
// LIVE outputs and the published capability behind each:
//   • pdf-x4 — `client.exportPdf(...)` (the ExportPdfDialog owns the
//     option form + page loop + download).
//   • image  — `client.requestSnapshot(pageId, widthPx, dpi)` → real
//     PNG bytes per page (the navigator/fidelity readback path).
//   • idml   — `client.exportIdml()` → real `.idml` package bytes.
//
// HONEST outputs (web / social / package) carry the "soon" pill and
// stay disabled until the multi-format publishing pipeline lands.

import {
  artboardFileName,
  artboardNameOf,
  type PageSummaryLike,
} from "@paged-media/tools";
import { useSyncExternalStore } from "react";
import type { CanvasClient } from "@paged-media/client";
import {
  createValueStore,
  editorStorage,
  oneOf,
  parseStored,
  printReadinessLabel,
  printStandardReason,
  readStoredShape,
  scoped,
  useScoped,
  type EditorScope,
  type ExporterContribution,
  type StorageAdapter,
  type PrintOutputFacts,
} from "@paged-media/shell";

import { defineMessages, t } from "@paged-media/strings";

import { downloadBytes } from "../../shell-file-saver";

const M = defineMessages("app.cockpitExportTargets", {
  comingSoon: "Coming soon",
  noDocument: "No document",
  ready: "Ready",
  printPdf: "Print PDF",
  printPdfNote:
    "PDF/X-4 with an output intent, else PDF 1.7 · text as text · " +
    "native CMYK + spot plates",
  pageImages: "Page images (PNG)",
  pageImagesNote: "Rasterised pages · pick resolution",
  web: "Web bundle",
  webNote: "Responsive HTML",
  social: "Social crops",
  socialNote: "Per-network image crops",
  package: "Print package",
  packageNote: "Document + links + fonts, zipped",
});

export type ExportTargetId = "pdf-x4" | "image" | "web" | "social" | "package";

export interface ExportTarget {
  id: ExportTargetId;
  icon: string;
  title: string;
  note: string;
  /** LIVE = a real action exists; HONEST = a disabled concept seam. */
  live: boolean;
  /** How a LIVE target runs (HONEST targets have no action).
   *  - "dialog": opens the ExportPdfDialog (settings live there)
   *  - "image":  runs the inline PNG page export (settings here)
   *  (IDML export moved to the paged.publish plugin exporter — ADR-022
   *  Phase 5 — so it's no longer a built-in target.) */
  action?: "dialog" | "image";
}

/** A target's readiness pill. The print PDF is the strictest standard
 *  the document can meet (finding PN-305, UX audit F-11): PDF/X-4 when
 *  the working space has an output intent, PDF 1.7 otherwise, and either
 *  one exports. The standard is the shared print-output fact (ADR 266),
 *  so Health and the Document Map read the same words. The other LIVE
 *  targets are ready the moment a document is open; HONEST targets read
 *  `soon`. */
export function exportReadiness(
  target: Pick<ExportTarget, "id" | "live">,
  loaded: boolean,
  facts: PrintOutputFacts,
  soon = t(M.comingSoon),
): { tone: "ready" | "warn" | "draft"; label: string; reason?: string } {
  if (!target.live) return { tone: "draft", label: soon };
  if (!loaded) return { tone: "draft", label: t(M.noDocument) };
  if (target.id === "pdf-x4") {
    return {
      tone: "ready",
      label: printReadinessLabel(facts),
      reason: printStandardReason(facts) ?? undefined,
    };
  }
  return { tone: "ready", label: t(M.ready) };
}

export const EXPORT_TARGETS: ExportTarget[] = [
  {
    id: "pdf-x4",
    icon: "ui-doc",
    // The words follow the editor's locale when read.
    get title() {
      return t(M.printPdf);
    },
    get note() {
      return t(M.printPdfNote);
    },
    live: true,
    action: "dialog",
  },
  {
    id: "image",
    icon: "ui-page",
    get title() {
      return t(M.pageImages);
    },
    get note() {
      return t(M.pageImagesNote);
    },
    live: true,
    action: "image",
  },
  // IDML export is now the paged.publish plugin's exporter (ADR-022 Phase 5)
  // — it appears in the Export Center's plugin-exporters section via the
  // registry, no longer a built-in static target.
  {
    id: "web",
    icon: "ui-web",
    get title() {
      return t(M.web);
    },
    get note() {
      return t(M.webNote);
    },
    live: false,
  },
  {
    id: "social",
    icon: "ui-social",
    get title() {
      return t(M.social);
    },
    get note() {
      return t(M.socialNote);
    },
    live: false,
  },
  {
    id: "package",
    icon: "ui-export",
    get title() {
      return t(M.package);
    },
    get note() {
      return t(M.packageNote);
    },
    live: false,
  },
];

export function exportTargetById(id: string): ExportTarget {
  return EXPORT_TARGETS.find((t) => t.id === id) ?? EXPORT_TARGETS[0];
}

// ── Tiny cross-panel store: which output target is selected. The
//    Outputs nav (left) writes; the Export inspector (right) and the
//    Export Center (canvas) read. In the editor's scope (plan task E1),
//    no provider plumbing. ─────────────────────────────────────────────
const SELECTED = scoped("exportTarget", () =>
  createValueStore<ExportTargetId>("pdf-x4"),
);
export function setSelectedExportTarget(
  scope: EditorScope,
  id: ExportTargetId,
): void {
  scope.get(SELECTED).set(id);
}
export function useSelectedExportTarget(): ExportTargetId {
  const store = useScoped(SELECTED);
  return useSyncExternalStore(store.subscribe, store.get);
}

// ── Inline per-output settings for the LIVE image output. Persisted
//    so the choice survives reloads (the ExportPdfDialog persists its
//    own form the same way). The image action reads this directly. ──
export interface ImageSettings {
  /** Output DPI — drives requestSnapshot's px width per page. */
  dpi: 72 | 150 | 300;
  /** "all" = every page; "current" = the active page only; "range" =
   *  the pages named by `range`.
   *
   *  E-2 — the range exists because all/current is a BINARY and the
   *  common ask sits between them ("pages 3-7", "the two covers"). This
   *  is paged's answer to Photoshop's `Export As → artboards`: the
   *  containment those artboards provide is already a page here, so
   *  what was missing was only the ability to name a SUBSET. */
  scope: "all" | "current" | "range";
  /** Output container. PNG is lossless with alpha; JPEG is smaller and
   *  has NO alpha, which is why the encoder flattens onto white first —
   *  see `encodePageImage`. */
  format: "png" | "jpeg";
  /** JPEG quality, 0.5–1. Ignored for PNG. */
  quality: number;
  /** A 1-based page list like `"1-3,5,8-10"`. Only read when
   *  `scope === "range"`. Kept as the typed STRING rather than a parsed
   *  array so a half-typed entry survives a re-render — parsing on
   *  every keystroke would fight the user. */
  range: string;
}

/** Parse a 1-based page range into ZERO-based indices, clamped to
 *  `pageCount` and de-duplicated, in ascending order.
 *
 *  Returns `null` for input that names no valid page, which the caller
 *  must treat as a REFUSAL rather than as "export everything" — a typo
 *  that silently writes 400 files is worse than one that writes none.
 *  Empty input is `null` for the same reason.
 *
 *  Deliberately tolerant of the shapes people actually type: spaces
 *  anywhere, a trailing comma, and a reversed pair (`7-3`) which reads
 *  as the same span rather than as nothing. */
export function parsePageRange(
  spec: string,
  pageCount: number,
): number[] | null {
  if (pageCount <= 0) return null;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(t);
    if (!m) return null; // a malformed token invalidates the whole spec
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (!(a >= 1) || !(b >= 1)) return null;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let n = lo; n <= hi; n++) {
      if (n <= pageCount) out.add(n - 1);
    }
  }
  return out.size === 0 ? null : [...out].sort((x, y) => x - y);
}

const IMAGE_KEY = "paged.export.image.v1";
const IMAGE_DEFAULTS: ImageSettings = {
  dpi: 150,
  scope: "all",
  range: "",
  format: "png",
  // 0.9, not 0.8: these are PAGE renders with type on them, and JPEG
  // ringing around glyph edges is the first thing a designer notices.
  quality: 0.9,
};

/** The editor's image settings, read from storage when first used. */
const IMAGE = scoped("exportImageSettings", (scope) =>
  createValueStore<ImageSettings>(loadImageSettings(editorStorage(scope))),
);

/** The stored settings, field by field: a value the panel never offers
 *  (a DPI of "huge" or 100000, an unknown scope) reads as the default
 *  (SH-102, ADR 247). */
function loadImageSettings(storage: StorageAdapter): ImageSettings {
  let raw: string | null = null;
  try {
    raw = storage.getItem(IMAGE_KEY);
  } catch {
    return IMAGE_DEFAULTS;
  }
  return readStoredShape(parseStored(raw), IMAGE_DEFAULTS, {
    dpi: oneOf(72, 150, 300),
    scope: oneOf("all", "current", "range"),
    format: oneOf("png", "jpeg"),
    quality: (q) => typeof q === "number" && q > 0 && q <= 1,
  });
}

export function setImageSettings(
  scope: EditorScope,
  patch: Partial<ImageSettings>,
): void {
  const store = scope.get(IMAGE);
  const next = { ...store.get(), ...patch };
  try {
    editorStorage(scope).setItem(IMAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota — last-used settings are a convenience only */
  }
  store.set(next);
}

export function useImageSettings(): ImageSettings {
  const store = useScoped(IMAGE);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Snapshot widths come from page width × DPI / 72 (the fidelity
 *  convention). One page → one PNG download. */
function pngWidthPx(pageWidthPt: number, dpi: number): number {
  return Math.max(1, Math.round((pageWidthPt * dpi) / 72));
}

export interface ImageExportResult {
  /** How many PNG files were produced (one per exported page). */
  files: number;
  /** Why nothing was written, when that was a REFUSAL rather than an
   *  empty document. `"range"` = the page range named no valid page. */
  refused?: "range";
}

/**
 * LIVE image output — rasterise the selected page range to PNG via
 * the published `client.requestSnapshot` and trigger one download per
 * page. Returns the file count so callers (and tests) can assert real
 * bytes were produced. `triggerDownload` is injectable so the action
 * stays unit-testable; it defaults to the Blob → object-URL → anchor
 * click pattern the PDF/IDML paths use.
 */
/** The index in `pageIds` of the document's active page, else 0. */
async function activePageIndexOf(
  client: Partial<Pick<CanvasClient, "documentMeta">>,
  pageIds: readonly string[],
): Promise<number> {
  const meta = await client.documentMeta?.().catch(() => null);
  const index = meta?.activePage ? pageIds.indexOf(meta.activePage) : -1;
  return Math.max(index, 0);
}

export async function runImageExport(
  client: Pick<CanvasClient, "requestSnapshot"> &
    Partial<Pick<CanvasClient, "documentMeta" | "collection">>,
  args: {
    pageIds: string[];
    pageSizesPt: ReadonlyArray<readonly [number, number]>;
    settings: ImageSettings;
    activePageIndex?: number;
    baseName?: string;
    /** Engine ADR 1011 — per page, its artboard's own name (null: none).
     *  A named board's file is named after it (unique, file-safe); the
     *  rest keep `<base>-pNN`. */
    pageNames?: ReadonlyArray<string | null>;
  },
  triggerDownload: (
    bytes: Uint8Array,
    filename: string,
  ) => void = defaultDownload,
): Promise<ImageExportResult> {
  const { pageIds, pageSizesPt, settings } = args;
  if (pageIds.length === 0) return { files: 0 };

  let indices: number[];
  if (settings.scope === "current") {
    // Finding PN-310: "Current page" is the page in view. A caller that
    // names no index gets the document's active page, not page 1.
    const active =
      args.activePageIndex ?? (await activePageIndexOf(client, pageIds));
    indices = [Math.min(Math.max(active, 0), pageIds.length - 1)];
  } else if (settings.scope === "range") {
    const parsed = parsePageRange(settings.range ?? "", pageIds.length);
    // REFUSE rather than fall back to every page. A range that parses
    // to nothing is a typo, and answering a typo with 400 files is the
    // worst of the three possible behaviours.
    if (parsed === null) return { files: 0, refused: "range" };
    indices = parsed;
  } else {
    indices = pageIds.map((_, i) => i);
  }

  const base = (args.baseName || "document").replace(/\.idml$/i, "");
  const pad = String(pageIds.length).length;
  let files = 0;
  const taken = new Set<string>();
  // Each artboard a file named after it (engine ADR 1011): the names come
  // from the pages' metadata unless the caller gave them.
  const names = args.pageNames ?? (await artboardNamesFor(client, pageIds));

  for (const i of indices) {
    const pageId = pageIds[i];
    const widthPt = pageSizesPt[i]?.[0] ?? 595; // A4-ish fallback
    const widthPx = pngWidthPx(widthPt, settings.dpi);
    const snap = await client.requestSnapshot(pageId, widthPx, settings.dpi);
    const png = Uint8Array.from(snap.pngBytes);
    const encoded = await encodePageImage(
      png,
      settings.format,
      settings.quality,
    );
    // A realm that cannot encode JPEG falls back to the PNG it already
    // has rather than writing nothing — the page still lands, and the
    // extension follows the bytes so the file is never mislabelled.
    const isJpeg = settings.format === "jpeg" && encoded !== null;
    const bytes = encoded ?? png;
    const ext = isJpeg ? "jpg" : "png";
    const own = names?.[i] ?? null;
    const label = own
      ? artboardFileName(own, ext, taken)
      : indices.length === 1
        ? `${base}.${ext}`
        : `${base}-p${String(i + 1).padStart(pad, "0")}.${ext}`;
    triggerDownload(bytes, label);
    files += 1;
  }

  return { files };
}

/** Per page id in `pageIds`, its artboard's own name (null: none); null
 *  when the client cannot read the pages. */
export async function artboardNamesFor(
  client: Partial<Pick<CanvasClient, "collection">>,
  pageIds: readonly string[],
): Promise<Array<string | null> | null> {
  if (!client.collection) return null;
  const pages = await client
    .collection<PageSummaryLike>("pages")
    .catch(() => null);
  if (!pages) return null;
  const byId = new Map(pages.map((p) => [p.selfId, artboardNameOf(p)]));
  return pageIds.map((id) => byId.get(id) ?? null);
}

function defaultDownload(bytes: Uint8Array, filename: string): void {
  downloadBytes(
    bytes,
    filename,
    filename.endsWith(".jpg") ? "image/jpeg" : "image/png",
  );
}

/**
 * Re-encode a page snapshot, which the engine always hands back as PNG.
 *
 * PNG passes through untouched — no decode, no re-encode, so a lossless
 * export stays byte-for-byte what the renderer produced.
 *
 * JPEG HAS NO ALPHA, so the bitmap is drawn onto an opaque WHITE canvas
 * before encoding — white because that is what paper is, and because it
 * matches what the PDF export puts behind the same page.
 *
 * BE PRECISE ABOUT WHY, because the obvious reason is not the true one
 * TODAY. A page snapshot is ALREADY opaque: core's `render_snapshot`
 * documents "background is white (matching the renderer's default for
 * `render_document`)" and its own test asserts an empty page comes back
 * `(255, 255, 255, 255)` in every pixel. So no transparency currently
 * reaches this function, and the flatten changes nothing.
 *
 * It stays anyway, and this is the argument: the day a
 * transparent-background PNG export appears — an ordinary ask, and the
 * only reason anyone picks PNG over JPEG for a page — the alpha becomes
 * real, and WITHOUT this the JPEG lane fails by rendering every
 * transparent region BLACK. A silent, ugly, whole-page failure. One
 * `fillRect` is a cheap price for removing that trapdoor, provided
 * nobody later reads this as "transparency happens here" and builds on
 * it. It does not, yet.
 *
 * Returns `null` when the realm has no imaging primitives (Node), so the
 * caller can fall back rather than throw.
 */
export async function encodePageImage(
  pngBytes: Uint8Array,
  format: "png" | "jpeg",
  quality: number,
): Promise<Uint8Array | null> {
  if (format === "png") return pngBytes;
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  const bmp = await createImageBitmap(
    new Blob([pngBytes.slice() as BlobPart], { type: "image/png" }),
  );
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: Math.min(Math.max(quality, 0.5), 1),
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bmp.close();
  }
}

/** K-2 / S-06 — run a plugin-registered exporter: pull its bytes and
 *  download them under its suggested name (the host owns blob→download,
 *  which is the whole point of the exporter contribution). Returns false
 *  when the exporter declined (a null result — nothing to export). */
export async function runPluginExporter(
  exporter: ExporterContribution,
  triggerDownload: (
    bytes: Uint8Array,
    filename: string,
    mimeType?: string,
  ) => void = pluginDownload,
): Promise<boolean> {
  const result = await exporter.export();
  if (!result) return false;
  triggerDownload(result.bytes, result.fileName, exporter.mimeType);
  return true;
}

// K-10 — plugin bytes leave the app through ONE mechanism: the exporter
// registry's delivery here and the bundle-driven `host.shell.saveFile` door
// are the same `downloadBytes` call, so the two paths cannot drift.
const pluginDownload = downloadBytes;

// runIdmlExport removed — IDML export is now the paged.publish plugin's
// exporter (ADR-022 Phase 5), run through the shared runPluginExporter above.
