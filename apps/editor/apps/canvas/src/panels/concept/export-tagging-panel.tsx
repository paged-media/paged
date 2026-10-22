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

// Panel-gallery pass — Export Tagging (EPUB / accessible-PDF
// output surface; INDESIGN_PARITY.md ●● in scope). CONCEPT with a
// LIVE scope toggle (local UI state): mapping each paragraph/
// character style to an HTML tag + CSS class + PDF tag waits on
// style-level export-metadata writes.

import { useState } from "react";

import { Segment } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  ConceptShell,
  Kicker,
  Row,
  SeamSelect,
  SeamSwitch,
} from "./concept-kit";

type Scope = "Paragraph" | "Character";

const M = defineMessages("app.conceptExportTaggingPanel", {
  target:
    "Map each paragraph/character style to an HTML tag + CSS class (and PDF tag) for clean EPUB/HTML and tagged PDF.",
  paragraph: "Paragraph",
  character: "Character",
  style: "Style",
  tag: "Tag",
  class: "Class",
  emitCss: "Emit CSS",
  taggedPdf: "Tagged PDF",
  pdfTag: "PDF tag",
});

const SCOPE_LABEL: Record<Scope, string> = {
  Paragraph: M.paragraph,
  Character: M.character,
};

export function ExportTaggingPanel() {
  const strings = useStrings();
  const [scope, setScope] = useState<Scope>("Paragraph");
  const para = scope === "Paragraph";
  return (
    <ConceptShell testId="export-tagging-panel" target={strings.t(M.target)}>
      <div
        className="inline-flex w-full overflow-hidden rounded-[6px] border border-input"
        role="group"
        data-tagging-scope
      >
        {(["Paragraph", "Character"] as Scope[]).map((s, i) => (
          <Segment
            key={s}
            pressed={scope === s}
            data-scope={s}
            onClick={() => setScope(s)}
            className="flex-1 text-xs h-[27px] border-0 cursor-pointer"
            style={{
              borderRight: i === 0 ? "1px solid var(--pg-border)" : "none",
              background:
                scope === s ? "var(--chrome-slot-active)" : "var(--pg-bg)",
              color:
                scope === s
                  ? "var(--chrome-icon-active)"
                  : "var(--pg-muted-fg)",
            }}
          >
            {strings.t(SCOPE_LABEL[s])}
          </Segment>
        ))}
      </div>
      <Row label={strings.t(M.style)}>
        <SeamSelect value="—" />
      </Row>
      <Kicker>EPUB &amp; HTML</Kicker>
      <Row label={strings.t(M.tag)}>
        <SeamSelect value={para ? "p" : "span"} />
      </Row>
      <Row label={strings.t(M.class)}>
        <SeamSelect value="—" />
      </Row>
      <Row label="EPUB:type">
        <SeamSelect value={para ? "bodymatter" : "—"} />
      </Row>
      <Row label={strings.t(M.emitCss)}>
        <SeamSwitch on />
      </Row>
      <Kicker>{strings.t(M.taggedPdf)}</Kicker>
      <Row label={strings.t(M.pdfTag)}>
        <SeamSelect value={para ? "P" : "Span"} />
      </Row>
      {/* The gallery code preview — static illustration. */}
      <div
        data-seam
        data-tagging-preview
        className="rounded-[6px] border border-input px-2.5 py-2 opacity-70 pg-value text-[11px]"
        style={{ background: "var(--canvas-surround, var(--pg-muted))" }}
      >
        {para ? '<p class="…">…</p>' : '<span class="…">…</span>'}
      </div>
    </ConceptShell>
  );
}
