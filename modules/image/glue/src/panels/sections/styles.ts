// Shared panel styles (moved out of image-panel.tsx so sections can
// live in their own files without copying them).

import type { CSSProperties } from "react";
import { chrome, color, font, space } from "@paged-media/panel-kit";

export const row: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: space[2],
  padding: `${space[1]} 0`,
  borderBottom: `1px solid ${color.border}`,
};

export const kicker: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: font.trackingWide,
  fontSize: "11px",
  opacity: 0.7,
};

export const sectionTitle: CSSProperties = {
  ...kicker,
  marginTop: space[3],
  marginBottom: space[1],
};

export const mono: CSSProperties = {
  fontFamily: font.mono,
};

export const note: CSSProperties = {
  fontSize: "11px",
  opacity: 0.65,
  marginTop: space[2],
};

/** The panel's own heading: a plain title, not a kicker. */
export const panelTitle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  margin: `0 0 ${space[1]}`,
};

/** The commit bar: Apply, Reset and the status line stay in view while
 *  the sections below scroll. Bleeds over the panel padding so the
 *  sections do not show through at its edges. */
export const actionBar: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--pg-bg)",
  margin: `0 calc(-1 * ${space[2]})`,
  padding: space[2],
  borderBottom: `1px solid ${chrome.divider}`,
};

/** A small colour chip beside a colour select (the select itself keeps
 *  the theme's surface, so its text stays readable). */
export const swatch = (css: string): CSSProperties => ({
  display: "inline-block",
  width: 14,
  height: 14,
  flex: "none",
  borderRadius: 3,
  border: "1px solid var(--pg-border)",
  background: css,
});
