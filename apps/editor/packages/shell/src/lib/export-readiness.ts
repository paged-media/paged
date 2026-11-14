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

// The PDF export's readiness check and preview facts (editor ADR 1221,
// "Guided export"; the interaction specification's UXI-FIL-004; the UX
// strategy's §6.6). PURE: from the options the user chose and what the
// document says about itself — its meta (the print-output facts, ADR 266),
// its pages, fonts and links collections and its stats — before anything
// is sent to the engine.
//
//   · A BLOCKER refuses the export with its reason: no document, PDF/X-4
//     without an output intent profile (ADR 238: an impossible standard is
//     never written as if it were met), a page range outside the document,
//     a custom bleed that is no length.
//   · A WARNING is said and the export may go ahead: missing fonts (a
//     substitute is embedded), missing links, pictures below 150 ppi,
//     overset text. Each names the panel that fixes it.
//   · The FACTS are what the file will be: pages, page size, bleed, colour
//     (standard, output intent, colour policy), fonts, transparency and
//     images — each worded as the exporter does it (`paged-export-pdf`:
//     fonts are embedded as subsets, transparency stays live, placed
//     images pass through unless downsampled).

import { defineMessages, t } from "@paged-media/strings";

import {
  printStandardLabel,
  workingProfileLabel,
  type PrintOutputFacts,
} from "./print-output";

/** Which pages an export writes. */
export type PdfPageScope = "all" | "current" | "range";

/** The options of a PDF export that the check reads. */
export interface PdfExportPlan {
  standard: "pdfx4" | "pdf17";
  /** A registered profile's name; "" = the document's working space. */
  outputIntentProfile: string;
  colorPolicy: "preserveNumbers" | "convertToDestination";
  pageScope: PdfPageScope;
  /** 1-based, as typed. */
  pageFrom: string;
  pageTo: string;
  useDocumentBleed: boolean;
  /** Uniform custom bleed in points, as typed. */
  bleedPt: string;
  downsample: "off" | "300" | "150";
}

/** One page as the pages collection reports it. */
export interface PdfPageFacts {
  sizePt: readonly [number, number];
  bleedTopPt?: number;
  bleedLeftPt?: number;
  bleedBottomPt?: number;
  bleedRightPt?: number;
}

/** What the document says about itself. */
export interface PdfDocumentFacts {
  loaded: boolean;
  pageCount: number;
  /** The page in view, 0-based. */
  currentPage: number;
  print: PrintOutputFacts;
  pages: readonly PdfPageFacts[] | null;
  fonts: ReadonlyArray<{ family: string; isMissing?: boolean }> | null;
  links: ReadonlyArray<{
    status?: string | null;
    effectivePpi?: number | null;
  }> | null;
  oversetStories: number | null;
  documentName: string;
}

export type ReadinessLevel = "blocker" | "warning" | "ok";

/** One line of the check. */
export interface ReadinessCheck {
  id: string;
  level: ReadinessLevel;
  text: string;
  /** The panel that fixes it. */
  fix?: { label: string; panel: string };
}

/** One fact of the preview. */
export interface PreviewFact {
  id: string;
  label: string;
  value: string;
}

/** Below this, a placed picture is flagged (the panels' shared floor). */
export const LOW_RES_PPI = 150;

const M = defineMessages("shell.exportReadiness", {
  noDocument: "No document is open.",
  x4NeedsProfile:
    "PDF/X-4 needs an output intent profile and this document has none: load one in Color settings, or export PDF 1.7.",
  x4Ready: "PDF/X-4 embeds {profile} as its output intent.",
  pdf17Ready: "PDF 1.7 needs no output intent.",
  rangeInvalid: "The page range must lie within pages 1 to {count}.",
  bleedInvalid: "The custom bleed must be a length of 0 pt or more.",
  fontsMissing:
    "{count, plural, one {# font is missing: text set in it is} other {# fonts are missing: text set in them is}} embedded in a substitute font.",
  linksMissing:
    "{count, plural, one {# linked picture is missing: the PDF shows what the canvas shows for it} other {# linked pictures are missing: the PDF shows what the canvas shows for them}}.",
  lowRes:
    "{count, plural, one {# picture is} other {# pictures are}} below {ppi} ppi at the placed size.",
  overset:
    "{count, plural, one {# story has} other {# stories have}} overset text: text that does not fit is not in the PDF.",
  fontsOk: "Every font is available.",
  linksOk: "Every linked picture is found.",
  colorSettings: "Color settings",
  fontsPanel: "Fonts",
  linksPanel: "Links",
  storiesPanel: "Stories",
  pages: "Pages",
  pagesAll: "{count, plural, one {# page} other {all # pages}}",
  pageOne: "page {from}",
  pagesSpan: "{count} pages, {from} to {to}",
  pagesInvalid: "No valid range",
  size: "Page size",
  sizeOne: "{w} × {h} pt ({wmm} × {hmm} mm)",
  sizeMixed: "{count} page sizes",
  bleed: "Bleed",
  bleedNone: "None",
  bleedEven: "{pt} pt on every side",
  bleedSides: "{top} / {left} / {bottom} / {right} pt",
  color: "Colour",
  colorX4: "{standard} · output intent {profile} · {policy}",
  colorPdf17: "{standard} · no output intent · {policy}",
  preserve: "colour numbers kept",
  convert: "converted to the output intent",
  fonts: "Fonts",
  fontsEmbedded:
    "{count, plural, one {# family} other {# families}} embedded as subsets",
  fontsEmbeddedMissing:
    "{count, plural, one {# family} other {# families}} embedded as subsets · {missing} substituted",
  fontsUnknown: "Listed once the document's fonts are read",
  transparency: "Transparency",
  transparencyLive: "Kept live, not flattened",
  images: "Images",
  imagesPass: "Placed images pass through unchanged",
  imagesDown: "Downsampled to {ppi} ppi where finer",
  destination: "Destination",
  download: "Download: {file}",
});

/** The pages the plan writes, 0-based and inclusive; null when its range
 *  names no page of the document. */
export function pageSpan(
  plan: Pick<PdfExportPlan, "pageScope" | "pageFrom" | "pageTo">,
  pageCount: number,
  currentPage: number,
): { from: number; to: number } | null {
  if (pageCount <= 0) return null;
  if (plan.pageScope === "all") return { from: 0, to: pageCount - 1 };
  if (plan.pageScope === "current") {
    const at = Math.min(Math.max(currentPage, 0), pageCount - 1);
    return { from: at, to: at };
  }
  const from = Number(plan.pageFrom.trim());
  const to = Number(plan.pageTo.trim());
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    to > pageCount
  )
    return null;
  return { from: from - 1, to: to - 1 };
}

/** The custom bleed in points; null when it is no length. */
export function customBleedPt(
  plan: Pick<PdfExportPlan, "bleedPt">,
): number | null {
  const text = plan.bleedPt.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Whether the standard the plan asks for can be met. */
export function standardBlocked(
  plan: Pick<PdfExportPlan, "standard" | "outputIntentProfile">,
  print: PrintOutputFacts,
): boolean {
  return (
    plan.standard === "pdfx4" &&
    plan.outputIntentProfile === "" &&
    !print.profileActive
  );
}

/** The check, blockers first. */
export function pdfReadiness(
  plan: PdfExportPlan,
  doc: PdfDocumentFacts,
): ReadinessCheck[] {
  if (!doc.loaded)
    return [{ id: "document", level: "blocker", text: t(M.noDocument) }];
  const out: ReadinessCheck[] = [];
  if (standardBlocked(plan, doc.print)) {
    out.push({
      id: "standard",
      level: "blocker",
      text: t(M.x4NeedsProfile),
      fix: { label: t(M.colorSettings), panel: "paged.color-settings" },
    });
  } else {
    out.push({
      id: "standard",
      level: "ok",
      text:
        plan.standard === "pdfx4"
          ? t(M.x4Ready, {
              profile:
                plan.outputIntentProfile || workingProfileLabel(doc.print),
            })
          : t(M.pdf17Ready),
    });
  }
  if (!pageSpan(plan, doc.pageCount, doc.currentPage))
    out.push({
      id: "range",
      level: "blocker",
      text: t(M.rangeInvalid, { count: doc.pageCount }),
    });
  if (!plan.useDocumentBleed && customBleedPt(plan) === null)
    out.push({ id: "bleed", level: "blocker", text: t(M.bleedInvalid) });

  const missingFonts = (doc.fonts ?? []).filter((f) => f.isMissing).length;
  if (missingFonts > 0)
    out.push({
      id: "fonts",
      level: "warning",
      text: t(M.fontsMissing, { count: missingFonts }),
      fix: { label: t(M.fontsPanel), panel: "paged.fonts" },
    });
  else if (doc.fonts)
    out.push({ id: "fonts", level: "ok", text: t(M.fontsOk) });

  const links = doc.links ?? [];
  const missingLinks = links.filter((l) => l.status === "missing").length;
  if (missingLinks > 0)
    out.push({
      id: "links",
      level: "warning",
      text: t(M.linksMissing, { count: missingLinks }),
      fix: { label: t(M.linksPanel), panel: "paged.links" },
    });
  else if (doc.links && links.length > 0)
    out.push({ id: "links", level: "ok", text: t(M.linksOk) });
  const lowRes = links.filter(
    (l) => l.effectivePpi != null && l.effectivePpi < LOW_RES_PPI,
  ).length;
  if (lowRes > 0)
    out.push({
      id: "resolution",
      level: "warning",
      text: t(M.lowRes, { count: lowRes, ppi: LOW_RES_PPI }),
      fix: { label: t(M.linksPanel), panel: "paged.links" },
    });
  if ((doc.oversetStories ?? 0) > 0)
    out.push({
      id: "overset",
      level: "warning",
      text: t(M.overset, { count: doc.oversetStories ?? 0 }),
      fix: { label: t(M.storiesPanel), panel: "paged.stories" },
    });
  const rank = { blocker: 0, warning: 1, ok: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Whether the check lets the export start (no blocker). */
export function exportAllowed(checks: readonly ReadinessCheck[]): boolean {
  return !checks.some((c) => c.level === "blocker");
}

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};
const MM_PER_PT = 25.4 / 72;

/** What the file will be. */
export function pdfPreviewFacts(
  plan: PdfExportPlan,
  doc: PdfDocumentFacts,
): PreviewFact[] {
  const span = pageSpan(plan, doc.pageCount, doc.currentPage);
  const facts: PreviewFact[] = [];
  facts.push({
    id: "pages",
    label: t(M.pages),
    value: !span
      ? t(M.pagesInvalid)
      : plan.pageScope === "all"
        ? t(M.pagesAll, { count: doc.pageCount })
        : span.from === span.to
          ? t(M.pageOne, { from: span.from + 1 })
          : t(M.pagesSpan, {
              count: span.to - span.from + 1,
              from: span.from + 1,
              to: span.to + 1,
            }),
  });
  const pages =
    span && doc.pages ? doc.pages.slice(span.from, span.to + 1) : [];
  if (pages.length > 0) {
    const sizes = new Set(
      pages.map((p) => `${round(p.sizePt[0], 2)}x${round(p.sizePt[1], 2)}`),
    );
    const [w, h] = pages[0]!.sizePt;
    facts.push({
      id: "size",
      label: t(M.size),
      value:
        sizes.size > 1
          ? t(M.sizeMixed, { count: sizes.size })
          : t(M.sizeOne, {
              w: round(w),
              h: round(h),
              wmm: round(w * MM_PER_PT),
              hmm: round(h * MM_PER_PT),
            }),
    });
  }
  let bleed: string;
  if (!plan.useDocumentBleed) {
    const pt = customBleedPt(plan);
    bleed =
      pt === null
        ? "—"
        : pt === 0
          ? t(M.bleedNone)
          : t(M.bleedEven, { pt: round(pt) });
  } else {
    const p = pages[0];
    const sides = [
      p?.bleedTopPt ?? 0,
      p?.bleedLeftPt ?? 0,
      p?.bleedBottomPt ?? 0,
      p?.bleedRightPt ?? 0,
    ];
    bleed = sides.every((s) => s === 0)
      ? t(M.bleedNone)
      : sides.every((s) => s === sides[0])
        ? t(M.bleedEven, { pt: round(sides[0]!) })
        : t(M.bleedSides, {
            top: round(sides[0]!),
            left: round(sides[1]!),
            bottom: round(sides[2]!),
            right: round(sides[3]!),
          });
  }
  facts.push({ id: "bleed", label: t(M.bleed), value: bleed });
  const policy = t(
    plan.colorPolicy === "preserveNumbers" ? M.preserve : M.convert,
  );
  facts.push({
    id: "color",
    label: t(M.color),
    value:
      plan.standard === "pdfx4"
        ? t(M.colorX4, {
            standard: printStandardLabel("pdfx4"),
            profile: plan.outputIntentProfile || workingProfileLabel(doc.print),
            policy,
          })
        : t(M.colorPdf17, { standard: printStandardLabel("pdf17"), policy }),
  });
  const fonts = doc.fonts;
  const missing = (fonts ?? []).filter((f) => f.isMissing).length;
  facts.push({
    id: "fonts",
    label: t(M.fonts),
    value: !fonts
      ? t(M.fontsUnknown)
      : missing > 0
        ? t(M.fontsEmbeddedMissing, { count: fonts.length, missing })
        : t(M.fontsEmbedded, { count: fonts.length }),
  });
  facts.push({
    id: "transparency",
    label: t(M.transparency),
    value: t(M.transparencyLive),
  });
  facts.push({
    id: "images",
    label: t(M.images),
    value:
      plan.downsample === "off"
        ? t(M.imagesPass)
        : t(M.imagesDown, { ppi: Number(plan.downsample) }),
  });
  facts.push({
    id: "destination",
    label: t(M.destination),
    value: t(M.download, { file: `${doc.documentName || "document"}.pdf` }),
  });
  return facts;
}
