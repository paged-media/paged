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

// The publication's readiness in the header, beside the save status
// (editor ADR 1236): a dot and a word — Blocked, Needs attention, Ready,
// Approved — when the document carries a publication contract; its
// tooltip lists what is not met; a click opens the contract. Below the
// save status's label width the dot shows alone, its word the name.

import { useStrings } from "@paged-media/strings";

import { usePublicationReadiness } from "../state/publication-readiness";
import { useSaveStatusLabelShown } from "./SaveStatus";
import { READINESS } from "./messages";

const DOT = {
  blocked: "var(--status-error)",
  attention: "var(--status-review)",
  ready: "var(--status-info)",
  approved: "var(--status-approved)",
} as const;

export function ReadinessBadge() {
  const strings = useStrings();
  const { readiness, open } = usePublicationReadiness();
  const wide = useSaveStatusLabelShown();
  if (!readiness) return null;
  const word = strings.t(
    readiness.level === "blocked"
      ? READINESS.blocked
      : readiness.level === "attention"
        ? READINESS.attention
        : readiness.level === "ready"
          ? READINESS.ready
          : READINESS.approved,
  );
  const label = strings.t(READINESS.label, { state: word });
  const title = [label, ...readiness.details].join("\n");
  return (
    <button
      type="button"
      data-publication-readiness={readiness.level}
      data-readiness-open={readiness.open}
      aria-label={label}
      title={title}
      onClick={() => open?.()}
      style={wide ? triggerStyle : dotTriggerStyle}
    >
      <span
        aria-hidden
        style={{ ...dotStyle, background: DOT[readiness.level] }}
      />
      {wide && <span style={labelStyle}>{word}</span>}
    </button>
  );
}

const triggerStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  maxWidth: 170,
  height: 24,
  padding: "0 6px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--pg-muted-fg)",
  fontSize: 12,
  cursor: "pointer",
  flexShrink: 0,
};
const dotTriggerStyle: React.CSSProperties = {
  ...triggerStyle,
  height: "auto",
  padding: 0,
};
const dotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 2,
  flexShrink: 0,
};
const labelStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
