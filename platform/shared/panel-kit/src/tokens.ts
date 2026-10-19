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
// Before the kit, panels spelled their own: `--status-error` fell back to
// six different reds (and to `currentColor`), and four names had no token
// behind them at all (`--status-ok`, `--status-warn`, `--status-error-fg`,
// `--pg-danger`), so their hex fallback always rendered.

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
} as const;
