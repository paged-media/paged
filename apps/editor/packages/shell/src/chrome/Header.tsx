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

// Design system — the 46px cockpit header, in zones separated by
// hairlines:
//
//   brand · document | menus (core, then context) | search | theme · Share
//
// - The DOCUMENT chip names what is open, with a dot for the engine's
//   state while it is busy or failed. After the menus the SAVE STATUS says
//   what the last save really did and where (editor ADR 1203,
//   `SaveStatus`): a dot, and its label when the header has room.
// - Search shrinks with the space it is given and becomes an icon
//   below 220 px, so nothing is pushed off the right edge.
// - Zoom lives in the bottom bar only (it was in both).
//
// File intake has no header widget: File ▸ Open…, canvas drag-drop,
// and a hidden `<input type="file">` for the Playwright suite cover it.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStrings } from "@paged-media/strings";

import { Icon } from "../icons";
import { useDocumentMeta } from "../catalog/use-collection";
import { useDocument } from "../state/document-context";
import { useTheme } from "../state/theme-context";
import { ShareButton } from "./CollabCluster";
import { FileDrop } from "./FileDrop";
import { MenuBar, prettyKey } from "./MenuBar";
import { notifyPalette } from "./CommandPalette";
import { useEditorScope } from "../state/editor-scope";
import { useChromeRegions } from "../state/chrome-regions";
import { useCompactLayout } from "../state/compact";
import { RegionItems } from "./RegionItems";
import { SaveStatus } from "./SaveStatus";
import { HEADER } from "./messages";

export interface HeaderProps {
  onFile: (file: File) => void;
  headerExtras?: ReactNode;
  status?: string;
}

export function Header({ onFile, headerExtras, status }: HeaderProps) {
  const chrome = useChromeRegions();
  const headerRegion = chrome.region("header");
  // A fill shape on a phone (editor ADR 294): the header grows to hold
  // touch-sized buttons and keeps its sides close.
  const compact = useCompactLayout() !== null;
  return (
    <header
      data-header-compact={compact ? "" : undefined}
      style={compact ? compactHeaderStyle : headerStyle}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <Brand />
        <DocumentChip status={status} />
        {chrome.has("menubar") ? (
          <>
            <span style={zoneDividerStyle} aria-hidden />
            {/* The save status follows the menus: they stay the first stop
             *  and keep their place; its dot takes the room the chip's dot
             *  had. */}
            <span style={menusAndStatusStyle}>
              <MenuBar />
              <SaveStatus />
            </span>
          </>
        ) : (
          <SaveStatus />
        )}
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 36,
          display: "flex",
          justifyContent: "center",
        }}
      >
        {chrome.has("palette") && <CommandTrigger />}
      </div>

      <div
        style={
          compact
            ? {
                display: "flex",
                alignItems: "center",
                gap: 4,
                minWidth: 0,
                overflowX: "auto",
              }
            : { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }
        }
      >
        <FileDrop onFile={onFile} hidden />
        {/* A profile that lists the header's items replaces this cluster
         *  with them; one that keeps it whole may append to it. */}
        {headerRegion?.kind === "list" ? (
          <RegionItems items={headerRegion.items} />
        ) : (
          <>
            {headerExtras != null && (
              <div
                style={{
                  display: "flex",
                  maxWidth: 200,
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                {headerExtras}
              </div>
            )}
            <ThemeToggle />
            <span style={zoneDividerStyle} aria-hidden />
            <ShareButton />
            {headerRegion && headerRegion.append.length > 0 && (
              <RegionItems items={headerRegion.append} />
            )}
          </>
        )}
      </div>
    </header>
  );
}

/** The engine's status string, read for the chip: work in progress ends
 *  with an ellipsis ("loading Annual.idml…", "snapshotting…"), a failure
 *  says so; everything else ("loaded 4 pages", "imported Annual.idml",
 *  "worker ready") is a settled engine (UX audit F-07: the dot read every
 *  settled message as unsaved work). */
export function engineStatusOf(
  status: string | undefined,
): "settled" | "busy" | "failed" {
  if (!status) return "settled";
  if (/failed/i.test(status)) return "failed";
  return /(…|\.\.\.)$/.test(status.trim()) ? "busy" : "settled";
}

/** What is open, and the engine's state while it is busy or failed. The
 *  save state is `SaveStatus`'s, after the menus. */
function DocumentChip({ status }: { status?: string }) {
  const strings = useStrings();
  const { handle, sourceName } = useDocument();
  const meta = useDocumentMeta();
  const engine = engineStatusOf(status);
  const ready = engine === "settled";
  const name = handle
    ? meta?.documentName || sourceName || strings.t(HEADER.untitled)
    : strings.t(HEADER.noDocument);
  return (
    <span
      data-document-chip
      title={ready ? name : `${name} — ${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
        maxWidth: "clamp(90px, 14vw, 220px)",
        color: handle ? "var(--pg-fg)" : "var(--pg-muted-fg)",
        fontSize: 13,
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {!ready && (
        <span
          // The hook the suite and scripts read for the worker state.
          data-shell-status={status}
          aria-label={status}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flexShrink: 0,
            background:
              engine === "failed"
                ? "var(--status-error)"
                : "var(--status-progress)",
          }}
        />
      )}
    </span>
  );
}

/** The `paged.` wordmark — the oxblood period IS the mark. */
function Brand() {
  return (
    <span
      className="pg-wordmark"
      style={{ fontSize: 19, color: "var(--pg-fg)" }}
    >
      paged
      <span className="dot" style={{ color: "var(--wordmark-dot)" }}>
        .
      </span>
    </span>
  );
}

/** Centred pill that opens the command palette (the ⌘K affordance).
 *  It fills the space between the menus and the right cluster up to
 *  460 px and, given less than 220 px, collapses to a search icon. */
function CommandTrigger() {
  const strings = useStrings();
  const scope = useEditorScope();
  const ref = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) =>
      setCompact(e.contentRect.width < 220),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ display: "flex", justifyContent: "center", width: "100%" }}
    >
      <button
        type="button"
        data-command-trigger
        data-compact={compact ? "true" : undefined}
        aria-label={strings.t(HEADER.searchOrAskKey, {
          key: prettyKey("cmd+k"),
        })}
        title={
          compact
            ? strings.t(HEADER.searchOrAskKey, { key: prettyKey("cmd+k") })
            : undefined
        }
        onClick={() => notifyPalette(scope, "open")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "flex-start",
          gap: 9,
          width: compact ? 34 : "min(460px, 100%)",
          height: 34,
          padding: compact ? 0 : "0 12px",
          borderRadius: "var(--radius-full)",
          background: "var(--pg-muted)",
          border: "1px solid var(--pg-border)",
          color: "var(--pg-muted-fg)",
          cursor: compact ? "pointer" : "text",
          flexShrink: 0,
        }}
      >
        <Icon name="ui-search" size={16} style={{ flexShrink: 0 }} />
        {!compact && (
          <>
            <span
              style={{
                flex: 1,
                textAlign: "left",
                fontSize: 13.5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {strings.t(HEADER.searchOrAsk)}
            </span>
            <kbd
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--pg-muted-fg)",
                border: "1px solid var(--pg-border)",
                borderRadius: "var(--radius-sm)",
                padding: "2px 6px",
                background: "hsl(var(--paged-bg))",
              }}
            >
              {prettyKey("cmd+k")}
            </kbd>
          </>
        )}
      </button>
    </div>
  );
}

/** Sun/moon — dark is the primary surface, light one click away. */
export function ThemeToggle() {
  const strings = useStrings();
  const { theme, toggleTheme } = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-theme-toggle
      title={
        theme === "dark"
          ? strings.t(HEADER.lightMode)
          : strings.t(HEADER.darkMode)
      }
      onClick={toggleTheme}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 30,
        height: 30,
        borderRadius: "var(--radius-md)",
        border: "none",
        background: hover ? "var(--hover)" : "transparent",
        color: "var(--chrome-icon)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <Icon name={theme === "dark" ? "ui-sun" : "ui-moon"} size={17} />
    </button>
  );
}

const menusAndStatusStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
};

const zoneDividerStyle: React.CSSProperties = {
  width: 1,
  height: 18,
  background: "var(--pg-border)",
  flexShrink: 0,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 46,
  padding: "0 12px 0 14px",
  gap: 14,
  background: "var(--chrome-panel-bg)",
  borderBottom: "1px solid var(--chrome-border)",
  flexShrink: 0,
  position: "relative",
  zIndex: 30,
};

const compactHeaderStyle: React.CSSProperties = {
  ...headerStyle,
  height: "auto",
  minHeight: 52,
  padding: "4px 8px",
  gap: 8,
};
