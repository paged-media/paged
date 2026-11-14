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

// Whether the publication meets its contract (editor ADR 1236), assessed
// continuously from what the document says about itself. The export's own
// readiness check (`pdfReadiness`, editor ADR 1221) answers what it already
// answers — the standard can be met, fonts and links are found, no story
// runs over — and the contract adds only what it promises beyond that: the
// trim size, the bleed, the output intent and its profile, no RGB pictures,
// the allowed font families, its resolution floor, complete data, and the
// approval. One checker, not two. PURE.

import type { ElementId } from "@paged-media/client";
import {
  pdfReadiness,
  workingProfileLabel,
  type PrintOutputFacts,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import type { PublicationContract } from "./model";

export type ContractLevel = "blocker" | "warning" | "info" | "ok";

export interface ContractCheck {
  id: string;
  level: ContractLevel;
  text: string;
  /** The panel that fixes it. */
  fix?: { label: string; panel: string };
  /** Where it stands: pages (0-based) or items. */
  pages?: number[];
  items?: ElementId[];
  /** The publication's own issues (editor ADR 1223) report this already. */
  inHealth?: boolean;
}

export type Readiness = "blocked" | "attention" | "ready" | "approved";

export interface ContractAssessment {
  readiness: Readiness;
  checks: ContractCheck[];
}

/** What the document says about itself (the export check's facts and the
 *  rest the contract reads). */
export interface ContractFacts {
  loaded: boolean;
  print: PrintOutputFacts;
  pages: ReadonlyArray<{
    sizePt: readonly [number, number];
    bleedTopPt?: number;
    bleedLeftPt?: number;
    bleedBottomPt?: number;
    bleedRightPt?: number;
  }> | null;
  fonts: ReadonlyArray<{ family: string; isMissing?: boolean }> | null;
  links: ReadonlyArray<{
    status?: string | null;
    effectivePpi?: number | null;
    colorspace?: string | null;
    element?: ElementId | null;
  }> | null;
  oversetStories: number | null;
  /** Required template fields with no value. */
  emptyRequiredFields: number;
  /** paged.data's open issues. */
  dataIssues: number;
  documentName: string;
  /** The document changed after it was approved (in this session). */
  editedSinceApproval?: boolean;
}

export const CONTRACT_WORDS = defineMessages("app.contractCheck", {
  noDocument: "No document is open.",
  pageSize:
    "{count, plural, one {Page {pages} is not} other {Pages {pages} are not}} {w} × {h} pt.",
  pageSizeOk: "Every page is {w} × {h} pt.",
  bleed:
    "The bleed is {have} pt; the contract asks for {want} pt on every side.",
  bleedOk: "The bleed is at least {want} pt on every side.",
  intentMissing: "The contract needs an output intent and none is loaded.",
  intentWrong: "The output intent is {have}; the contract asks for {want}.",
  intentOk: "The output intent is {have}.",
  rgb: "{count, plural, one {# picture is} other {# pictures are}} RGB; the contract allows none.",
  rgbOk: "No RGB pictures.",
  fontsNotAllowed: "Fonts outside the contract: {families}.",
  fontsAllowedOk: "Every font is one the contract allows.",
  fontsMissing:
    "{count, plural, one {# font is} other {# fonts are}} missing; the contract needs every font.",
  ppi: "{count, plural, one {# picture is} other {# pictures are}} below {ppi} ppi.",
  ppiOk: "Every picture is {ppi} ppi or more.",
  ppiUnknown:
    "{count, plural, one {# picture has} other {# pictures have}} no measured resolution.",
  data: "{count, plural, one {# required field is} other {# required fields are}} empty.",
  dataIssues:
    "{count, plural, one {The data has # issue} other {The data has # issues}}.",
  dataOk: "The data is complete.",
  approved: "Approved by {by}.",
  approvedNoName: "Approved.",
  editedSince: "Approved, then edited: the approval is for an earlier state.",
  inReview: "In review.",
  inReviewBy: "In review by {reviewers}.",
  changesRequested: "Changes requested.",
  draft: "Not approved yet.",
  colorSettings: "Color settings",
  fontsPanel: "Fonts",
  linksPanel: "Links",
  documentSetup: "Document setup",
  dataPanel: "Data",
  templatePanel: "Template",
  contractPanel: "Publication contract",
});

const W = CONTRACT_WORDS;

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** Assess `facts` against `contract`: blockers first. */
export function assessContract(
  contract: PublicationContract,
  facts: ContractFacts,
): ContractAssessment {
  if (!facts.loaded)
    return {
      readiness: "blocked",
      checks: [{ id: "document", level: "blocker", text: t(W.noDocument) }],
    };
  const checks: ContractCheck[] = [];
  // The export's own check, on the contract's standard and the document's
  // bleed: its blockers and warnings, as it words them.
  const minPpi = contract.minImagePpi;
  for (const c of pdfReadiness(
    {
      standard: contract.standard,
      outputIntentProfile: "",
      colorPolicy: "preserveNumbers",
      pageScope: "all",
      pageFrom: "1",
      pageTo: "1",
      useDocumentBleed: true,
      bleedPt: "0",
      downsample: "off",
    },
    {
      loaded: facts.loaded,
      pageCount: facts.pages?.length ?? 0,
      currentPage: 0,
      print: facts.print,
      pages: facts.pages,
      fonts: facts.fonts,
      links: facts.links,
      oversetStories: facts.oversetStories,
      documentName: facts.documentName,
    },
  )) {
    // The contract's own resolution floor replaces the export's 150 ppi.
    if (c.id === "resolution" && minPpi !== undefined) continue;
    // Missing fonts: a blocker when the contract needs every font.
    const level =
      c.id === "fonts" && c.level === "warning" && contract.fonts?.available
        ? "blocker"
        : c.level;
    checks.push({
      id: `export-${c.id}`,
      level,
      text:
        c.id === "fonts" && level === "blocker"
          ? t(W.fontsMissing, {
              count: (facts.fonts ?? []).filter((f) => f.isMissing).length,
            })
          : c.text,
      ...(c.fix ? { fix: c.fix } : {}),
      // Fonts, links, resolution and overset are Publication health's own.
      inHealth: c.id !== "standard" && c.id !== "range" && c.id !== "bleed",
    });
  }

  const pages = facts.pages ?? [];
  if (contract.page) {
    const { widthPt: w, heightPt: h } = contract.page;
    const off = pages
      .map((p, i) => (near(p.sizePt[0], w) && near(p.sizePt[1], h) ? -1 : i))
      .filter((i) => i >= 0);
    checks.push(
      off.length
        ? {
            id: "page-size",
            level: "blocker",
            text: t(W.pageSize, {
              count: off.length,
              pages: off
                .slice(0, 6)
                .map((i) => i + 1)
                .join(", "),
              w: Math.round(w * 100) / 100,
              h: Math.round(h * 100) / 100,
            }),
            fix: { label: t(W.documentSetup), panel: "paged.document-setup" },
            pages: off,
          }
        : {
            id: "page-size",
            level: "ok",
            text: t(W.pageSizeOk, {
              w: Math.round(w * 100) / 100,
              h: Math.round(h * 100) / 100,
            }),
          },
    );
  }
  if (contract.bleedPt !== undefined && contract.bleedPt > 0) {
    const want = contract.bleedPt;
    const have = pages.length
      ? Math.min(
          ...pages.map((p) =>
            Math.min(
              p.bleedTopPt ?? 0,
              p.bleedLeftPt ?? 0,
              p.bleedBottomPt ?? 0,
              p.bleedRightPt ?? 0,
            ),
          ),
        )
      : 0;
    checks.push(
      have + 0.01 < want
        ? {
            id: "bleed",
            level: "blocker",
            text: t(W.bleed, { have: Math.round(have * 100) / 100, want }),
            fix: { label: t(W.documentSetup), panel: "paged.document-setup" },
          }
        : { id: "bleed", level: "ok", text: t(W.bleedOk, { want }) },
    );
  }
  if (contract.outputIntent?.required) {
    const have = workingProfileLabel(facts.print);
    const want = contract.outputIntent.profile;
    if (!facts.print.profileActive)
      checks.push({
        id: "output-intent",
        level: "blocker",
        text: t(W.intentMissing),
        fix: { label: t(W.colorSettings), panel: "paged.color-settings" },
      });
    else if (want && !have.toLowerCase().includes(want.toLowerCase()))
      checks.push({
        id: "output-intent",
        level: "blocker",
        text: t(W.intentWrong, { have, want }),
        fix: { label: t(W.colorSettings), panel: "paged.color-settings" },
      });
    else
      checks.push({
        id: "output-intent",
        level: "ok",
        text: t(W.intentOk, { have }),
      });
  }
  const links = facts.links ?? [];
  if (contract.noRgbImages) {
    const rgb = links.filter(
      (l) => (l.colorspace ?? "").toUpperCase() === "RGB",
    );
    checks.push(
      rgb.length
        ? {
            id: "rgb",
            level: "blocker",
            text: t(W.rgb, { count: rgb.length }),
            fix: { label: t(W.linksPanel), panel: "paged.links" },
            items: rgb.flatMap((l) => (l.element ? [l.element] : [])),
          }
        : { id: "rgb", level: "ok", text: t(W.rgbOk) },
    );
  }
  if (contract.fonts?.allowed?.length) {
    const allowed = new Set(contract.fonts.allowed.map((f) => f.toLowerCase()));
    const outside = [
      ...new Set(
        (facts.fonts ?? [])
          .map((f) => f.family)
          .filter((f) => !allowed.has(f.toLowerCase())),
      ),
    ];
    checks.push(
      outside.length
        ? {
            id: "fonts-allowed",
            level: "blocker",
            text: t(W.fontsNotAllowed, { families: outside.join(", ") }),
            fix: { label: t(W.fontsPanel), panel: "paged.fonts" },
          }
        : { id: "fonts-allowed", level: "ok", text: t(W.fontsAllowedOk) },
    );
  }
  if (minPpi !== undefined) {
    const placed = links.filter((l) => l.status !== "missing");
    const low = placed.filter(
      (l) => l.effectivePpi != null && l.effectivePpi < minPpi,
    );
    const unknown = placed.filter((l) => l.effectivePpi == null).length;
    checks.push(
      low.length
        ? {
            id: "image-ppi",
            level: "blocker",
            text: t(W.ppi, { count: low.length, ppi: minPpi }),
            fix: { label: t(W.linksPanel), panel: "paged.links" },
            // Below 150 ppi Publication health says so already.
            items: low
              .filter((l) => (l.effectivePpi ?? 0) >= 150)
              .flatMap((l) => (l.element ? [l.element] : [])),
          }
        : { id: "image-ppi", level: "ok", text: t(W.ppiOk, { ppi: minPpi }) },
    );
    if (unknown > 0)
      checks.push({
        id: "image-ppi-unknown",
        level: "info",
        text: t(W.ppiUnknown, { count: unknown }),
      });
  }
  if (contract.dataComplete) {
    if (facts.emptyRequiredFields > 0)
      checks.push({
        id: "data-fields",
        level: "blocker",
        text: t(W.data, { count: facts.emptyRequiredFields }),
        fix: { label: t(W.templatePanel), panel: "paged.template.form" },
      });
    if (facts.dataIssues > 0)
      checks.push({
        id: "data-issues",
        level: "blocker",
        text: t(W.dataIssues, { count: facts.dataIssues }),
        fix: { label: t(W.dataPanel), panel: "paged.data" },
        inHealth: true,
      });
    if (facts.emptyRequiredFields === 0 && facts.dataIssues === 0)
      checks.push({ id: "data", level: "ok", text: t(W.dataOk) });
  }
  const a = contract.approval;
  const approvedFresh = a.status === "approved" && !facts.editedSinceApproval;
  checks.push({
    id: "approval",
    level: approvedFresh ? "ok" : a.status === "approved" ? "warning" : "info",
    text:
      a.status === "approved"
        ? facts.editedSinceApproval
          ? t(W.editedSince)
          : a.by
            ? t(W.approved, { by: a.by })
            : t(W.approvedNoName)
        : a.status === "in-review"
          ? a.reviewers.length
            ? t(W.inReviewBy, { reviewers: a.reviewers.join(", ") })
            : t(W.inReview)
          : a.status === "changes-requested"
            ? t(W.changesRequested)
            : t(W.draft),
    fix: { label: t(W.contractPanel), panel: "paged.publication-contract" },
  });
  const rank: Record<ContractLevel, number> = {
    blocker: 0,
    warning: 1,
    info: 2,
    ok: 3,
  };
  checks.sort((x, y) => rank[x.level] - rank[y.level]);
  const readiness: Readiness = checks.some((c) => c.level === "blocker")
    ? "blocked"
    : checks.some((c) => c.level === "warning")
      ? "attention"
      : approvedFresh
        ? "approved"
        : "ready";
  return { readiness, checks };
}
