/*
 * This file is part of paged (https://paged.media).
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

// The colour, status and type tokens a panel paints with, each with ONE
// fallback. The editor defines every token (packages/shell's theme.css);
// the fallback shows only where a host does not: a test, another host.
// Each fallback is the light theme's value (theme.css `:root`), and the
// shell's test holds them equal, so a design refresh that moves a token
// moves its fallback too.
//
// Before the kit, panels spelled their own: an error colour seven ways
// (four reds and `currentColor` behind `--status-error`, and two more
// names), and twelve names had no token behind them at all (`--fg`,
// `--muted-fg`, `--pg-danger`, `--warn`, …), so their dark fallback
// rendered in both themes.

/** Surfaces and text. */
export const color = {
  /** The panel's background. */
  bg: "var(--pg-bg, #ffffff)",
  /** Text. */
  fg: "var(--pg-fg, #171717)",
  /** A quiet surface: a well, a chip, a code block. */
  muted: "var(--pg-muted, #f5f5f5)",
  /** Secondary text: notes, captions, an empty state. */
  mutedFg: "var(--pg-muted-fg, #737373)",
  /** Hairlines. */
  border: "var(--pg-border, #e3e3e3)",
  /** The primary action. */
  primary: "var(--pg-primary, hsl(263 73% 43%))",
  /** Text on the primary action. */
  primaryFg: "var(--pg-primary-fg, #fafafa)",
  /** The primary's tint: a selected row, an active chip. */
  primarySoft: "var(--pg-primary-soft, hsl(263 73% 96%))",
  /** A raised surface: a dialog, a popover. */
  elevated: "var(--elevated, #ffffff)",
} as const;

/** The editor chrome's neutrals, where a panel draws chrome. */
export const chrome = {
  /** A divider between sections. */
  divider: "var(--chrome-divider, #d4d4d8)",
  /** A chrome hairline. */
  border: "var(--chrome-border, #dddddd)",
  /** A header or tab-strip background. */
  panelBg: "var(--chrome-panel-bg, #fafafa)",
} as const;

/** The status signals: the outcome of an action, a finding, a state. */
export const status = {
  /** Done, valid, approved. */
  ok: "var(--status-approved, #3c6e4e)",
  /** Needs a look: a warning, a substitution, a review note. */
  warn: "var(--status-review, #9a6a1c)",
  /** Refused, failed, invalid, missing. */
  error: "var(--status-error, #c1121f)",
  /** Neutral information, technical detail. */
  info: "var(--status-info, #2c507d)",
} as const;

/** Which status signal a line shows. */
export type Tone = keyof typeof status;

/** Type. */
export const font = {
  sans: "var(--font-sans, sans-serif)",
  mono: "var(--font-mono, monospace)",
  /** The letter spacing of uppercase labels. */
  trackingWide: "var(--tracking-wide, 0.14em)",
} as const;

/** The spacing rhythm. */
export const space = {
  1: "var(--space-1, 4px)",
  2: "var(--space-2, 8px)",
  3: "var(--space-3, 12px)",
  4: "var(--space-4, 16px)",
} as const;

/** Corner radii. */
export const radius = {
  sm: "var(--radius-sm, 4px)",
  md: "var(--radius-md, 6px)",
  lg: "var(--radius-lg, 8px)",
  full: "var(--radius-full, 999px)",
} as const;
