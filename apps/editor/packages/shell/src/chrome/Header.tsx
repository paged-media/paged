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

// Design system — the cockpit header (`--chrome-header-h`, 46 px at the
// default density), in zones separated by hairlines:
//
//   brand · document · save status | menus (core, then context) | search |
//   theme · Share
//
// - The DOCUMENT chip names what is open (and the browser tab, when the
//   editor is the page: "<document> — paged", UX audit F-24). Beside it,
//   while a document opens, the load's stage (UXI-PRF-003); otherwise
//   the SAVE STATUS SLOT (`SaveStatusSlot` below): today the dirty/saved
//   dot, the mount point a save-state machine fills (strategy §2.4).
// - The menus keep their place and scroll sideways rather than push the
//   rest off a narrow editor (F-55).
// - Search shrinks with the space it is given and becomes an icon
//   below 220 px, so nothing is pushed off the right edge.
// - Share is a quiet, honestly disabled control until there is a
//   collaboration backend (F-24); output actions keep the labels.
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
import { HEADER } from "./messages";
import { loadingWords } from "../cockpit/canvas-frame/LoadingStatus";
import { editorOwnsPage } from "../state/editor-root";

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
          minWidth: 0,
        }}
      >
        <Brand />
        <DocumentChip status={status} />
        {chrome.has("menubar") && (
          <>
            <span style={zoneDividerStyle} aria-hidden />
            <div data-menubar-scroll style={menuScrollStyle}>
              <MenuBar />
            </div>
          </>
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

/** What is open, and its state: the load's stage while it opens, else
 *  the save status. */
function DocumentChip({ status }: { status?: string }) {
  const strings = useStrings();
  const { handle, sourceName, loading } = useDocument();
  const meta = useDocumentMeta();
  const name = handle
    ? meta?.documentName || sourceName || strings.t(HEADER.untitled)
    : loading
      ? loading.name
      : strings.t(HEADER.noDocument);
  usePageTitle(handle ? name : null);
  const stage = loading ? loadingWords(strings, loading, "long") : null;
  return (
    <span
      data-document-chip
      title={stage ? `${name} — ${stage}` : name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minWidth: 0,
        maxWidth: "clamp(90px, 22vw, 300px)",
        flexShrink: 0,
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
      {loading ? (
        <span
          data-header-loading-stage={loading.stage ?? "recognized"}
          aria-label={stage ?? undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            flexShrink: 0,
            color: "var(--pg-muted-fg)",
            fontSize: 12,
            whiteSpace: "nowrap",
          }}
        >
          <span className="pg-loading-dot" aria-hidden />
          {loadingWords(strings, loading, "short")}
        </span>
      ) : (
        <SaveStatusSlot status={status} />
      )}
    </span>
  );
}

/**
 * The save status's place in the header (strategy §2.4: "paged. › Annual
 * Report · Saved"). Today it shows what the editor knows — the worker's
 * state while it is not ready, else whether there are edits since the
 * load — as one dot, its words the dot's label. A save-state machine
 * (saving, saved locally, synced, failed …) renders here in its place;
 * `data-save-status-slot` names the mount point.
 */
export function SaveStatusSlot({ status }: { status?: string }) {
  const strings = useStrings();
  const { handle } = useDocument();
  const meta = useDocumentMeta();
  const ready = !status || /ready/i.test(status);
  // U14 — honest wording: dirty means edits since load; nothing writes
  // to disk on its own, so neither state may claim a save happened.
  const state = !ready
    ? status
    : !handle
      ? null
      : meta?.dirty
        ? strings.t(HEADER.edited)
        : strings.t(HEADER.noUnsavedEdits);
  const dot = !ready
    ? "var(--status-review)"
    : meta?.dirty
      ? "var(--status-review)"
      : "var(--status-approved)";
  if (!state && ready) return null;
  return (
    <span
      data-save-status-slot
      // Both hooks the suite and scripts read: the worker state and the
      // save state, one dot.
      data-shell-status={status}
      data-save-state={
        handle && ready ? (meta?.dirty ? "dirty" : "saved") : undefined
      }
      role="img"
      aria-label={state ?? undefined}
      title={state ?? undefined}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flexShrink: 0,
        background: dot,
      }}
    />
  );
}

/** The browser tab says what is open — "<document> — paged" — when the
 *  editor is the page (never an embedding host's tab, F-24); the page's
 *  own title comes back when the document closes. */
function usePageTitle(name: string | null) {
  const strings = useStrings();
  const scope = useEditorScope();
  const title = name ? strings.t(HEADER.pageTitle, { name }) : null;
  useEffect(() => {
    if (!title || typeof document === "undefined") return;
    if (!editorOwnsPage(scope)) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [scope, title]);
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
          width: compact
            ? "calc(var(--density-control-h) + 4px)"
            : "min(460px, 100%)",
          height: "calc(var(--density-control-h) + 4px)",
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
        width: "var(--density-control-h)",
        height: "var(--density-control-h)",
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

/** The menus scroll sideways inside their zone when the header is short
 *  of room (F-55), so nothing else is pushed off the edge. */
const menuScrollStyle: React.CSSProperties = {
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
  scrollbarWidth: "none",
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
  // The density's header height (styles/theme.css).
  height: "var(--chrome-header-h)",
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
