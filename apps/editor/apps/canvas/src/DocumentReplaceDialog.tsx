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

// D-26 — the keep/discard prompt behind `host.documents.open` (ADR 219). A
// plugin asked to replace the open document, which has unsaved edits.
// Dismissing (Esc / backdrop / Keep) KEEPS the document: the safe answer is
// the one an unacknowledged prompt gets. Styled like <ConsentDialog>.

import { useEffect, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { PendingReplace, ReplaceController } from "./plugin-documents";
import { color, font, radius } from "@paged-media/panel-kit";

export function DocumentReplaceDialog({
  controller,
}: {
  controller: ReplaceController;
}) {
  const pending = useSyncExternalStore(
    controller.subscribe,
    controller.current,
    controller.current,
  );
  return pending ? <ReplacePrompt key={pending.id} pending={pending} /> : null;
}

function ReplacePrompt({ pending }: { pending: PendingReplace }) {
  const keep = (): void => pending.decide(false);
  const discard = (): void => pending.decide(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") keep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.id]);

  return (
    <div
      data-testid="replace-document-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) keep();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.6)",
        font: `13px/1.5 ${font.sans}`,
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="replace-document-title"
        aria-describedby="replace-document-body"
        data-testid="replace-document-dialog"
        style={{
          width: "min(440px, 92vw)",
          padding: 20,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <h2
          id="replace-document-title"
          style={{ margin: "0 0 4px", fontSize: 15 }}
        >
          Discard unsaved edits?
        </h2>
        <p
          id="replace-document-body"
          style={{ margin: "0 0 16px", color: color.mutedFg }}
        >
          <strong
            data-testid="replace-document-requester"
            style={{ color: color.fg }}
          >
            {pending.requester}
          </strong>{" "}
          wants to open{" "}
          <strong
            data-testid="replace-document-name"
            style={{ color: color.fg }}
          >
            {pending.documentName}
          </strong>{" "}
          in place of the open document. The open document has unsaved edits,
          and opening will discard them. Save with Cmd+S first to keep them.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            data-testid="replace-document-keep"
            onClick={keep}
            autoFocus
            style={btnStyle(true)}
          >
            Keep document
          </button>
          <button
            type="button"
            data-testid="replace-document-discard"
            onClick={discard}
            style={btnStyle(false)}
          >
            Discard and open
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(primary: boolean): CSSProperties {
  return {
    padding: "7px 14px",
    borderRadius: 7,
    fontSize: 13,
    cursor: "pointer",
    border: `1px solid ${color.border}`,
    background: primary ? color.primary : "transparent",
    color: primary ? color.primaryFg : color.fg,
  };
}
