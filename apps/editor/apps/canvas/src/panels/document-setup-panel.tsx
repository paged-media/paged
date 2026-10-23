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

// ADR 323 — Document Setup and Margins and Columns as schema-driven
// forms over the object model's document and page addresses:
//
//   · Document Setup edits `doc`: bleed and slug (core `setProperty`),
//     the document defaults (`setDocumentDefaults`), colour management
//     (`setColorSettings` / `setProofSetup` / `setUseStandardLabForSpots`)
//     and the active condition set. Each is a virtual path core's `Set`
//     resolves to its dedicated op, so the panel writes `set("doc", …)`
//     and never builds the op itself.
//   · Margins and Columns edits one page (`page:<id>`) or every page at
//     once: with "All pages" each field writes ONE batch over every page
//     address = one undo step.
//
// Every field is a `PropertyField` ("Bind to data…", badge, the schema's
// type and range); rows the schema adds that no section names appear
// under "More".

import { useMemo, useState } from "react";

import {
  CockpitPanelHeader,
  CockpitRow,
  useCollection,
} from "@paged-media/shell";
import { FieldSelect } from "@paged-media/panel-kit";
import { formatAddress } from "@paged-media/plugin-sdk";
import type { PageSummary } from "@paged-media/client";
import {
  DOCUMENT_UNITS,
  setDocumentUnit,
  useDocumentUnit,
} from "@paged-media/ui";

import { defineMessages, useStrings } from "@paged-media/strings";

import { SchemaSections, type SectionSpec } from "./schema-sections";
import { sectionsIn } from "./section-strings";

const M = defineMessages("app.documentSetupPanel", {
  bleed: "Bleed",
  top: "Top",
  bottom: "Bottom",
  inside: "Inside",
  outside: "Outside",
  slug: "Slug",
  defaults: "Defaults",
  fill: "Fill",
  stroke: "Stroke",
  weight: "Weight",
  colorManagement: "Color Management",
  cmykProfile: "CMYK profile",
  rgbPolicy: "RGB policy",
  intent: "Intent",
  blackPoint: "Black point",
  labForSpots: "Lab for spots",
  proofSetup: "Proof Setup",
  profile: "Profile",
  paperWhite: "Paper white",
  conditions: "Conditions",
  activeSet: "Active set",
  page: "Page",
  bounds: "Bounds",
  master: "Master",
  margins: "Margins",
  columns: "Columns",
  number: "Number",
  gutter: "Gutter",
  documentSetup: "Document Setup",
  units: "Units",
  marginsAndColumns: "Margins and Columns",
  pages: "Pages",
  pageN: "Page {index}",
  allPages: "All pages",
});

// Section titles and field labels are message keys (`sectionsIn`).

const DOCUMENT_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.bleed,
    fields: [
      { path: "documentBleedTop", label: M.top },
      { path: "documentBleedBottom", label: M.bottom },
      { path: "documentBleedInsideOrLeft", label: M.inside },
      { path: "documentBleedOutsideOrRight", label: M.outside },
    ],
  },
  {
    title: M.slug,
    fields: [
      { path: "documentSlugTop", label: M.top },
      { path: "documentSlugBottom", label: M.bottom },
      { path: "documentSlugInsideOrLeft", label: M.inside },
      { path: "documentSlugRightOrOutside", label: M.outside },
    ],
  },
  {
    title: M.defaults,
    fields: [
      { path: "defaultFillColor", label: M.fill, collection: "swatches" },
      { path: "defaultStrokeColor", label: M.stroke, collection: "swatches" },
      { path: "defaultStrokeWeight", label: M.weight },
    ],
  },
  {
    title: M.colorManagement,
    fields: [
      { path: "cmykProfile", label: M.cmykProfile },
      { path: "rgbPolicy", label: M.rgbPolicy },
      { path: "renderingIntent", label: M.intent },
      { path: "blackPointCompensation", label: M.blackPoint },
      { path: "useStandardLabForSpots", label: M.labForSpots },
    ],
  },
  {
    title: M.proofSetup,
    fields: [
      { path: "proofProfile", label: M.profile },
      { path: "proofIntent", label: M.intent },
      { path: "proofSimulatePaperWhite", label: M.paperWhite },
    ],
  },
  {
    title: M.conditions,
    fields: [
      {
        path: "activeConditionSet",
        label: M.activeSet,
        collection: "conditionSets",
      },
    ],
  },
];

const PAGE_SECTIONS: readonly SectionSpec[] = [
  {
    title: M.page,
    fields: [
      { path: "pageBounds", label: M.bounds },
      { path: "appliedMaster", label: M.master, collection: "masterPages" },
    ],
  },
  {
    title: M.margins,
    fields: [
      { path: "pageMarginTop", label: M.top },
      { path: "pageMarginBottom", label: M.bottom },
      { path: "pageMarginLeft", label: M.inside },
      { path: "pageMarginRight", label: M.outside },
    ],
  },
  {
    title: M.columns,
    fields: [
      { path: "pageColumnCount", label: M.number },
      { path: "pageColumnGutter", label: M.gutter },
    ],
  },
];

const DOC_TARGETS = ["doc"] as const;

export function DocumentSetupPanel() {
  const strings = useStrings();
  return (
    <div data-document-setup-panel="ready">
      <CockpitPanelHeader title={strings.t(M.documentSetup)} />
      <UnitsRow />
      <SchemaSections
        targets={DOC_TARGETS}
        sections={sectionsIn(strings, DOCUMENT_SECTIONS)}
        testId="doc"
      />
    </div>
  );
}

/** The unit every geometry field shows (ADR 245; InDesign's Preferences ▸
 *  Units & Increments). An editor preference: the document model keeps
 *  points, and a typed unit converts whatever is chosen here. */
export function UnitsRow() {
  const strings = useStrings();
  const unit = useDocumentUnit();
  return (
    <div className="px-3.5 pb-2">
      <CockpitRow label={strings.t(M.units)}>
        <FieldSelect
          data-units-select=""
          className="h-[28px] w-full rounded-[6px] border border-input bg-background px-2 text-[12px]"
          value={unit}
          onChange={(e) => setDocumentUnit(e.target.value)}
        >
          {DOCUMENT_UNITS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </FieldSelect>
      </CockpitRow>
    </div>
  );
}

const ALL = "__all__";

/** The page address the object model resolves (`page:<self id>`). */
export function pageAddress(selfId: string): string {
  return formatAddress({ kind: "page", id: selfId } as never);
}

export function MarginsColumnsPanel() {
  const strings = useStrings();
  const pages = useCollection<PageSummary>("pages");
  const [pick, setPick] = useState<string>("");
  const chosen = pick || pages?.[0]?.selfId || "";
  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const targets = useMemo(() => {
    if (!pages || pages.length === 0) return [];
    if (chosen === ALL) return pages.map((p) => pageAddress(p.selfId));
    return [pageAddress(chosen)];
  }, [pages, chosen]);
  return (
    <div
      data-margins-columns-panel={pages ? "ready" : "loading"}
      data-page-targets={targets.length}
    >
      <CockpitPanelHeader title={strings.t(M.marginsAndColumns)} />
      <div className="px-3.5 pb-2">
        <CockpitRow label={strings.t(M.pages)}>
          <FieldSelect
            data-page-select=""
            className="h-[28px] w-full rounded-[6px] border border-input bg-background px-2 text-[12px]"
            value={chosen}
            onChange={(e) => setPick(e.target.value)}
          >
            {(pages ?? []).map((p) => (
              <option key={p.selfId} value={p.selfId}>
                {strings.t(M.pageN, { index: p.index })}
              </option>
            ))}
            {(pages?.length ?? 0) > 1 && (
              <option value={ALL}>{strings.t(M.allPages)}</option>
            )}
          </FieldSelect>
        </CockpitRow>
      </div>
      {targets.length > 0 && (
        <SchemaSections
          key={targets.join(" ")}
          targets={targets}
          sections={sectionsIn(strings, PAGE_SECTIONS)}
          testId="page"
        />
      )}
    </div>
  );
}
