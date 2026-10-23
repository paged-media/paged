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

// Panel-gallery pass — Object Export Options (EPUB / accessible-PDF
// output surface; INDESIGN_PARITY.md ●● in scope). CONCEPT with a
// LIVE tab switcher (local UI state): per-object alt text,
// tagged-PDF role and EPUB/HTML conversion wait on export-metadata
// writes against the element model.

import { useState } from "react";

import { defineMessages, useStrings } from "@paged-media/strings";

import { ConceptShell, Row, SeamSelect, SeamSwitch } from "./concept-kit";

type ExportTab = "Alt Text" | "Tagged PDF" | "EPUB & HTML";

const TABS: ExportTab[] = ["Alt Text", "Tagged PDF", "EPUB & HTML"];

const M = defineMessages("app.conceptObjectExportPanel", {
  target:
    "Per-object alt text (source: custom/XMP/structure), tagged-PDF role (Figure/Artifact), EPUB/HTML conversion + CSS class — feeds accessible PDF + EPUB output.",
  altTextTab: "Alt Text",
  taggedPdfTab: "Tagged PDF",
  epubTab: "EPUB & HTML",
  source: "Source",
  custom: "Custom",
  altTextHint: "Alt text (read by screen readers)",
  applyTag: "Apply tag",
  basedOnObject: "Based on object",
  role: "Role",
  actualText: "Actual text",
  fromStructure: "From structure",
  asArtifact: "Use as artifact",
  layout: "Layout",
  inlineReflow: "Inline / reflow",
  convert: "Convert",
  optimizedPng: "Optimized (PNG)",
  resolution: "Resolution",
  cssClass: "CSS class",
  preserveLook: "Preserve look",
});

const TAB_LABEL: Record<ExportTab, string> = {
  "Alt Text": M.altTextTab,
  "Tagged PDF": M.taggedPdfTab,
  "EPUB & HTML": M.epubTab,
};

export function ObjectExportPanel() {
  const strings = useStrings();
  const [tab, setTab] = useState<ExportTab>("Alt Text");
  return (
    <ConceptShell testId="object-export-panel" target={strings.t(M.target)}>
      {/* Tab switcher is live local state; the fields are seams. */}
      <div
        className="flex border-b border-input"
        role="tablist"
        data-object-export-tabs
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-export-tab={t}
            data-active={tab === t ? "true" : "false"}
            onClick={() => setTab(t)}
            className="text-xs px-2.5 h-[28px] border-0 bg-transparent cursor-pointer"
            style={{
              color: tab === t ? "var(--pg-primary)" : "var(--pg-muted-fg)",
              boxShadow:
                tab === t ? "inset 0 -2px 0 var(--pg-primary)" : "none",
            }}
          >
            {strings.t(TAB_LABEL[t])}
          </button>
        ))}
      </div>
      {tab === "Alt Text" && (
        <>
          <Row label={strings.t(M.source)}>
            <SeamSelect value={strings.t(M.custom)} />
          </Row>
          <div className="text-xs text-muted-foreground">
            {strings.t(M.altTextHint)}
          </div>
          <textarea
            disabled
            data-seam
            placeholder="—"
            className="w-full h-[64px] text-xs p-2 rounded-[6px] border border-input bg-background text-muted-foreground opacity-55 resize-none"
          />
        </>
      )}
      {tab === "Tagged PDF" && (
        <>
          <Row label={strings.t(M.applyTag)}>
            <SeamSelect value={strings.t(M.basedOnObject)} />
          </Row>
          <Row label={strings.t(M.role)}>
            <SeamSelect value="Figure" />
          </Row>
          <Row label={strings.t(M.actualText)}>
            <SeamSelect value={strings.t(M.fromStructure)} />
          </Row>
          <Row label={strings.t(M.asArtifact)}>
            <SeamSwitch />
          </Row>
        </>
      )}
      {tab === "EPUB & HTML" && (
        <>
          <Row label={strings.t(M.layout)}>
            <SeamSelect value={strings.t(M.inlineReflow)} />
          </Row>
          <Row label={strings.t(M.convert)}>
            <SeamSelect value={strings.t(M.optimizedPng)} />
          </Row>
          <Row label={strings.t(M.resolution)}>
            <SeamSelect value="150 PPI" />
          </Row>
          <Row label={strings.t(M.cssClass)}>
            <SeamSelect value=".figure" />
          </Row>
          <Row label={strings.t(M.preserveLook)}>
            <SeamSwitch on />
          </Row>
        </>
      )}
    </ConceptShell>
  );
}
