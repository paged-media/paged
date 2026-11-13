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

// Proof view's badge over the canvas (editor ADR "Editing aids and Proof
// view"; the redesign strategy's §4.5): what the proof shows and what it
// cannot promise. The current page's trim and bleed, which of them the
// mask lets through (Proof view: the trim; Bleed: the bleed), and that
// screen colours are not a colour-managed proof unless Proof colors is on.
// Leaving Proof view is one click; the selection is never touched.

import type { CSSProperties } from "react";
import { defineMessages, useStrings } from "@paged-media/strings";

import { useCollection } from "../../catalog/use-collection";
import { isProofMode } from "../../state/editing-aids";
import { useOptionalScreenMode } from "../../state/screen-mode-context";
import { useCurrentPage } from "../../state/use-current-page";

const M = defineMessages("shell.proofBadge", {
  title: "Proof view",
  trim: "Trim {w} × {h} pt",
  bleed: "Bleed {b} pt",
  noBleed: "No bleed",
  showsTrim: "shows the trim",
  showsBleed: "shows the bleed",
  colours: "Screen colours: not a colour-managed proof",
  leave: "Leave Proof view",
});

interface PageFacts {
  selfId: string;
  sizePt?: [number, number];
  bleedTopPt?: number;
  bleedLeftPt?: number;
  bleedBottomPt?: number;
  bleedRightPt?: number;
}

const pt = (v: number) => String(Math.round(v * 100) / 100);

export function ProofBadge() {
  const strings = useStrings();
  const screen = useOptionalScreenMode();
  const current = useCurrentPage();
  const pages = useCollection<PageFacts>("pages");
  if (!screen || !isProofMode(screen.screenMode)) return null;
  if (screen.screenMode === "presentation") return null;
  const page = pages?.find((p) => p.selfId === current.pageId);
  const bleed = page
    ? Math.max(
        page.bleedTopPt ?? 0,
        page.bleedLeftPt ?? 0,
        page.bleedBottomPt ?? 0,
        page.bleedRightPt ?? 0,
      )
    : 0;
  const withBleed =
    screen.screenMode === "bleed" || screen.screenMode === "slug";
  return (
    <div data-proof-badge={screen.screenMode} role="status" style={badgeStyle}>
      <strong>{strings.t(M.title)}</strong>
      {page?.sizePt && (
        <span data-proof-trim-size="">
          {strings.t(M.trim, { w: pt(page.sizePt[0]), h: pt(page.sizePt[1]) })}
        </span>
      )}
      <span data-proof-bleed="">
        {bleed > 0
          ? strings.t(M.bleed, { b: pt(bleed) })
          : strings.t(M.noBleed)}
        {" · "}
        {strings.t(withBleed ? M.showsBleed : M.showsTrim)}
      </span>
      <span style={{ color: "var(--pg-muted-fg)" }}>
        {strings.t(M.colours)}
      </span>
      <button
        type="button"
        data-proof-leave=""
        onClick={() => screen.setScreenMode("normal")}
        style={buttonStyle}
      >
        {strings.t(M.leave)}
      </button>
    </div>
  );
}

const badgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 10,
  maxWidth: "calc(100% - 32px)",
  padding: "4px 6px 4px 12px",
  borderRadius: 999,
  border: "1px solid var(--pg-border)",
  background: "var(--elevated, var(--pg-bg))",
  color: "var(--pg-fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  whiteSpace: "nowrap",
  overflow: "hidden",
  boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
};

const buttonStyle: CSSProperties = {
  height: 22,
  padding: "0 10px",
  borderRadius: 999,
  border: "1px solid var(--pg-border)",
  background: "transparent",
  color: "var(--pg-fg)",
  cursor: "pointer",
  fontSize: 12,
};
